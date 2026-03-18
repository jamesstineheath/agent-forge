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
} from "../escalation";
import { summarizeDailyCacheMetrics } from "../cache-metrics";
import { reviewBacklog, assessProjectHealth, composeDigest } from "../pm-agent";
import type { ATCEvent, HLOLifecycleState, WorkItem } from "../types";
import type { CycleContext } from "./types";
import {
  ATC_EVENTS_KEY,
  ATC_BRANCH_CLEANUP_KEY,
  MAX_EVENTS,
  CLEANUP_THROTTLE_MINUTES,
  STALE_BRANCH_HOURS,
  MAX_BRANCHES_PER_REPO,
} from "./types";
import { makeEvent } from "./utils";

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
    console.error("[supervisor §15] HLO state polling failed:", err);
  }

  // Branch cleanup
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

  // Cache metrics summary (observability)
  await summarizeDailyCacheMetrics().catch((err) =>
    console.error("[supervisor] cache metrics summary failed:", err)
  );

  // §14 — PM Agent Daily Sweep
  try {
    await runPMAgentSweep();
  } catch (error) {
    console.error('[supervisor §14] Unexpected error in PM Agent sweep:', error);
  }

  // §16: Periodic Full Re-Index (stale repos >7 days)
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
