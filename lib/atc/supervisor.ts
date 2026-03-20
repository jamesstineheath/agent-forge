import { loadJson, saveJson, deleteJson } from "../storage";
import { listWorkItems, getWorkItem } from "../work-items";
import { listRepos, getRepo } from "../repos";
import {
  listBranches,
  deleteBranch,
  getBranchLastCommitDate,
  getPRByBranch,
  getPRByNumber,
  getPRLifecycleState,
} from "../github";
import type { PR } from "../github";
import {
  getPendingEscalations,
  expireEscalation,
  resolveEscalation,
  updateEscalation,
  escalate,
  findActiveEscalation,
} from "../escalation";
import { getSpendStatus, checkSpendThresholds, persistSpendStatus } from "../vercel-spend-monitor";
import { summarizeDailyCacheMetrics } from "../cache-metrics";
import { reviewBacklog, assessProjectHealth, composeDigest, checkShouldRun as checkPMAgentShouldRun } from "../pm-agent";
import type { ATCEvent, HLOLifecycleState, WorkItem } from "../types";
import type { CycleContext } from "./types";
import {
  ATC_EVENTS_KEY,
  ATC_BRANCH_CLEANUP_KEY,
  SUPERVISOR_LAST_DRIFT_CHECK_KEY,
  MAX_EVENTS,
  CLEANUP_THROTTLE_MINUTES,
  STALE_BRANCH_HOURS,
  MAX_BRANCHES_PER_REPO,
} from "./types";
import { makeEvent } from "./utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, listRecentTraces } from "./tracing";
import type { AgentName } from "./tracing";

// --- Supervisor task throttling ---

const SUPERVISOR_TIMESTAMPS_KEY = 'supervisor-task-timestamps';

interface SupervisorTaskTimestamps {
  branchCleanup?: string;       // ISO timestamp string
  stalePrMonitoring?: string;   // ISO timestamp string
}

async function loadTaskTimestamps(): Promise<SupervisorTaskTimestamps> {
  try {
    const data = await loadJson<SupervisorTaskTimestamps>(SUPERVISOR_TIMESTAMPS_KEY);
    return data ?? {};
  } catch {
    return {};
  }
}

async function saveTaskTimestamps(timestamps: SupervisorTaskTimestamps): Promise<void> {
  await saveJson(SUPERVISOR_TIMESTAMPS_KEY, timestamps);
}

function isThrottled(lastRan: string | undefined, cooldownMinutes: number): boolean {
  if (!lastRan) return false;
  const elapsed = Date.now() - new Date(lastRan).getTime();
  return elapsed < cooldownMinutes * 60 * 1000;
}

/**
 * Supervisor agent: ensures every other agent is healthy and the system is learning.
 *
 * Responsibilities:
 * - §10: Escalation timeout monitoring
 * - §11: Gmail escalation reply polling
 * - §12: Escalation reminders
 * - §15: HLO lifecycle state polling
 * - Branch cleanup
 * - §9.5: Blob-index reconciliation
 * - §14: PM Agent daily sweep
 * - §16: Periodic full re-index
 * - Cache metrics summary
 * - NEW: Agent health monitoring
 */
export async function runSupervisor(ctx: CycleContext): Promise<void> {
  const { now, events } = ctx;
  const trace = startTrace('supervisor');
  ctx.trace = trace;
  let phaseStart = Date.now();
  const cycleStart = Date.now();
  const elapsed = () => Date.now() - cycleStart;
  // Leave 40s buffer for cleanup/trace persistence
  const PHASE_BUDGET_MS = 200_000;

  try {

  // §10: Escalation timeout monitoring
  try {
    const pending = await getPendingEscalations();
    const ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

    for (const esc of pending) {
      const createdTime = new Date(esc.createdAt).getTime();
      const age = now.getTime() - createdTime;

      if (age > ESCALATION_TIMEOUT_MS) {
        await expireEscalation(esc.id);
        const event = makeEvent(
          "escalation_timeout",
          esc.workItemId,
          "pending",
          "expired",
          `Escalation ${esc.id} timed out after 24h without resolution. Reason: ${esc.reason}`
        );
        events.push(event);
        console.log(`[supervisor] Escalation timeout: ${esc.id} for work item ${esc.workItemId}`);
      }
    }
  } catch (err) {
    console.error("[supervisor] Escalation monitoring failed:", err);
  }

  if (events.some(e => e.type === "escalation_timeout")) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...events.filter(e => e.type === "escalation_timeout")].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }

  // §11: Poll Gmail for escalation replies
  try {
    console.log('[supervisor] §11: Polling Gmail for escalation replies...');
    const pendingForGmail = await getPendingEscalations();
    const { checkForReply, parseReplyContent } = await import('../gmail');

    for (const esc of pendingForGmail) {
      if (!esc.threadId) continue;

      const replyMessage = await checkForReply(esc.threadId);
      if (replyMessage) {
        const replyContent = await parseReplyContent(replyMessage.id);
        console.log(`[supervisor] Found reply to escalation ${esc.id}:`, replyContent);

        const resolved = await resolveEscalation(esc.id, replyContent);
        if (resolved) {
          events.push(makeEvent(
            "escalation_resolved",
            esc.workItemId,
            "pending",
            "resolved",
            `Escalation ${esc.id} auto-resolved via Gmail reply: ${replyContent.slice(0, 100)}`
          ));
        }
      }
    }
  } catch (err) {
    console.error("[supervisor] Gmail reply polling failed:", err);
  }

  // §12: Send reminder emails for old escalations
  try {
    console.log('[supervisor] §12: Checking for escalation reminders...');
    const escalationsForReminder = await getPendingEscalations();
    const REMINDER_THRESHOLD = 24 * 60 * 60 * 1000;

    for (const esc of escalationsForReminder) {
      const ageMs = Date.now() - new Date(esc.createdAt).getTime();
      if (ageMs > REMINDER_THRESHOLD && !esc.reminderSentAt) {
        const workItem = await getWorkItem(esc.workItemId);
        if (workItem) {
          const { sendEscalationEmail } = await import('../gmail');
          const threadId = await sendEscalationEmail(esc, workItem, true);
          if (threadId) {
            await updateEscalation(esc.id, { reminderSentAt: new Date().toISOString() });
            events.push(makeEvent(
              "escalation_resolved",
              esc.workItemId,
              undefined,
              undefined,
              `Reminder email sent for escalation ${esc.id} (thread: ${threadId})`
            ));
          }
        }
      }
    }
  } catch (err) {
    console.error("[supervisor] Escalation reminder check failed:", err);
  }

  // Save events if Gmail sections produced any
  const gmailEventTypes = events.filter(e =>
    e.details.includes("auto-resolved via Gmail") || e.details.includes("Reminder email sent")
  );
  if (gmailEventTypes.length > 0) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...gmailEventTypes].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }

  addPhase(trace, { name: 'escalation_management', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // Load throttle timestamps at the start of the throttled section
  const timestamps = await loadTaskTimestamps();
  const updatedTimestamps: SupervisorTaskTimestamps = { ...timestamps };

  // §15: Poll HLO Lifecycle State from Open PRs — throttled to once per 30 minutes
  if (isThrottled(timestamps.stalePrMonitoring, 30)) {
    console.log('[Supervisor] Skipping stale PR monitoring: ran recently');
  } else {
    try {
      const reviewingForHLO = await listWorkItems({ status: "reviewing" });
      const reviewingWorkItems: WorkItem[] = [];
      for (const entry of reviewingForHLO) {
        const wi = await getWorkItem(entry.id);
        if (wi) reviewingWorkItems.push(wi);
      }
      const hloStateMap = await pollHLOStateFromOpenPRs(reviewingWorkItems);
      void hloStateMap;
    } catch (err) {
      console.error("[supervisor §15] HLO state polling failed:", err);
    }
    updatedTimestamps.stalePrMonitoring = new Date().toISOString();
    await saveTaskTimestamps(updatedTimestamps);
  }

  addPhase(trace, { name: 'hlo_polling', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // Branch cleanup — throttled to once per hour
  if (isThrottled(timestamps.branchCleanup, 60)) {
    console.log('[Supervisor] Skipping branch cleanup: ran recently');
  } else {
    try {
      const cleanupResult = await cleanupStaleBranches();
      if (cleanupResult && cleanupResult.deletedCount > 0) {
        const cleanupEvents = [makeEvent(
          "cleanup", "system", undefined, undefined,
          `Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}, errors ${cleanupResult.errors}`
        )];
        await import("./events").then(m => m.persistEvents(cleanupEvents));
      }
    } catch (err) {
      console.error("[supervisor] Branch cleanup failed:", err);
    }
    updatedTimestamps.branchCleanup = new Date().toISOString();
    await saveTaskTimestamps(updatedTimestamps);
  }

  addPhase(trace, { name: 'branch_cleanup', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §9.5: Work item blob-index reconciliation (hourly)
  const RECONCILIATION_KEY = "atc/last-reconciliation";
  try {
    const reconLast = await loadJson<{ lastRunAt: string }>(RECONCILIATION_KEY);
    const reconElapsed = reconLast
      ? (now.getTime() - new Date(reconLast.lastRunAt).getTime()) / 60_000
      : Infinity;

    if (reconElapsed >= 60) {
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        const { list } = await import("@vercel/blob");
        const { blobs } = await list({ prefix: "af-data/work-items/", mode: "folded" });
        const blobIds = new Set(
          blobs
            .map(b => b.pathname.replace("af-data/work-items/", "").replace(".json", ""))
            .filter(id => id && id !== "index")
        );

        const indexEntries = await listWorkItems({});
        const indexIds = new Set(indexEntries.map(e => e.id));

        if (indexEntries.length === 0 && blobs.length > 0) {
          console.warn(`[supervisor] Reconciliation safety: index is empty but ${blobs.length} blob(s) exist. Skipping to prevent data loss.`);
          await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
        } else {
          const danglingIds = [...blobIds].filter(id => id && !indexIds.has(id));
          if (danglingIds.length > 0 && danglingIds.length > blobIds.size * 0.5) {
            console.error(`[supervisor] Reconciliation safety: ${danglingIds.length}/${blobIds.size} blobs flagged as dangling (>50%). Refusing to delete. Likely index corruption.`);
          } else if (danglingIds.length > 0) {
            for (const id of danglingIds) {
              await deleteJson(`work-items/${id}`);
            }
            const reconEvents = [makeEvent(
              "cleanup", "system", undefined, undefined,
              `Blob reconciliation: deleted ${danglingIds.length} dangling work-item blob(s)`
            )];
            await import("./events").then(m => m.persistEvents(reconEvents));
          }

          const staleIndexEntries = indexEntries.filter(e => !blobIds.has(e.id));
          if (staleIndexEntries.length > 0 && staleIndexEntries.length < indexEntries.length) {
            const cleanedIndex = indexEntries.filter(e => blobIds.has(e.id));
            await saveJson("work-items/index", cleanedIndex);
            const reconEvents = [makeEvent(
              "cleanup", "system", undefined, undefined,
              `Index reconciliation: removed ${staleIndexEntries.length} stale index entries`
            )];
            await import("./events").then(m => m.persistEvents(reconEvents));
          } else if (staleIndexEntries.length === indexEntries.length && indexEntries.length > 0) {
            console.error(`[supervisor] Reconciliation safety: ALL ${indexEntries.length} index entries are stale. Refusing to wipe index.`);
          }
        }
      }

      await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
    }
  } catch (err) {
    console.error("[supervisor] Blob-index reconciliation failed:", err);
  }

  addPhase(trace, { name: 'blob_reconciliation', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // Cache metrics summary (observability)
  await summarizeDailyCacheMetrics().catch((err) =>
    console.error("[supervisor] cache metrics summary failed:", err)
  );

  // §14 — PM Agent Daily Sweep
  if (elapsed() > PHASE_BUDGET_MS) {
    console.warn(`[supervisor] Skipping §14+ — ${elapsed()}ms elapsed, over budget`);
    addDecision(trace, { action: 'phases_skipped', reason: `Time budget exceeded at ${elapsed()}ms — skipping §14+` });
    completeTrace(trace, 'success');
    return;
  }
  try {
    await runPMAgentSweep();
  } catch (error) {
    console.error('[supervisor §14] Unexpected error in PM Agent sweep:', error);
  }

  // §16: Periodic Full Re-Index (stale repos >7 days)
  if (elapsed() > PHASE_BUDGET_MS) {
    console.warn(`[supervisor] Skipping §16+ — ${elapsed()}ms elapsed, over budget`);
    addDecision(trace, { action: 'phases_skipped', reason: `Time budget exceeded at ${elapsed()}ms — skipping §16+` });
    completeTrace(trace, 'success');
    return;
  }
  try {
    const { loadRepoSnapshot } = await import("../knowledge-graph/storage");
    const { fullIndex } = await import("../knowledge-graph/indexer");
    const allRepos = await listRepos();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    let fullIndexCount = 0;

    for (const repoEntry of allRepos) {
      if (fullIndexCount >= 1) {
        console.log(`[supervisor §16] Full re-index cap reached (1/cycle), skipping remaining repos`);
        break;
      }

      const repo = await getRepo(repoEntry.id);
      if (!repo) continue;

      const snapshot = await loadRepoSnapshot(repo.fullName);
      const isStale = !snapshot || !snapshot.indexedAt ||
        (now.getTime() - new Date(snapshot.indexedAt).getTime()) > SEVEN_DAYS_MS;

      if (isStale) {
        const lastIndexed = snapshot?.indexedAt
          ? new Date(snapshot.indexedAt).toISOString()
          : 'never';
        console.log(
          `[supervisor §16] ${repo.fullName} snapshot stale (lastIndexed: ${lastIndexed}), triggering full re-index`
        );
        try {
          const result = await fullIndex(repo.fullName);
          console.log(
            `[supervisor §16] Full re-index complete for ${repo.fullName} (${result.entityCount} entities)`
          );
        } catch (err) {
          console.warn(
            `[supervisor §16] Full re-index failed for ${repo.fullName}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
        fullIndexCount++;
      } else {
        console.log(`[supervisor §16] ${repo.fullName} snapshot is fresh, skipping`);
      }
    }
  } catch (err) {
    console.error("[supervisor §16] Periodic re-index check failed:", err);
  }

  addPhase(trace, { name: 'pm_sweep_and_reindex', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // Agent trace health check — read peer agent traces and detect elevated error rates
  try {
    const peerAgents: AgentName[] = ['dispatcher', 'health-monitor', 'project-manager'];
    for (const agentName of peerAgents) {
      const recentTraces = await listRecentTraces(agentName, 5);
      const errorCount = recentTraces.filter(t => t.status === 'error').length;
      if (recentTraces.length >= 3 && errorCount / recentTraces.length > 0.5) {
        addDecision(trace, {
          action: 'agent_health_warning',
          reason: `Agent ${agentName} has ${errorCount}/${recentTraces.length} error rate in recent runs`,
        });
        console.warn(`[Supervisor] Agent ${agentName} elevated error rate: ${errorCount}/${recentTraces.length}`);
      }
    }
  } catch (err) {
    console.error("[supervisor] Agent trace health check failed:", err);
  }

  addPhase(trace, { name: 'agent_trace_health_check', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // NEW: Agent health monitoring — check last-run timestamps for all agents
  try {
    const { getAgentLastRun } = await import("./utils");
    const agentNames = ["dispatcher", "health-monitor", "project-manager", "supervisor"];
    const STALE_AGENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    for (const agent of agentNames) {
      const lastRun = await getAgentLastRun(agent);
      if (!lastRun) {
        console.log(`[supervisor] Agent "${agent}" has never recorded a run`);
        continue;
      }

      const age = now.getTime() - new Date(lastRun).getTime();
      if (age > STALE_AGENT_THRESHOLD_MS) {
        console.warn(
          `[supervisor] Agent "${agent}" is stale — last run ${Math.round(age / 60_000)} minutes ago`
        );
        events.push(makeEvent(
          "error", "system", undefined, undefined,
          `Agent "${agent}" stale: last run ${Math.round(age / 60_000)}m ago (threshold: ${STALE_AGENT_THRESHOLD_MS / 60_000}m)`
        ));
      }
    }
  } catch (err) {
    console.error("[supervisor] Agent health monitoring failed:", err);
  }

  addPhase(trace, { name: 'agent_staleness_check', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §18 — Drift Detection (at most once per 24h)
  if (elapsed() > PHASE_BUDGET_MS) {
    console.warn(`[supervisor] Skipping §18+ — ${elapsed()}ms elapsed, over budget`);
    addDecision(trace, { action: 'phases_skipped', reason: `Time budget exceeded at ${elapsed()}ms — skipping §18+` });
    completeTrace(trace, 'success');
    return;
  }
  try {
    await runDriftDetectionPhase(ctx);
  } catch (err) {
    console.warn('[supervisor §18] Drift detection phase failed (non-fatal):', err);
  }

  addPhase(trace, { name: 'drift_detection', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §19 — Import approved criteria from Notion
  try {
    const { importAllApprovedCriteria } = await import("@/lib/intent-criteria");
    const result = await importAllApprovedCriteria();
    if (result.imported > 0) {
      console.log(`[supervisor §19] Imported ${result.imported} criteria set(s) from Notion (${result.skipped} skipped)`);
      addDecision(trace, { action: 'criteria_import', reason: `Imported ${result.imported} approved PRD criteria from Notion` });
    }
  } catch (err) {
    console.warn('[supervisor §19] Criteria import phase failed (non-fatal):', err);
  }

  addPhase(trace, { name: 'criteria_import', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §21 — Architecture Planning (auto-generate plans for approved criteria without plans)
  if (elapsed() > PHASE_BUDGET_MS) {
    console.warn(`[supervisor] Skipping §21+ — ${elapsed()}ms elapsed, over ${PHASE_BUDGET_MS}ms budget`);
    addDecision(trace, { action: 'phases_skipped', reason: `Time budget exceeded at ${elapsed()}ms — skipping §21, §22, §5, §20` });
    completeTrace(trace, 'success');
    return;
  }
  try {
    const { getArchitecturePlan, generateArchitecturePlan } = await import("@/lib/architecture-planner");
    const { listAllCriteria } = await import("@/lib/intent-criteria");
    const { MIN_REPO_CONTEXT_LENGTH } = await import("./types");
    const criteriaEntries = await listAllCriteria();

    for (const entry of criteriaEntries) {
      // Skip criteria that already have an architecture plan
      const existingPlan = await getArchitecturePlan(entry.prdId);
      if (existingPlan) continue;

      // Skip criteria with no criteria to plan
      if (entry.criteriaCount === 0) continue;

      const { getCriteria } = await import("@/lib/intent-criteria");
      const criteria = await getCriteria(entry.prdId);
      if (!criteria) continue;

      console.log(`[supervisor §21] Generating architecture plan for "${criteria.prdTitle}"`);
      try {
        const plan = await generateArchitecturePlan({
          criteria,
          mode: "plan",
          // Empty context guard: generateArchitecturePlan will skip if repo context
          // is below MIN_REPO_CONTEXT_LENGTH. We handle the guard at the plan level:
          // if the plan comes back with 0 criterion plans, treat as empty context failure.
          minRepoContextLength: MIN_REPO_CONTEXT_LENGTH,
        });

        if (!plan || plan.criterionPlans.length === 0) {
          // Empty context or failed plan — escalate instead of proceeding
          console.warn(`[supervisor §21] Architecture plan for "${criteria.prdTitle}" produced 0 criterion plans — skipping`);
          addDecision(trace, {
            action: 'architecture_planner_empty_context',
            reason: `Architecture plan for "${criteria.prdTitle}" produced 0 criterion plans — likely empty repo context`,
          });
          const { persistEvents } = await import("./events");
          await persistEvents([makeEvent(
            'error', 'system', undefined, undefined,
            `Architecture planner produced empty plan for "${criteria.prdTitle}" (PRD ${entry.prdId}) — likely empty repo context`
          )]);
          await escalate(
            'system',
            `Architecture planner produced empty plan for "${criteria.prdTitle}" (PRD ${entry.prdId}). Repo context fetch may have failed. Plan generation skipped.`,
            0.5,
            { prdId: entry.prdId, prdTitle: criteria.prdTitle, targetRepo: criteria.targetRepo },
            entry.projectId
          );
          continue;
        }

        addDecision(trace, {
          action: 'architecture_plan_generated',
          reason: `Generated architecture plan for "${criteria.prdTitle}" — ${plan.criterionPlans.length} criterion plans, est. $${plan.totalEstimatedCost}`,
        });
        console.log(
          `[supervisor §21] Architecture plan generated for "${criteria.prdTitle}" — v${plan.version}, ${plan.estimatedWorkItems} est. work items`
        );
        // Only generate 1 plan per cycle to avoid timeout
        break;
      } catch (planErr) {
        console.warn(`[supervisor §21] Architecture plan generation failed for "${criteria.prdTitle}":`, planErr);
      }
    }
  } catch (err) {
    console.warn('[supervisor §21] Architecture planning phase failed (non-fatal):', err);
  }

  addPhase(trace, { name: 'architecture_planning', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §22 — Trigger decomposition for architecture plans that are ready
  if (elapsed() > PHASE_BUDGET_MS) {
    console.warn(`[supervisor] Skipping §22+ — ${elapsed()}ms elapsed, over ${PHASE_BUDGET_MS}ms budget`);
    addDecision(trace, { action: 'phases_skipped', reason: `Time budget exceeded at ${elapsed()}ms — skipping §22, §5, §20` });
    completeTrace(trace, 'success');
    return;
  }
  try {
    const { getArchitecturePlan, planToDecomposerMarkdown } = await import("@/lib/architecture-planner");
    const { listAllCriteria, getCriteria } = await import("@/lib/intent-criteria");
    const { decomposeFromPlan } = await import("@/lib/decomposer");
    const criteriaEntries = await listAllCriteria();
    // Pre-fetch work items once for dedup guard validation (avoid N+1 queries)
    const allItemsForDedup = await listWorkItems({});

    for (const entry of criteriaEntries) {
      const plan = await getArchitecturePlan(entry.prdId);
      if (!plan) continue;

      // Check if a project already exists for this PRD (dedup guard)
      const dedupKey = `atc/project-decomposed/prd-${entry.prdId}`;
      const alreadyDecomposed = await loadJson<{ decomposedAt: string; workItemCount?: number }>(dedupKey);
      if (alreadyDecomposed) {
        // Self-heal: clear guards that were set without workItemCount (pre-fix bug)
        // Old guards lack workItemCount — verify work items actually exist before honoring
        if (alreadyDecomposed.workItemCount === undefined) {
          const projectId = entry.projectId;
          if (projectId) {
            const hasItems = allItemsForDedup.some(
              (wi) => (wi as WorkItem).source?.sourceId === projectId &&
                      (wi as WorkItem).status !== 'cancelled'
            );
            if (!hasItems) {
              await deleteJson(dedupKey);
              addDecision(trace, {
                action: 'dedup_guard_cleared',
                reason: `Cleared stale dedup guard for "${entry.prdTitle}" (${projectId}) — no active work items found`,
              });
              // Fall through to attempt decomposition
            } else {
              continue; // Has real work items, guard is valid
            }
          } else {
            await deleteJson(dedupKey);
            addDecision(trace, {
              action: 'dedup_guard_cleared',
              reason: `Cleared unverifiable dedup guard for "${entry.prdTitle}" — no projectId to verify`,
            });
            // Fall through to attempt decomposition
          }
        } else {
          continue; // Guard was set by fixed code (has workItemCount), skip
        }
      }

      const criteria = await getCriteria(entry.prdId);
      if (!criteria) continue;

      console.log(`[supervisor §22] Triggering decomposition for "${criteria.prdTitle}" from architecture plan v${plan.version}`);
      try {
        const markdown = planToDecomposerMarkdown(plan, criteria.prdTitle);

        const result = await decomposeFromPlan({
          prdId: entry.prdId,
          prdTitle: criteria.prdTitle,
          targetRepo: plan.targetRepo,
          planContent: markdown,
          projectId: criteria.projectId,
        });

        if (!result.workItems || result.workItems.length === 0) {
          // Decomposition returned 0 work items — this is a silent failure.
          // Emit event, create escalation, do NOT transition project to Executing.
          const failureReason = result.reason ?? 'unknown';
          addDecision(trace, {
            action: 'decomposition_empty',
            reason: `Decomposition of "${criteria.prdTitle}" produced 0 work items (reason: ${failureReason}) — escalating`,
          });
          console.warn(`[supervisor §22] Decomposition of "${criteria.prdTitle}" produced 0 work items (reason: ${failureReason})`);

          // Emit event to Event Bus
          const { persistEvents } = await import("./events");
          await persistEvents([makeEvent(
            'error', 'system', undefined, undefined,
            `Decomposer returned 0 items for "${criteria.prdTitle}" (PRD ${entry.prdId}). Reason: ${failureReason}. Project NOT advanced to Executing.`
          )]);

          // Create escalation requiring human attention
          await escalate(
            'system',
            `Decomposition of "${criteria.prdTitle}" (PRD ${entry.prdId}) produced 0 work items. Reason: ${failureReason}. The PRD may need manual review.`,
            0.3,
            {
              prdId: entry.prdId,
              prdTitle: criteria.prdTitle,
              targetRepo: plan.targetRepo,
              failureReason,
              planVersion: plan.version,
            },
            entry.projectId
          );
          continue;
        }

        // Only set dedup guard when work items were actually created
        await saveJson(dedupKey, { decomposedAt: new Date().toISOString(), planVersion: plan.version, workItemCount: result.workItems.length });

        addDecision(trace, {
          action: 'decomposition_triggered',
          reason: `Decomposed "${criteria.prdTitle}" from architecture plan v${plan.version} — ${result.workItems.length} work items created`,
        });
        console.log(`[supervisor §22] Decomposition complete for "${criteria.prdTitle}" — ${result.workItems.length} work items created`);
        // Only decompose 1 per cycle
        break;
      } catch (decompErr) {
        console.warn(`[supervisor §22] Decomposition failed for "${criteria.prdTitle}":`, decompErr);
      }
    }
  } catch (err) {
    console.warn('[supervisor §22] Decomposition trigger phase failed (non-fatal):', err);
  }

  addPhase(trace, { name: 'decomposition_trigger', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §5 — Spend Monitoring
  try {
    console.log('[supervisor §5] Spend Monitoring: start');
    const spendStatus = await getSpendStatus();
    const newlyCrossed = checkSpendThresholds(spendStatus);

    if (newlyCrossed.length === 0) {
      console.log('[supervisor §5] Spend Monitoring: no new thresholds crossed');
    } else {
      console.log(`[supervisor §5] Spend Monitoring: ${newlyCrossed.length} new threshold(s) crossed`);

      for (const threshold of newlyCrossed) {
        await escalate(
          'system',
          `Vercel spend threshold crossed: ${threshold}% — $${spendStatus.currentSpend.toFixed(2)} of $${spendStatus.budget.toFixed(2)} budget`,
          0.9,
          {
            threshold,
            currentSpend: spendStatus.currentSpend,
            budget: spendStatus.budget,
            percentUsed: spendStatus.percentUsed,
          }
        );

        const { sendEmail } = await import('../gmail');
        await sendEmail({
          subject: `[Agent Forge] Vercel Spend Alert: ${threshold}% threshold crossed`,
          body: `A Vercel spend threshold has been crossed.\n\nThreshold: ${threshold}%\nCurrent spend: $${spendStatus.currentSpend.toFixed(2)}\nBudget: $${spendStatus.budget.toFixed(2)}\nPercent used: ${spendStatus.percentUsed.toFixed(1)}%\n\nPlease review your Vercel usage.`,
        });

        spendStatus.alertsSent.push(String(threshold));
      }

      await persistSpendStatus(spendStatus);
    }

    console.log('[supervisor §5] Spend Monitoring: complete');
  } catch (err) {
    console.error(`[supervisor §5] Spend Monitoring error: ${err instanceof Error ? err.message : String(err)}`);
  }

  addPhase(trace, { name: 'spend_monitoring', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // §20 — Intent Validation (post-project-completion)
  try {
    const { runIntentValidation } = await import("@/lib/intent-validator");
    const result = await runIntentValidation();
    if (result.validated > 0) {
      console.log(
        `[supervisor §20] Intent validation: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.followUps} follow-ups`
      );
      addDecision(trace, {
        action: 'intent_validation',
        reason: `Validated ${result.validated} criteria: ${result.passed} passed, ${result.failed} failed, ${result.followUps} follow-ups filed`,
      });
    }
  } catch (err) {
    console.warn('[supervisor §20] Intent validation phase failed (non-fatal):', err);
  }

  addPhase(trace, { name: 'intent_validation', durationMs: Date.now() - phaseStart });

  completeTrace(trace, 'success');

  } catch (err) {
    addError(trace, String(err));
    completeTrace(trace, 'error');
    throw err;
  }
  // Trace persistence moved to cron route (survives withTimeout cutoff)
}

// === Private helpers ===

async function pollHLOStateFromOpenPRs(
  workItems: WorkItem[]
): Promise<Map<number, { workItem: WorkItem; hloState: HLOLifecycleState | null; prInfo: PR | null }>> {
  const reviewingItems = workItems.filter(
    (wi) => wi.status === 'reviewing' && wi.execution?.prNumber != null
  );

  const resultMap = new Map<number, { workItem: WorkItem; hloState: HLOLifecycleState | null; prInfo: PR | null }>();

  await Promise.all(
    reviewingItems.map(async (wi) => {
      const prNumber = wi.execution!.prNumber!;
      const targetRepo = wi.targetRepo;
      const [owner, repo] = targetRepo.split('/');

      if (!owner || !repo) {
        console.warn(`[supervisor §15] Work item ${wi.id} missing owner/repo, skipping`);
        return;
      }

      let hloState: HLOLifecycleState | null = null;
      let prInfo: PR | null = null;

      try {
        hloState = await getPRLifecycleState(owner, repo, prNumber);
      } catch (err) {
        console.warn(`[supervisor §15] Failed to get HLO state for PR #${prNumber}:`, err);
      }

      try {
        prInfo = await getPRByNumber(targetRepo, prNumber);
      } catch (err) {
        console.warn(`[supervisor §15] Failed to get PR info for PR #${prNumber}:`, err);
      }

      resultMap.set(prNumber, { workItem: wi, hloState, prInfo });
    })
  );

  const withLifecycle = [...resultMap.values()].filter((e) => e.hloState !== null).length;
  const withoutLifecycle = resultMap.size - withLifecycle;

  console.log(
    `[supervisor §15] Polled HLO state for ${resultMap.size} PRs (${withLifecycle} with lifecycle data, ${withoutLifecycle} without)`
  );

  return resultMap;
}

export async function cleanupStaleBranches(): Promise<{ deletedCount: number; skipped: number; errors: number }> {
  const now = new Date();

  const lastRun = await loadJson<{ lastRunAt: string }>(ATC_BRANCH_CLEANUP_KEY);
  if (lastRun) {
    const elapsed = (now.getTime() - new Date(lastRun.lastRunAt).getTime()) / 60_000;
    if (elapsed < CLEANUP_THROTTLE_MINUTES) {
      return { deletedCount: 0, skipped: 0, errors: 0 };
    }
  }

  let deletedCount = 0;
  let skipped = 0;
  let errors = 0;

  // Phase A: Clean branches for work items in terminal/failed states
  // Safety: check both work item prNumber AND live GitHub PR state before deleting.
  // This prevents the race where prNumber hasn't been written to the blob yet but a PR exists.
  const CLEANUP_ELIGIBLE_STATUSES = ["failed", "parked", "cancelled"] as const;
  for (const status of CLEANUP_ELIGIBLE_STATUSES) {
    const entries = await listWorkItems({ status });
    for (const entry of entries) {
      const item = await getWorkItem(entry.id);
      if (!item || !item.handoff?.branch) continue;

      // Skip if work item records a PR
      if (item.execution?.prNumber != null) {
        skipped++;
        continue;
      }

      // Belt-and-suspenders: also check GitHub for an open PR on this branch.
      // Covers the race where execution created a PR but prNumber wasn't persisted yet.
      try {
        const livePR = await getPRByBranch(item.targetRepo, item.handoff.branch);
        if (livePR && livePR.state === "open") {
          console.log(`[supervisor] Skipping branch cleanup for ${item.handoff.branch}: open PR #${livePR.number} found (work item ${item.id} has no prNumber recorded)`);
          skipped++;
          continue;
        }
      } catch {
        // If PR check fails, err on the side of NOT deleting
        skipped++;
        continue;
      }

      try {
        const deleted = await deleteBranch(item.targetRepo, item.handoff.branch);
        if (deleted) {
          deletedCount++;
          console.log(`[supervisor] Deleted branch for ${status} work item ${item.id}: ${item.handoff.branch} from ${item.targetRepo}`);
        }
      } catch {
        errors++;
      }
    }
  }

  // Phase B: Time-based stale branch cleanup
  const repoIndex = await listRepos();
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;

    let branches: string[];
    try {
      branches = await listBranches(repo.fullName);
    } catch {
      errors++;
      continue;
    }

    if (branches.length > MAX_BRANCHES_PER_REPO) {
      console.log(`[supervisor] ${repo.fullName} has ${branches.length} branches, capping at ${MAX_BRANCHES_PER_REPO}. Remaining will be processed next cycle.`);
      branches = branches.slice(0, MAX_BRANCHES_PER_REPO);
    }

    for (const branch of branches) {
      try {
        const pr = await getPRByBranch(repo.fullName, branch);
        if (pr && pr.state === "open") {
          skipped++;
          continue;
        }

        const lastCommitDate = await getBranchLastCommitDate(repo.fullName, branch);
        if (!lastCommitDate) {
          skipped++;
          continue;
        }

        const ageHours = (now.getTime() - new Date(lastCommitDate).getTime()) / 3_600_000;
        if (ageHours < STALE_BRANCH_HOURS) {
          skipped++;
          continue;
        }

        const deleted = await deleteBranch(repo.fullName, branch);
        if (deleted) {
          deletedCount++;
          console.log(`[supervisor] Deleted stale branch: ${branch} from ${repo.fullName} (last commit: ${lastCommitDate})`);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  }

  await saveJson(ATC_BRANCH_CLEANUP_KEY, { lastRunAt: now.toISOString() });

  return { deletedCount, skipped, errors };
}

// §18 — Drift Detection (at most once per 24h)
async function runDriftDetectionPhase(ctx: CycleContext): Promise<void> {
  const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const lastCheck = await loadJson<{ lastRunAt: string }>(SUPERVISOR_LAST_DRIFT_CHECK_KEY);
  if (lastCheck) {
    const elapsed = ctx.now.getTime() - new Date(lastCheck.lastRunAt).getTime();
    if (elapsed < DRIFT_CHECK_INTERVAL_MS) {
      console.log(`[supervisor §18] Drift check skipped — last ran ${Math.round(elapsed / 3600000)}h ago`);
      return;
    }
  }

  console.log('[supervisor §18] Running drift detection...');

  const { detectDrift, saveDriftSnapshot, formatDriftAlert } = await import('../drift-detection');

  // Load all work items
  const indexEntries = await listWorkItems({});
  const allItems: WorkItem[] = [];
  for (const entry of indexEntries) {
    const wi = await getWorkItem(entry.id);
    if (wi) allItems.push(wi);
  }

  const snapshot = detectDrift({
    workItems: allItems,
    baselinePeriodDays: 30,
    currentPeriodDays: 7,
  });

  // Persist snapshot
  try {
    await saveDriftSnapshot(snapshot);
  } catch (snapErr) {
    console.warn('[supervisor §18] Failed to save drift snapshot:', snapErr);
  }

  if (snapshot.degraded) {
    console.warn(`[supervisor §18] Drift DETECTED — JSD=${snapshot.driftScore.toFixed(4)} (threshold=${snapshot.threshold})`);
    ctx.events.push(makeEvent(
      'error', 'system', undefined, undefined,
      `Drift detected: JSD=${snapshot.driftScore.toFixed(4)} exceeds threshold ${snapshot.threshold}`
    ));
    try {
      const { sendEmail } = await import('../gmail');
      await sendEmail({
        subject: `[Agent Forge] Drift Alert — JSD=${snapshot.driftScore.toFixed(4)}`,
        body: formatDriftAlert(snapshot),
      });
    } catch (emailErr) {
      console.warn('[supervisor §18] Failed to send drift alert email:', emailErr);
    }
  } else {
    console.log(`[supervisor §18] No drift detected — JSD=${snapshot.driftScore.toFixed(4)}`);
  }

  await saveJson(SUPERVISOR_LAST_DRIFT_CHECK_KEY, { lastRunAt: ctx.now.toISOString() });
}

// §14 — PM Agent Daily Sweep
async function runPMAgentSweep() {
  const SWEEP_KEY = 'pm-agent/last-sweep';
  const lastSweep = await loadJson<{ timestamp: string }>(SWEEP_KEY);

  if (lastSweep) {
    const lastRun = new Date(lastSweep.timestamp);
    const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastRun < 20) {
      console.log(`[supervisor §14] PM Agent sweep: skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago)`);
      return;
    }
  }

  // Early-exit: skip LLM calls if there's nothing to act on
  const shouldRun = await checkPMAgentShouldRun();
  if (!shouldRun.shouldRun) {
    console.log(`[PM Agent] Early exit: ${shouldRun.reason}`);
    return;
  }

  console.log('[supervisor §14] PM Agent sweep: starting');

  try {
    const review = await reviewBacklog();
    console.log(`[supervisor §14] Backlog review complete: ${review.recommendations.length} recommendations`);

    const healths = await assessProjectHealth();
    const atRisk = healths.filter(h => h.status === 'at-risk' || h.status === 'stalling' || h.status === 'blocked');
    console.log(`[supervisor §14] Health assessment: ${healths.length} projects, ${atRisk.length} at risk`);

    await composeDigest({
      includeHealth: true,
      includeBacklog: true,
      includeRecommendations: true,
      recipientEmail: 'james.stine.heath@gmail.com',
    });
    console.log('[supervisor §14] Digest sent');

    await saveJson(SWEEP_KEY, { timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[supervisor §14] PM Agent sweep failed:', error);
  }
}
