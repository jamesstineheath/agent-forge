/**
 * Agent 4: Supervisor
 *
 * Goal: Every other agent is healthy and the system is learning.
 * Responsibilities:
 *   - §11: Gmail escalation reply polling
 *   - §12: Escalation reminders
 *   - §15: HLO lifecycle state polling
 *   - Branch cleanup
 *   - §14: PM Agent daily sweep
 *   - NEW: Agent health monitoring
 */

import { loadJson, saveJson } from "../storage";
import { listWorkItems, getWorkItem } from "../work-items";
import {
  getPendingEscalations,
  expireEscalation,
  updateEscalation,
  resolveEscalation,
} from "../escalation";
import { getPRByNumber, getPRLifecycleState } from "../github";
import { summarizeDailyCacheMetrics } from "../cache-metrics";
import { reviewBacklog, assessProjectHealth, composeDigest } from "../pm-agent";
import { cleanupStaleBranches } from "./branch-cleanup";
import type { WorkItem, HLOLifecycleState, ATCEvent } from "../types";
import type { PR } from "../github";
import type { CycleContext } from "./utils";
import { makeEvent, recordAgentRun, getAllAgentHealth } from "./utils";

// --- §15 types (re-exported for consumers) ---

export interface HLOStateEntry {
  workItem: WorkItem;
  hloState: HLOLifecycleState | null;
  prInfo: PR | null;
}

export async function runSupervisor(ctx: CycleContext): Promise<void> {
  const start = Date.now();
  const { now, events } = ctx;

  // §11: Poll Gmail for escalation replies
  try {
    console.log("[supervisor] §11: Polling Gmail for escalation replies...");
    const pendingForGmail = await getPendingEscalations();
    const { checkForReply, parseReplyContent } = await import("../gmail");

    for (const esc of pendingForGmail) {
      if (!esc.threadId) continue;

      const replyMessage = await checkForReply(esc.threadId);
      if (replyMessage) {
        const replyContent = await parseReplyContent(replyMessage.id);
        console.log(
          `[supervisor] Found reply to escalation ${esc.id}:`,
          replyContent,
        );

        const resolved = await resolveEscalation(esc.id, replyContent);
        if (resolved) {
          events.push(
            makeEvent(
              "escalation_resolved",
              esc.workItemId,
              "pending",
              "resolved",
              `Escalation ${esc.id} auto-resolved via Gmail reply: ${replyContent.slice(0, 100)}`,
            ),
          );
        }
      }
    }
  } catch (err) {
    console.error("[supervisor] Gmail reply polling failed:", err);
  }

  // §12: Send reminder emails for old escalations
  try {
    console.log("[supervisor] §12: Checking for escalation reminders...");
    const escalationsForReminder = await getPendingEscalations();
    const REMINDER_THRESHOLD = 24 * 60 * 60 * 1000;

    for (const esc of escalationsForReminder) {
      const ageMs = Date.now() - new Date(esc.createdAt).getTime();
      if (ageMs > REMINDER_THRESHOLD && !esc.reminderSentAt) {
        const workItem = await getWorkItem(esc.workItemId);
        if (workItem) {
          const { sendEscalationEmail } = await import("../gmail");
          const threadId = await sendEscalationEmail(esc, workItem, true);
          if (threadId) {
            await updateEscalation(esc.id, {
              reminderSentAt: new Date().toISOString(),
            });
            events.push(
              makeEvent(
                "escalation_resolved",
                esc.workItemId,
                undefined,
                undefined,
                `Reminder email sent for escalation ${esc.id} (thread: ${threadId})`,
              ),
            );
          }
        }
      }
    }
  } catch (err) {
    console.error("[supervisor] Escalation reminder check failed:", err);
  }

  // 10. Escalation timeout monitoring: flag escalations older than 24h
  try {
    const pending = await getPendingEscalations();
    const ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

    for (const esc of pending) {
      const createdTime = new Date(esc.createdAt).getTime();
      const age = now.getTime() - createdTime;

      if (age > ESCALATION_TIMEOUT_MS) {
        await expireEscalation(esc.id);
        events.push(
          makeEvent(
            "escalation_timeout",
            esc.workItemId,
            "pending",
            "expired",
            `Escalation ${esc.id} timed out after 24h without resolution. Reason: ${esc.reason}`,
          ),
        );
        console.log(
          `[supervisor] Escalation timeout: ${esc.id} for work item ${esc.workItemId}`,
        );
      }
    }
  } catch (err) {
    console.error("[supervisor] Escalation monitoring failed:", err);
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
    void hloStateMap; // Will be consumed by future SLA/remediation sections
  } catch (err) {
    console.error("[supervisor §15] HLO state polling failed:", err);
  }

  // Branch cleanup
  try {
    const cleanupResult = await cleanupStaleBranches();
    if (cleanupResult && cleanupResult.deletedCount > 0) {
      events.push(
        makeEvent(
          "cleanup",
          "system",
          undefined,
          undefined,
          `Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}, errors ${cleanupResult.errors}`,
        ),
      );
    }
  } catch (err) {
    console.error("[supervisor] Branch cleanup failed:", err);
  }

  // Cache metrics summary (observability)
  await summarizeDailyCacheMetrics().catch((err) =>
    console.error("[supervisor] cache metrics summary failed:", err),
  );

  // §14 — PM Agent Daily Sweep
  try {
    await runPMAgentSweep();
  } catch (error) {
    console.error("[supervisor §14] Unexpected error in PM Agent sweep:", error);
  }

  // NEW: Agent health monitoring
  try {
    const health = await getAllAgentHealth();
    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    for (const [agentName, record] of Object.entries(health)) {
      if (!record) {
        console.warn(
          `[supervisor] Agent "${agentName}" has never run — no health record found.`,
        );
        continue;
      }

      const age = now.getTime() - new Date(record.lastRunAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        console.warn(
          `[supervisor] Agent "${agentName}" is stale — last ran ${Math.round(age / 60_000)} minutes ago.`,
        );
        // Future: file a work item or escalation for the stale agent
      }
    }
  } catch (err) {
    console.error("[supervisor] Agent health monitoring failed:", err);
  }

  await recordAgentRun("supervisor", Date.now() - start);
}

// --- §14 PM Agent Daily Sweep (internal) ---

async function runPMAgentSweep(): Promise<void> {
  const SWEEP_KEY = "pm-agent/last-sweep";
  const lastSweep = await loadJson<{ timestamp: string }>(SWEEP_KEY);

  if (lastSweep) {
    const lastRun = new Date(lastSweep.timestamp);
    const hoursSinceLastRun =
      (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastRun < 20) {
      console.log(
        `[supervisor §14] PM Agent sweep: skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago)`,
      );
      return;
    }
  }

  console.log("[supervisor §14] PM Agent sweep: starting");

  try {
    const review = await reviewBacklog();
    console.log(
      `[supervisor §14] Backlog review complete: ${review.recommendations.length} recommendations`,
    );

    const healths = await assessProjectHealth();
    const atRisk = healths.filter(
      (h) =>
        h.status === "at-risk" ||
        h.status === "stalling" ||
        h.status === "blocked",
    );
    console.log(
      `[supervisor §14] Health assessment: ${healths.length} projects, ${atRisk.length} at risk`,
    );

    await composeDigest({
      includeHealth: true,
      includeBacklog: true,
      includeRecommendations: true,
      recipientEmail: "james.stine.heath@gmail.com",
    });
    console.log("[supervisor §14] Digest sent");

    await saveJson(SWEEP_KEY, { timestamp: new Date().toISOString() });
  } catch (error) {
    console.error("[supervisor §14] PM Agent sweep failed:", error);
  }
}

// --- §15 HLO Polling (internal) ---

async function pollHLOStateFromOpenPRs(
  workItems: WorkItem[],
): Promise<Map<number, HLOStateEntry>> {
  const reviewingItems = workItems.filter(
    (wi) => wi.status === "reviewing" && wi.execution?.prNumber != null,
  );

  const resultMap = new Map<number, HLOStateEntry>();

  await Promise.all(
    reviewingItems.map(async (wi) => {
      const prNumber = wi.execution!.prNumber!;
      const targetRepo = wi.targetRepo;
      const [owner, repo] = targetRepo.split("/");

      if (!owner || !repo) {
        console.warn(
          `[supervisor §15] Work item ${wi.id} missing owner/repo, skipping`,
        );
        return;
      }

      let hloState: HLOLifecycleState | null = null;
      let prInfo: PR | null = null;

      try {
        hloState = await getPRLifecycleState(owner, repo, prNumber);
      } catch (err) {
        console.warn(
          `[supervisor §15] Failed to get HLO state for PR #${prNumber}:`,
          err,
        );
      }

      try {
        prInfo = await getPRByNumber(targetRepo, prNumber);
      } catch (err) {
        console.warn(
          `[supervisor §15] Failed to get PR info for PR #${prNumber}:`,
          err,
        );
      }

      resultMap.set(prNumber, { workItem: wi, hloState, prInfo });
    }),
  );

  const withLifecycle = [...resultMap.values()].filter(
    (e) => e.hloState !== null,
  ).length;
  const withoutLifecycle = resultMap.size - withLifecycle;

  console.log(
    `[supervisor §15] Polled HLO state for ${resultMap.size} PRs (${withLifecycle} with lifecycle data, ${withoutLifecycle} without)`,
  );

  return resultMap;
}
