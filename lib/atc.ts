import { loadJson, saveJson, deleteJson } from "./storage";
import { listWorkItems, getWorkItem, updateWorkItem } from "./work-items";
import { listRepos, getRepo } from "./repos";
import { listBranches, deleteBranch, getBranchLastCommitDate, getPRByBranch, getPRByNumber, getPRLifecycleState } from "./github";
import type { ATCEvent, ATCState, WorkItem, HLOLifecycleState } from "./types";
import type { PR } from "./github";
import { getExecuteProjects, transitionToExecuting, transitionToFailed, checkProjectCompletion, transitionProject, writeOutcomeSummary, getRetryProjects, clearRetryFlag, markProjectFailedFromRetry } from "./projects";
import { decomposeProject } from "./decomposer";
import { validatePlan } from "./plan-validator";
import { getPendingEscalations, expireEscalation, resolveEscalation, updateEscalation, escalate, findPendingProjectEscalation } from "./escalation";
import { summarizeDailyCacheMetrics } from "./cache-metrics";
import { reviewBacklog, assessProjectHealth, composeDigest } from "./pm-agent";

// --- Re-exports from extracted modules (backward compatibility) ---
export { parseEstimatedFiles, hasFileOverlap, HIGH_CHURN_FILES, makeEvent, withTimeout } from "./atc/utils";
export { acquireATCLock, releaseATCLock } from "./atc/lock";
export { getATCState, getATCEvents, getWorkItemEvents, persistEvents } from "./atc/events";
export { CycleTimeoutError } from "./atc/types";
export type { CycleContext, HLOStateEntry } from "./atc/types";
export { runDispatcher } from "./atc/dispatcher";
export { runHealthMonitor } from "./atc/health-monitor";

// --- Import extracted modules for use in the monolith cycle ---
import { acquireATCLock, releaseATCLock } from "./atc/lock";
import { getATCState, persistEvents } from "./atc/events";
import { makeEvent, withTimeout } from "./atc/utils";
import { runDispatcher } from "./atc/dispatcher";
import { runHealthMonitor } from "./atc/health-monitor";
import {
  ATC_STATE_KEY,
  ATC_EVENTS_KEY,
  ATC_BRANCH_CLEANUP_KEY,
  CYCLE_TIMEOUT_MS,
  MAX_EVENTS,
  CLEANUP_THROTTLE_MINUTES,
  STALE_BRANCH_HOURS,
  MAX_BRANCHES_PER_REPO,
  QUALITY_GATE_EXEMPT_PROJECTS,
  CycleTimeoutError,
} from "./atc/types";
import type { CycleContext } from "./atc/types";

export async function runATCCycle(): Promise<ATCState> {
  const locked = await acquireATCLock();
  if (!locked) {
    return await getATCState();
  }

  try {
    return await withTimeout(_runATCCycleInner(), CYCLE_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      console.error(`[atc] Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout.`);
      return await getATCState();
    }
    throw err;
  } finally {
    await releaseATCLock();
  }
}

async function _runATCCycleInner(): Promise<ATCState> {
  const now = new Date();
  const events: ATCEvent[] = [];
  const ctx: CycleContext = { now, events };

  // === PHASES 0-1: DISPATCH (delegated to dispatcher agent) ===
  await runDispatcher(ctx);

  // === PHASE 2: MONITORING (delegated to health monitor agent) ===
  const activeExecutions = await runHealthMonitor(ctx);

  // §4 — Project retry processing
  try {
    const retryProjects = await getRetryProjects();
    if (retryProjects.length > 0) {
      console.log(`[atc] §4: found ${retryProjects.length} project(s) flagged for retry`);
    }

    for (const project of retryProjects) {
      const retryCount = project.retryCount ?? 0;

      if (retryCount >= 3) {
        console.log(`[atc] §4: project ${project.projectId} has hit retry cap (retryCount=${retryCount}), marking failed`);
        await markProjectFailedFromRetry(project.id);
        events.push(makeEvent(
          "project_retry", project.projectId, undefined, "Failed",
          `Retry cap exceeded (retryCount=${retryCount}), marked Failed`
        ));
        continue;
      }

      try {
        await deleteJson(`atc/project-decomposed/${project.projectId}`);
        console.log(`[atc] §4: cleared dedup guard for project ${project.projectId}`);
      } catch {
        console.log(`[atc] §4: no dedup guard to clear for project ${project.projectId} (ok)`);
      }

      const staleStates: WorkItem["status"][] = ["failed", "parked", "blocked", "ready", "filed", "queued"];
      const allEntries = await listWorkItems({});
      const projectItems: WorkItem[] = [];
      for (const entry of allEntries) {
        const wi = await getWorkItem(entry.id);
        if (wi && wi.source.type === "project" && wi.source.sourceId === project.projectId) {
          projectItems.push(wi);
        }
      }
      const itemsToCancel = projectItems.filter((item) => staleStates.includes(item.status));

      for (const item of itemsToCancel) {
        await updateWorkItem(item.id, { status: "cancelled" });
      }
      console.log(`[atc] §4: cancelled ${itemsToCancel.length} stale work items for project ${project.projectId}`);

      await clearRetryFlag(project.id, retryCount);

      events.push(makeEvent(
        "project_retry", project.projectId, undefined, "Execute",
        `Retry initiated (newRetryCount=${retryCount + 1}, cancelledItems=${itemsToCancel.length})`
      ));

      console.log(`[atc] §4: project ${project.projectId} reset for retry (attempt ${retryCount + 1})`);
    }
  } catch (err) {
    console.error(`[atc] §4 error:`, err);
  }

  // 4.5: Detect Notion projects with Status = "Execute", transition, and decompose
  try {
    const executeProjects = await getExecuteProjects();
    for (const project of executeProjects) {
      const success = await transitionToExecuting(project);
      if (!success) continue;

      const dedupKey = `atc/project-decomposed/${project.projectId}`;
      const alreadyDecomposed = await loadJson<{ decomposedAt: string }>(dedupKey);

      if (alreadyDecomposed) {
        const existingItems = await listWorkItems({});
        const projectWorkItems: WorkItem[] = [];
        for (const entry of existingItems) {
          const wi = await getWorkItem(entry.id);
          if (wi && wi.source.type === "project" && wi.source.sourceId === project.projectId) {
            projectWorkItems.push(wi);
          }
        }

        if (projectWorkItems.length === 0) {
          console.warn(`[atc] Partial-failure recovery: project ${project.projectId} has dedup guard but 0 work items. Clearing guard.`);
          await deleteJson(dedupKey);
        } else {
          events.push(makeEvent(
            "project_trigger", project.projectId, undefined, undefined,
            `Dedup guard: project "${project.title}" already decomposed at ${alreadyDecomposed.decomposedAt}, skipping`
          ));
          continue;
        }
      }

      events.push(makeEvent(
        "status_change", project.projectId, "Execute", "Executing",
        `Project "${project.title}" (${project.projectId}) transitioned to Executing`
      ));

      // §4.5 Plan Quality Gate
      const loopGuardKey = `atc/decomp-attempts/${project.projectId}`;
      const loopGuard = await loadJson<{ attempts: number }>(loopGuardKey);
      const currentAttempts = (loopGuard?.attempts ?? 0) + 1;
      await saveJson(loopGuardKey, { attempts: currentAttempts });

      if (currentAttempts > 3) {
        console.error(
          `[ATC §4.5 Loop Guard] Project "${project.title}" (${project.projectId}) has attempted decomposition ${currentAttempts} times without success. Forcing to Failed.`
        );
        await transitionToFailed(project);
        await deleteJson(loopGuardKey);
        events.push(makeEvent(
          "error", project.projectId, "Executing", "Failed",
          `Decomposition loop detected after ${currentAttempts} attempts for "${project.title}". Forced to Failed.`
        ));
        continue;
      }

      const isExempt = QUALITY_GATE_EXEMPT_PROJECTS.has(project.projectId);
      if (isExempt) {
        console.log(`[ATC §4.5] Project "${project.title}" (${project.projectId}) is exempt from quality gate — proceeding to decomposition.`);
      }

      if (!isExempt) {
        const validation = await validatePlan(project.id);
        if (!validation.valid) {
          const failedChecks = validation.issues
            .map((i) => `[${i.severity.toUpperCase()}]${i.section ? ` ${i.section}:` : ''} ${i.message}`);

          const rejectionReason =
            `Plan quality gate rejected project "${project.title}" (${project.projectId}). ` +
            `Checks failed: ${failedChecks.join("; ")}. ` +
            `Project will be transitioned to Failed to prevent infinite loop. ` +
            `If this project has a human-authored plan, add its projectId to QUALITY_GATE_EXEMPT_PROJECTS in lib/atc/types.ts to bypass.`;
          console.error(`[ATC §4.5 Quality Gate] ${rejectionReason}`);

          const issueList = failedChecks.join('\n');
          const escalationReason = `Plan validation found ${validation.issues.length} issue(s):\n\n${issueList}\n\nProject transitioned to Failed. Fix the plan and re-trigger, or add to QUALITY_GATE_EXEMPT_PROJECTS if this is a human-authored plan.`;

          const existingEscalation = await findPendingProjectEscalation(project.projectId, escalationReason);
          if (existingEscalation) {
            console.log(`[ATC §4.5] Pending escalation already exists for project ${project.projectId}, skipping email`);
          } else {
            try {
              await escalate(
                `project-${project.projectId}`,
                escalationReason,
                0.9,
                { projectTitle: project.title, issues: validation.issues },
                project.projectId
              );
            } catch (emailErr) {
              console.error(`[ATC §4.5] Failed to send escalation email for ${project.title}:`, emailErr);
            }
          }

          await transitionToFailed(project);
          events.push(makeEvent(
            "error", project.projectId, "Executing", "Failed",
            `Plan quality gate rejected "${project.title}": ${validation.issues.length} issue(s). Transitioned to Failed.`
          ));
          continue;
        }
      }

      console.log(`[ATC §4.5] Plan validated for ${project.title}, proceeding to decomposition`);

      try {
        const result = await decomposeProject(project);
        const workItems = result.workItems;

        if (workItems.length === 0) {
          console.error(
            `[ATC] Decomposition produced 0 work items for "${project.title}" (${project.projectId}). ` +
            `Transitioning to Failed. Check Notion plan page format and decomposer logs.`
          );
          await transitionToFailed(project);
          events.push(makeEvent(
            "error", project.projectId, "Executing", "Failed",
            `Decomposition produced 0 work items for "${project.title}", transitioning to Failed`
          ));
          continue;
        }

        await saveJson(dedupKey, { decomposedAt: now.toISOString(), workItemCount: workItems.length });
        await deleteJson(loopGuardKey);

        events.push(makeEvent(
          "project_trigger", project.projectId, undefined, undefined,
          `Project "${project.title}" decomposed into ${workItems.length} work items`
        ));

        try {
          const { sendDecompositionSummary } = await import("./gmail");
          await sendDecompositionSummary(project, workItems, result.phases ?? undefined, result.phaseBreakdown);
        } catch (emailErr) {
          console.error("[atc] Decomposition summary email failed:", emailErr);
        }
      } catch (decomposeErr) {
        const msg = decomposeErr instanceof Error ? decomposeErr.message : String(decomposeErr);
        console.error(`[atc] Decomposition failed for project ${project.projectId}:`, decomposeErr);
        await transitionToFailed(project);
        events.push(makeEvent(
          "error", project.projectId, "Executing", "Failed",
          `Decomposition failed for "${project.title}": ${msg}`
        ));
      }
    }
  } catch (err) {
    console.error("[atc] Project sweep failed:", err);
  }

  // 5. Count queued items
  const queuedEntries = await listWorkItems({ status: "queued" });
  const readyEntries = await listWorkItems({ status: "ready" });
  const queuedItems = queuedEntries.length + readyEntries.length;

  // 6. Build and save state
  const state: ATCState = {
    lastRunAt: now.toISOString(),
    activeExecutions,
    queuedItems,
    recentEvents: events.slice(-20),
  };
  await saveJson(ATC_STATE_KEY, state);

  // 7. Persist events
  await persistEvents(events);

  // 8. Periodic branch cleanup
  try {
    const cleanupResult = await cleanupStaleBranches();
    if (cleanupResult && cleanupResult.deletedCount > 0) {
      const cleanupEvents = [makeEvent(
        "cleanup", "system", undefined, undefined,
        `Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}, errors ${cleanupResult.errors}`
      )];
      await persistEvents(cleanupEvents);
    }
  } catch (err) {
    console.error("[atc] Branch cleanup failed:", err);
  }

  // 9.5: Work item blob-index reconciliation (hourly)
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
          console.warn(`[atc] Reconciliation safety: index is empty but ${blobs.length} blob(s) exist. Skipping to prevent data loss.`);
          await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
        } else {
          const danglingIds = [...blobIds].filter(id => id && !indexIds.has(id));
          if (danglingIds.length > 0 && danglingIds.length > blobIds.size * 0.5) {
            console.error(`[atc] Reconciliation safety: ${danglingIds.length}/${blobIds.size} blobs flagged as dangling (>50%). Refusing to delete. Likely index corruption.`);
          } else if (danglingIds.length > 0) {
            for (const id of danglingIds) {
              await deleteJson(`work-items/${id}`);
            }
            const reconEvents = [makeEvent(
              "cleanup", "system", undefined, undefined,
              `Blob reconciliation: deleted ${danglingIds.length} dangling work-item blob(s)`
            )];
            await persistEvents(reconEvents);
          }

          const staleIndexEntries = indexEntries.filter(e => !blobIds.has(e.id));
          if (staleIndexEntries.length > 0 && staleIndexEntries.length < indexEntries.length) {
            const cleanedIndex = indexEntries.filter(e => blobIds.has(e.id));
            await saveJson("work-items/index", cleanedIndex);
            const reconEvents = [makeEvent(
              "cleanup", "system", undefined, undefined,
              `Index reconciliation: removed ${staleIndexEntries.length} stale index entries`
            )];
            await persistEvents(reconEvents);
          } else if (staleIndexEntries.length === indexEntries.length && indexEntries.length > 0) {
            console.error(`[atc] Reconciliation safety: ALL ${indexEntries.length} index entries are stale. Refusing to wipe index.`);
          }
        }
      }

      await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
    }
  } catch (err) {
    console.error("[atc] Blob-index reconciliation failed:", err);
  }

  // 10. Escalation timeout monitoring
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
        console.log(`[atc] Escalation timeout: ${esc.id} for work item ${esc.workItemId}`);
      }
    }
  } catch (err) {
    console.error("[atc] Escalation monitoring failed:", err);
  }

  if (events.some(e => e.type === "escalation_timeout")) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...events.filter(e => e.type === "escalation_timeout")].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }

  // Section 11: Poll Gmail for escalation replies
  try {
    console.log('[atc] Section 11: Polling Gmail for escalation replies...');
    const pendingForGmail = await getPendingEscalations();
    const { checkForReply, parseReplyContent } = await import('./gmail');

    for (const esc of pendingForGmail) {
      if (!esc.threadId) continue;

      const replyMessage = await checkForReply(esc.threadId);
      if (replyMessage) {
        const replyContent = await parseReplyContent(replyMessage.id);
        console.log(`[atc] Found reply to escalation ${esc.id}:`, replyContent);

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
    console.error("[atc] Gmail reply polling failed:", err);
  }

  // Section 12: Send reminder emails for old escalations
  try {
    console.log('[atc] Section 12: Checking for escalation reminders...');
    const escalationsForReminder = await getPendingEscalations();
    const REMINDER_THRESHOLD = 24 * 60 * 60 * 1000;

    for (const esc of escalationsForReminder) {
      const ageMs = Date.now() - new Date(esc.createdAt).getTime();
      if (ageMs > REMINDER_THRESHOLD && !esc.reminderSentAt) {
        const workItem = await getWorkItem(esc.workItemId);
        if (workItem) {
          const { sendEscalationEmail } = await import('./gmail');
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
    console.error("[atc] Escalation reminder check failed:", err);
  }

  // Section 13: Project lifecycle management
  try {
    const { listProjects } = await import("./projects");
    const { updateProjectStatus } = await import("./notion");
    const executingProjects = await listProjects("Executing");

    const allItemEntries = await listWorkItems({});
    const allItemsById = new Map<string, WorkItem>();
    for (const entry of allItemEntries) {
      const item = await getWorkItem(entry.id);
      if (item) allItemsById.set(item.id, item);
    }

    for (const project of executingProjects) {
      const projectItems = [...allItemsById.values()].filter(
        (item) => item.source.type === "project" && item.source.sourceId === project.projectId
      );

      if (projectItems.length === 0) {
        const dedupKey = `atc/project-decomposed/${project.projectId}`;
        const hasDedup = await loadJson<{ decomposedAt: string }>(dedupKey);
        if (!hasDedup) {
          await updateProjectStatus(project.id, "Execute");
          events.push(makeEvent(
            "project_trigger", project.projectId, "Executing", "Execute",
            `Stuck recovery: project "${project.title}" was Executing with no work items and no dedup guard. Reset to Execute for re-decomposition.`
          ));
        }
        continue;
      }

      const result = await checkProjectCompletion(project.projectId, [...allItemsById.values()]);

      if (result.isTerminal && result.status) {
        await transitionProject(project.id, result.status, result.summary);

        events.push(makeEvent(
          "project_completion", project.projectId, "Executing", result.status,
          `Project "${project.title}" → ${result.status}: ${result.summary}`
        ));

        console.log(
          `[ATC §13b] Project ${project.projectId} transitioned to ${result.status}: ${result.summary}`
        );

        try {
          await writeOutcomeSummary(project.projectId, result.status);
          console.log(`[ATC §13b] Outcome summary written for project ${project.projectId} → ${result.status}`);
        } catch (summaryErr) {
          console.error(`[ATC §13b] Failed to write outcome summary for project ${project.projectId}: ${summaryErr}`);
        }
      }
    }
  } catch (err) {
    console.error("[atc] Project lifecycle management failed:", err);
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

  // §15: Poll HLO Lifecycle State from Open PRs
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
    console.error("[ATC §15] HLO state polling failed:", err);
  }

  // Cache metrics summary (observability)
  await summarizeDailyCacheMetrics().catch((err) =>
    console.error("[ATC] cache metrics summary failed:", err)
  );

  // § 14 — PM Agent Daily Sweep
  try {
    await runPMAgentSweep();
  } catch (error) {
    console.error('[ATC §14] Unexpected error in PM Agent sweep:', error);
  }

  // §16: Periodic Full Re-Index (stale repos >7 days)
  try {
    const { loadRepoSnapshot } = await import("./knowledge-graph/storage");
    const { fullIndex } = await import("./knowledge-graph/indexer");
    const allRepos = await listRepos();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    let fullIndexCount = 0;

    for (const repoEntry of allRepos) {
      if (fullIndexCount >= 1) {
        console.log(`[ATC §16] Full re-index cap reached (1/cycle), skipping remaining repos`);
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
          `[ATC §16] ${repo.fullName} snapshot stale (lastIndexed: ${lastIndexed}), triggering full re-index`
        );
        try {
          const result = await fullIndex(repo.fullName);
          console.log(
            `[ATC §16] Full re-index complete for ${repo.fullName} (${result.entityCount} entities)`
          );
        } catch (err) {
          console.warn(
            `[ATC §16] Full re-index failed for ${repo.fullName}:`,
            err instanceof Error ? err.message : String(err)
          );
        }
        fullIndexCount++;
      } else {
        console.log(`[ATC §16] ${repo.fullName} snapshot is fresh, skipping`);
      }
    }
  } catch (err) {
    console.error("[ATC §16] Periodic re-index check failed:", err);
  }

  return state;
}

// § 14 — PM Agent Daily Sweep
async function runPMAgentSweep() {
  const SWEEP_KEY = 'pm-agent/last-sweep';
  const lastSweep = await loadJson<{ timestamp: string }>(SWEEP_KEY);

  if (lastSweep) {
    const lastRun = new Date(lastSweep.timestamp);
    const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastRun < 20) {
      console.log(`[ATC §14] PM Agent sweep: skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago)`);
      return;
    }
  }

  console.log('[ATC §14] PM Agent sweep: starting');

  try {
    const review = await reviewBacklog();
    console.log(`[ATC §14] Backlog review complete: ${review.recommendations.length} recommendations`);

    const healths = await assessProjectHealth();
    const atRisk = healths.filter(h => h.status === 'at-risk' || h.status === 'stalling' || h.status === 'blocked');
    console.log(`[ATC §14] Health assessment: ${healths.length} projects, ${atRisk.length} at risk`);

    await composeDigest({
      includeHealth: true,
      includeBacklog: true,
      includeRecommendations: true,
      recipientEmail: 'james.stine.heath@gmail.com',
    });
    console.log('[ATC §14] Digest sent');

    await saveJson(SWEEP_KEY, { timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[ATC §14] PM Agent sweep failed:', error);
  }
}

// === §15: Poll HLO Lifecycle State from Open PRs ===
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
        console.warn(`ATC §15: Work item ${wi.id} missing owner/repo, skipping`);
        return;
      }

      let hloState: HLOLifecycleState | null = null;
      let prInfo: PR | null = null;

      try {
        hloState = await getPRLifecycleState(owner, repo, prNumber);
      } catch (err) {
        console.warn(`ATC §15: Failed to get HLO state for PR #${prNumber}:`, err);
      }

      try {
        prInfo = await getPRByNumber(targetRepo, prNumber);
      } catch (err) {
        console.warn(`ATC §15: Failed to get PR info for PR #${prNumber}:`, err);
      }

      resultMap.set(prNumber, { workItem: wi, hloState, prInfo });
    })
  );

  const withLifecycle = [...resultMap.values()].filter((e) => e.hloState !== null).length;
  const withoutLifecycle = resultMap.size - withLifecycle;

  console.log(
    `ATC §15: Polled HLO state for ${resultMap.size} PRs (${withLifecycle} with lifecycle data, ${withoutLifecycle} without)`
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
        const deleted = await deleteBranch(item.targetRepo, item.handoff.branch);
        if (deleted) {
          deletedCount++;
          console.log(`[atc] Deleted branch for ${status} work item ${item.id}: ${item.handoff.branch} from ${item.targetRepo}`);
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
      console.log(`[atc] ${repo.fullName} has ${branches.length} branches, capping at ${MAX_BRANCHES_PER_REPO}. Remaining will be processed next cycle.`);
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
          console.log(`[atc] Deleted stale branch: ${branch} from ${repo.fullName} (last commit: ${lastCommitDate})`);
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
