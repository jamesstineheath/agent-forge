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
import { listRecentTraces } from "./tracing";
import type { AgentName } from "./tracing";

// --- Supervisor task throttling ---

const SUPERVISOR_TIMESTAMPS_KEY = 'supervisor-task-timestamps';

interface SupervisorTaskTimestamps {
  branchCleanup?: string;
  stalePrMonitoring?: string;
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
 * Phase result returned by each exported phase function.
 */
export interface SupervisorPhaseOutput {
  decisions: string[];
  errors: string[];
  events: ATCEvent[];
  outputs?: Record<string, unknown>;
}

function emptyOutput(): SupervisorPhaseOutput {
  return { decisions: [], errors: [], events: [] };
}

// ============================================================================
// Exported phase functions — each called by its own API route
// ============================================================================

/**
 * §10-12: Escalation timeout monitoring, Gmail reply polling, reminder emails.
 */
export async function runEscalationManagement(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();
  const now = new Date();

  // §10: Escalation timeout monitoring
  try {
    const pending = await getPendingEscalations();
    const ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

    for (const esc of pending) {
      const createdTime = new Date(esc.createdAt).getTime();
      const age = now.getTime() - createdTime;

      if (age > ESCALATION_TIMEOUT_MS) {
        await expireEscalation(esc.id);
        out.events.push(makeEvent(
          "escalation_timeout",
          esc.workItemId,
          "pending",
          "expired",
          `Escalation ${esc.id} timed out after 24h without resolution. Reason: ${esc.reason}`
        ));
        console.log(`[supervisor] Escalation timeout: ${esc.id} for work item ${esc.workItemId}`);
      }
    }
  } catch (err) {
    console.error("[supervisor] Escalation monitoring failed:", err);
    out.errors.push(`Escalation monitoring: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (out.events.some(e => e.type === "escalation_timeout")) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...out.events.filter(e => e.type === "escalation_timeout")].slice(-MAX_EVENTS);
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
          out.events.push(makeEvent(
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
    out.errors.push(`Gmail polling: ${err instanceof Error ? err.message : String(err)}`);
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
            out.events.push(makeEvent(
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
    out.errors.push(`Escalation reminders: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Persist Gmail-related events
  const gmailEventTypes = out.events.filter(e =>
    e.details.includes("auto-resolved via Gmail") || e.details.includes("Reminder email sent")
  );
  if (gmailEventTypes.length > 0) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...gmailEventTypes].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }

  return out;
}

/**
 * §19: Import approved criteria from Notion.
 */
export async function runCriteriaImport(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    const { importAllApprovedCriteria } = await import("@/lib/intent-criteria");
    const result = await importAllApprovedCriteria();
    if (result.imported > 0) {
      console.log(`[supervisor §19] Imported ${result.imported} criteria set(s) from Notion (${result.skipped} skipped)`);
      out.decisions.push(`Imported ${result.imported} approved PRD criteria from Notion`);
    }
  } catch (err) {
    console.warn('[supervisor §19] Criteria import phase failed (non-fatal):', err);
    out.errors.push(`Criteria import: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stale criteria cleanup: remove criteria/plans for PRDs in terminal statuses
  try {
    const { listAllCriteria, fetchPRDStatus, deleteCriteria } = await import("@/lib/intent-criteria");
    const criteriaEntries = await listAllCriteria();
    const TERMINAL_STATUSES = new Set(["Complete", "Obsolete"]);
    let cleaned = 0;
    const evaluated: Array<{ prdId: string; title: string; status: string | null; action: string }> = [];

    for (const entry of criteriaEntries) {
      if (cleaned >= 3) {
        evaluated.push({ prdId: entry.prdId, title: entry.prdTitle, status: null, action: 'skipped (max 3 per cycle)' });
        continue;
      }

      const status = await fetchPRDStatus(entry.prdId);
      if (!status || !TERMINAL_STATUSES.has(status)) {
        evaluated.push({ prdId: entry.prdId, title: entry.prdTitle, status: status ?? 'unknown', action: 'retained' });
        continue;
      }

      // PRD is in a terminal status — clean up
      console.log(`[supervisor §19] Cleaned up stale criteria for PRD "${entry.prdTitle}" (status: ${status}, prdId: ${entry.prdId})`);

      await deleteCriteria(entry.prdId);
      await deleteJson(`architecture-plans/${entry.prdId}-latest`);
      await deleteJson(`atc/project-decomposed/prd-${entry.prdId}`);

      evaluated.push({ prdId: entry.prdId, title: entry.prdTitle, status, action: 'cleaned' });
      out.decisions.push(`Cleaned up criteria/plan for ${status} PRD "${entry.prdTitle}" (status: ${status})`);
      cleaned++;
    }

    if (evaluated.length > 0) {
      const summary = evaluated.map(e => `${e.title} (${e.status}): ${e.action}`).join(', ');
      console.log(`[supervisor §19] Criteria cleanup evaluated ${evaluated.length} PRDs: ${summary}`);
      out.decisions.push(`Criteria cleanup evaluated ${evaluated.length} PRD(s): ${cleaned} cleaned, ${evaluated.length - cleaned} retained`);
    }
  } catch (err) {
    console.warn('[supervisor §19] Stale criteria cleanup failed (non-fatal):', err);
    out.errors.push(`Stale criteria cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * §21: Auto-generate architecture plans for approved criteria without plans.
 */
export async function runArchitecturePlanning(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    const { getArchitecturePlan, generateArchitecturePlan } = await import("@/lib/architecture-planner");
    const { listAllCriteria } = await import("@/lib/intent-criteria");
    const { MIN_REPO_CONTEXT_LENGTH } = await import("./types");
    const criteriaEntries = await listAllCriteria();

    for (const entry of criteriaEntries) {
      const existingPlan = await getArchitecturePlan(entry.prdId);
      if (existingPlan) continue;
      if (entry.criteriaCount === 0) continue;

      const { getCriteria } = await import("@/lib/intent-criteria");
      const criteria = await getCriteria(entry.prdId);
      if (!criteria) continue;

      console.log(`[supervisor §21] Generating architecture plan for "${criteria.prdTitle}"`);
      try {
        const plan = await generateArchitecturePlan({
          criteria,
          mode: "plan",
          minRepoContextLength: MIN_REPO_CONTEXT_LENGTH,
        });

        if (!plan || plan.criterionPlans.length === 0) {
          console.warn(`[supervisor §21] Architecture plan for "${criteria.prdTitle}" produced 0 criterion plans — skipping`);
          out.decisions.push(`Architecture plan for "${criteria.prdTitle}" produced 0 criterion plans — likely empty repo context`);
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

        out.decisions.push(
          `Generated architecture plan for "${criteria.prdTitle}" — ${plan.criterionPlans.length} criterion plans, est. $${plan.totalEstimatedCost}`
        );
        console.log(
          `[supervisor §21] Architecture plan generated for "${criteria.prdTitle}" — v${plan.version}, ${plan.estimatedWorkItems} est. work items`
        );
        // Only generate 1 plan per cycle to avoid timeout
        break;
      } catch (planErr) {
        console.warn(`[supervisor §21] Architecture plan generation failed for "${criteria.prdTitle}":`, planErr);
        out.errors.push(`Architecture plan for "${criteria.prdTitle}": ${planErr instanceof Error ? planErr.message : String(planErr)}`);
      }
    }
  } catch (err) {
    console.warn('[supervisor §21] Architecture planning phase failed (non-fatal):', err);
    out.errors.push(`Architecture planning: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * §22: Trigger decomposition for architecture plans that are ready.
 */
export async function runDecomposition(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    const { getArchitecturePlan, planToDecomposerMarkdown } = await import("@/lib/architecture-planner");
    const { listAllCriteria, getCriteria } = await import("@/lib/intent-criteria");
    const { decomposeFromPlan } = await import("@/lib/decomposer");
    const criteriaEntries = await listAllCriteria();
    const allItemsForDedup = await listWorkItems({});

    for (const entry of criteriaEntries) {
      const plan = await getArchitecturePlan(entry.prdId);
      if (!plan) continue;

      // Dedup guard check
      const dedupKey = `atc/project-decomposed/prd-${entry.prdId}`;
      const alreadyDecomposed = await loadJson<{ decomposedAt: string; workItemCount?: number }>(dedupKey);
      if (alreadyDecomposed) {
        if (alreadyDecomposed.workItemCount === undefined) {
          const projectId = entry.projectId;
          if (projectId) {
            const hasItems = allItemsForDedup.some(
              (wi) => (wi as WorkItem).source?.sourceId === projectId &&
                      (wi as WorkItem).status !== 'cancelled'
            );
            if (!hasItems) {
              await deleteJson(dedupKey);
              out.decisions.push(`Cleared stale dedup guard for "${entry.prdTitle}" (${projectId}) — no active work items found`);
            } else {
              continue;
            }
          } else {
            await deleteJson(dedupKey);
            out.decisions.push(`Cleared unverifiable dedup guard for "${entry.prdTitle}" — no projectId to verify`);
          }
        } else {
          continue;
        }
      }

      const criteria = await getCriteria(entry.prdId);
      if (!criteria) continue;

      console.log(`[supervisor §22] Triggering decomposition for "${criteria.prdTitle}" from architecture plan v${plan.version}`);
      try {
        const markdown = planToDecomposerMarkdown(plan, criteria.prdTitle);

        // Extract file hints from architecture plan for graph-targeted context
        const filesToCreate = plan.criterionPlans.flatMap((cp) => cp.filesToCreate ?? []);
        const filesToModify = plan.criterionPlans.flatMap((cp) => cp.filesToModify ?? []);
        const fileHints = (filesToCreate.length > 0 || filesToModify.length > 0)
          ? { filesToCreate: [...new Set(filesToCreate)], filesToModify: [...new Set(filesToModify)] }
          : undefined;

        const result = await decomposeFromPlan({
          prdId: entry.prdId,
          prdTitle: criteria.prdTitle,
          targetRepo: plan.targetRepo,
          planContent: markdown,
          projectId: criteria.projectId,
          fileHints,
        });

        if (!result.workItems || result.workItems.length === 0) {
          const failureReason = result.reason ?? 'unknown';
          out.decisions.push(`Decomposition of "${criteria.prdTitle}" produced 0 work items (reason: ${failureReason}) — escalating`);
          console.warn(`[supervisor §22] Decomposition of "${criteria.prdTitle}" produced 0 work items (reason: ${failureReason})`);

          const { persistEvents } = await import("./events");
          await persistEvents([makeEvent(
            'error', 'system', undefined, undefined,
            `Decomposer returned 0 items for "${criteria.prdTitle}" (PRD ${entry.prdId}). Reason: ${failureReason}. Project NOT advanced to Executing.`
          )]);

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

        await saveJson(dedupKey, { decomposedAt: new Date().toISOString(), planVersion: plan.version, workItemCount: result.workItems.length });

        out.decisions.push(
          `Decomposed "${criteria.prdTitle}" from architecture plan v${plan.version} — ${result.workItems.length} work items created`
        );
        console.log(`[supervisor §22] Decomposition complete for "${criteria.prdTitle}" — ${result.workItems.length} work items created`);
        // Only decompose 1 per cycle
        break;
      } catch (decompErr) {
        console.warn(`[supervisor §22] Decomposition failed for "${criteria.prdTitle}":`, decompErr);
        out.errors.push(`Decomposition for "${criteria.prdTitle}": ${decompErr instanceof Error ? decompErr.message : String(decompErr)}`);
      }
    }
  } catch (err) {
    console.warn('[supervisor §22] Decomposition trigger phase failed (non-fatal):', err);
    out.errors.push(`Decomposition trigger: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * §20: Intent Validation (post-project-completion criteria verification).
 */
export async function runIntentValidationPhase(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    const { runIntentValidation } = await import("@/lib/intent-validator");
    const result = await runIntentValidation();
    if (result.validated > 0) {
      console.log(
        `[supervisor §20] Intent validation: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped, ${result.followUps} follow-ups`
      );
      out.decisions.push(
        `Validated ${result.validated} criteria: ${result.passed} passed, ${result.failed} failed, ${result.followUps} follow-ups filed`
      );
    }
  } catch (err) {
    console.warn('[supervisor §20] Intent validation phase failed (non-fatal):', err);
    out.errors.push(`Intent validation: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * §5: Vercel spend monitoring and threshold alerts.
 */
export async function runSpendMonitoring(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    console.log('[supervisor §5] Spend Monitoring: start');
    const spendStatus = await getSpendStatus();

    if (spendStatus.skipped) {
      console.log(`[supervisor §5] Spend Monitoring: skipped — ${spendStatus.skipReason}`);
      out.decisions.push(`Spend monitoring skipped: ${spendStatus.skipReason}`);
      return out;
    }

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
    out.errors.push(`Spend monitoring: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * Agent trace health check + staleness monitoring.
 */
export async function runAgentHealth(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();
  const now = new Date();

  // Agent trace health check — read peer agent traces and detect elevated error rates
  try {
    const peerAgents: AgentName[] = ['dispatcher', 'health-monitor', 'project-manager'];
    for (const agentName of peerAgents) {
      const recentTraces = await listRecentTraces(agentName, 5);
      const errorCount = recentTraces.filter(t => t.status === 'error').length;
      if (recentTraces.length >= 3 && errorCount / recentTraces.length > 0.5) {
        out.decisions.push(`Agent ${agentName} elevated error rate: ${errorCount}/${recentTraces.length}`);
        console.warn(`[Supervisor] Agent ${agentName} elevated error rate: ${errorCount}/${recentTraces.length}`);
      }
    }
  } catch (err) {
    console.error("[supervisor] Agent trace health check failed:", err);
    out.errors.push(`Trace health: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Agent staleness check — monitor last-run timestamps
  try {
    const { getAgentLastRun } = await import("./utils");
    const agentNames = ["dispatcher", "health-monitor", "project-manager", "supervisor"];
    const STALE_AGENT_THRESHOLD_MS = 30 * 60 * 1000;

    for (const agent of agentNames) {
      const lastRun = await getAgentLastRun(agent);
      if (!lastRun) {
        console.log(`[supervisor] Agent "${agent}" has never recorded a run`);
        continue;
      }

      const age = now.getTime() - new Date(lastRun).getTime();
      if (age > STALE_AGENT_THRESHOLD_MS) {
        console.warn(`[supervisor] Agent "${agent}" is stale — last run ${Math.round(age / 60_000)} minutes ago`);
        out.events.push(makeEvent(
          "error", "system", undefined, undefined,
          `Agent "${agent}" stale: last run ${Math.round(age / 60_000)}m ago (threshold: ${STALE_AGENT_THRESHOLD_MS / 60_000}m)`
        ));
      }
    }
  } catch (err) {
    console.error("[supervisor] Agent health monitoring failed:", err);
    out.errors.push(`Staleness check: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * §15: Poll HLO Lifecycle State from Open PRs.
 */
export async function runHloPolling(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  const timestamps = await loadTaskTimestamps();
  if (isThrottled(timestamps.stalePrMonitoring, 30)) {
    console.log('[Supervisor] Skipping stale PR monitoring: ran recently');
    return out;
  }

  try {
    const reviewingForHLO = await listWorkItems({ status: "reviewing" });
    const reviewingWorkItems: WorkItem[] = [];
    for (const entry of reviewingForHLO) {
      const wi = await getWorkItem(entry.id);
      if (wi) reviewingWorkItems.push(wi);
    }
    await pollHLOStateFromOpenPRs(reviewingWorkItems);
  } catch (err) {
    console.error("[supervisor §15] HLO state polling failed:", err);
    out.errors.push(`HLO polling: ${err instanceof Error ? err.message : String(err)}`);
  }

  const updatedTimestamps = { ...timestamps, stalePrMonitoring: new Date().toISOString() };
  await saveTaskTimestamps(updatedTimestamps);

  return out;
}

/**
 * Stale branch deletion.
 */
export { cleanupStaleBranches };
export async function runBranchCleanup(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  const timestamps = await loadTaskTimestamps();
  if (isThrottled(timestamps.branchCleanup, 60)) {
    console.log('[Supervisor] Skipping branch cleanup: ran recently');
    return out;
  }

  try {
    const cleanupResult = await cleanupStaleBranches();
    if (cleanupResult && cleanupResult.deletedCount > 0) {
      const cleanupEvents = [makeEvent(
        "cleanup", "system", undefined, undefined,
        `Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}, errors ${cleanupResult.errors}`
      )];
      await import("./events").then(m => m.persistEvents(cleanupEvents));
      out.decisions.push(`Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}`);
    }
  } catch (err) {
    console.error("[supervisor] Branch cleanup failed:", err);
    out.errors.push(`Branch cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }

  const updatedTimestamps = { ...timestamps, branchCleanup: new Date().toISOString() };
  await saveTaskTimestamps(updatedTimestamps);

  return out;
}

/**
 * §9.5: Work item blob-index reconciliation.
 * No-op after Neon Postgres migration — Postgres is the single source of truth,
 * so there's no index/blob drift to reconcile.
 */
// runBlobReconciliation removed — no-op since Neon migration

/**
 * §18: Drift Detection (at most once per 24h).
 */
export async function runDriftDetection(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();
  const now = new Date();
  const DRIFT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

  const lastCheck = await loadJson<{ lastRunAt: string }>(SUPERVISOR_LAST_DRIFT_CHECK_KEY);
  if (lastCheck) {
    const elapsed = now.getTime() - new Date(lastCheck.lastRunAt).getTime();
    if (elapsed < DRIFT_CHECK_INTERVAL_MS) {
      console.log(`[supervisor §18] Drift check skipped — last ran ${Math.round(elapsed / 3600000)}h ago`);
      return out;
    }
  }

  console.log('[supervisor §18] Running drift detection...');

  try {
    const { detectDrift, saveDriftSnapshot, formatDriftAlert } = await import('../drift-detection');

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

    try {
      await saveDriftSnapshot(snapshot);
    } catch (snapErr) {
      console.warn('[supervisor §18] Failed to save drift snapshot:', snapErr);
    }

    if (snapshot.degraded) {
      console.warn(`[supervisor §18] Drift DETECTED — JSD=${snapshot.driftScore.toFixed(4)} (threshold=${snapshot.threshold})`);
      out.events.push(makeEvent(
        'error', 'system', undefined, undefined,
        `Drift detected: JSD=${snapshot.driftScore.toFixed(4)} exceeds threshold ${snapshot.threshold}`
      ));
      out.decisions.push(`Drift detected: JSD=${snapshot.driftScore.toFixed(4)}`);
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

    await saveJson(SUPERVISOR_LAST_DRIFT_CHECK_KEY, { lastRunAt: now.toISOString() });
  } catch (err) {
    console.warn('[supervisor §18] Drift detection failed:', err);
    out.errors.push(`Drift detection: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * §14: PM Agent Daily Sweep.
 */
export async function runPmSweep(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    const SWEEP_KEY = 'pm-agent/last-sweep';
    const lastSweep = await loadJson<{ timestamp: string }>(SWEEP_KEY);

    if (lastSweep) {
      const lastRun = new Date(lastSweep.timestamp);
      const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
      if (hoursSinceLastRun < 20) {
        console.log(`[supervisor §14] PM Agent sweep: skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago)`);
        return out;
      }
    }

    const shouldRun = await checkPMAgentShouldRun();
    if (!shouldRun.shouldRun) {
      console.log(`[PM Agent] Early exit: ${shouldRun.reason}`);
      return out;
    }

    console.log('[supervisor §14] PM Agent sweep: starting');

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
    out.decisions.push(`PM sweep complete: ${review.recommendations.length} recommendations, ${atRisk.length} at-risk projects`);
  } catch (error) {
    console.error('[supervisor §14] PM Agent sweep failed:', error);
    out.errors.push(`PM sweep: ${error instanceof Error ? error.message : String(error)}`);
  }

  return out;
}

/**
 * §16: Periodic Full Re-Index (stale repos >7 days).
 */
export async function runRepoReindex(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();
  const now = new Date();

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
          out.decisions.push(`Re-indexed ${repo.fullName} (${result.entityCount} entities)`);
        } catch (err) {
          console.warn(
            `[supervisor §16] Full re-index failed for ${repo.fullName}:`,
            err instanceof Error ? err.message : String(err)
          );
          out.errors.push(`Re-index ${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`);
        }
        fullIndexCount++;
      } else {
        console.log(`[supervisor §16] ${repo.fullName} snapshot is fresh, skipping`);
      }
    }
  } catch (err) {
    console.error("[supervisor §16] Periodic re-index check failed:", err);
    out.errors.push(`Repo reindex: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

/**
 * Daily cache metrics summary.
 */
export async function runCacheMetrics(): Promise<SupervisorPhaseOutput> {
  const out = emptyOutput();

  try {
    await summarizeDailyCacheMetrics();
  } catch (err) {
    console.error("[supervisor] cache metrics summary failed:", err);
    out.errors.push(`Cache metrics: ${err instanceof Error ? err.message : String(err)}`);
  }

  return out;
}

// ============================================================================
// Legacy — kept for reference, no longer called by coordinator
// ============================================================================

/**
 * @deprecated Use individual phase functions called via phase API routes instead.
 * Kept for reference during transition period.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function runSupervisor(_ctx: CycleContext): Promise<void> {
  throw new Error(
    'runSupervisor() is deprecated. The coordinator now calls individual phase routes. ' +
    'See lib/atc/supervisor-manifest.ts for the phase manifest.'
  );
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

async function cleanupStaleBranches(): Promise<{ deletedCount: number; skipped: number; errors: number }> {
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
  const CLEANUP_ELIGIBLE_STATUSES = ["failed", "parked", "cancelled"] as const;
  for (const status of CLEANUP_ELIGIBLE_STATUSES) {
    const entries = await listWorkItems({ status });
    for (const entry of entries) {
      const item = await getWorkItem(entry.id);
      if (!item || !item.handoff?.branch) continue;

      if (item.execution?.prNumber != null) {
        skipped++;
        continue;
      }

      try {
        const livePR = await getPRByBranch(item.targetRepo, item.handoff.branch);
        if (livePR && livePR.state === "open") {
          console.log(`[supervisor] Skipping branch cleanup for ${item.handoff.branch}: open PR #${livePR.number} found (work item ${item.id} has no prNumber recorded)`);
          skipped++;
          continue;
        }
      } catch {
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
