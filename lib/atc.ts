import { randomUUID } from "crypto";
import { loadJson, saveJson } from "./storage";
import { listWorkItems, getWorkItem, updateWorkItem, getNextDispatchable } from "./work-items";
import { listRepos, getRepo } from "./repos";
import { getWorkflowRuns, getPRByBranch } from "./github";
import { dispatchWorkItem } from "./orchestrator";
import type { ATCEvent, ATCState } from "./types";

const ATC_STATE_KEY = "atc/state";
const ATC_EVENTS_KEY = "atc/events";
const STALL_TIMEOUT_MINUTES = 30;
const MAX_EVENTS = 200;

export async function runATCCycle(): Promise<ATCState> {
  const now = new Date();
  const events: ATCEvent[] = [];

  // 1. Load active work items (executing or reviewing)
  const [executingEntries, reviewingEntries] = await Promise.all([
    listWorkItems({ status: "executing" }),
    listWorkItems({ status: "reviewing" }),
  ]);
  const activeEntries = [...executingEntries, ...reviewingEntries];

  const activeExecutions: ATCState["activeExecutions"] = [];

  // 2. Process each active item
  for (const entry of activeEntries) {
    const item = await getWorkItem(entry.id);
    if (!item) continue;

    const branch = item.handoff?.branch;
    const startedAt = item.execution?.startedAt;

    if (!branch) continue;

    const elapsedMinutes = startedAt
      ? (now.getTime() - new Date(startedAt).getTime()) / 60_000
      : 0;

    activeExecutions.push({
      workItemId: item.id,
      targetRepo: item.targetRepo,
      branch,
      status: item.status,
      startedAt: startedAt ?? now.toISOString(),
      elapsedMinutes: Math.round(elapsedMinutes),
    });

    // Check for stall timeout
    if (elapsedMinutes >= STALL_TIMEOUT_MINUTES) {
      const event = makeEvent("timeout", item.id, item.status, "failed",
        `Execution stalled: no progress for ${Math.round(elapsedMinutes)} minutes (reason: timeout)`);
      await updateWorkItem(item.id, {
        status: "failed",
        execution: {
          ...item.execution,
          completedAt: now.toISOString(),
          outcome: "failed",
        },
      });
      events.push(event);
      continue;
    }

    // Fetch GitHub state
    const [workflowRuns, pr] = await Promise.all([
      getWorkflowRuns(item.targetRepo, branch),
      getPRByBranch(item.targetRepo, branch),
    ]);

    const latestRun = workflowRuns[0] ?? null;

    if (item.status === "executing") {
      if (pr?.mergedAt) {
        // PR merged while still "executing" (edge case)
        const event = makeEvent("status_change", item.id, "executing", "merged",
          `PR #${pr.number} merged`);
        await updateWorkItem(item.id, {
          status: "merged",
          execution: {
            ...item.execution,
            prNumber: pr.number,
            prUrl: pr.htmlUrl,
            completedAt: pr.mergedAt,
            outcome: "merged",
          },
        });
        events.push(event);
      } else if (pr?.state === "closed" && !pr.mergedAt) {
        const event = makeEvent("status_change", item.id, "executing", "failed",
          `PR #${pr.number} closed without merge (reason: pr_closed)`);
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            prNumber: pr.number,
            prUrl: pr.htmlUrl,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(event);
      } else if (latestRun?.status === "completed" && latestRun.conclusion === "success" && pr) {
        // Workflow succeeded and PR exists -> move to reviewing
        const event = makeEvent("status_change", item.id, "executing", "reviewing",
          `Workflow run ${latestRun.id} completed successfully, PR #${pr.number} open`);
        await updateWorkItem(item.id, {
          status: "reviewing",
          execution: {
            ...item.execution,
            workflowRunId: latestRun.id,
            prNumber: pr.number,
            prUrl: pr.htmlUrl,
          },
        });
        events.push(event);
      } else if (latestRun?.status === "completed" && latestRun.conclusion !== "success" && latestRun.conclusion !== null) {
        const event = makeEvent("status_change", item.id, "executing", "failed",
          `Workflow run ${latestRun.id} failed with conclusion: ${latestRun.conclusion} (reason: workflow_failed)`);
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            workflowRunId: latestRun.id,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(event);
      } else if (!latestRun && elapsedMinutes >= STALL_TIMEOUT_MINUTES) {
        const event = makeEvent("timeout", item.id, "executing", "failed",
          `No workflow run found after ${Math.round(elapsedMinutes)} minutes (reason: timeout)`);
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(event);
      }
    } else if (item.status === "reviewing") {
      if (pr?.mergedAt) {
        const event = makeEvent("status_change", item.id, "reviewing", "merged",
          `PR #${pr.number} merged`);
        await updateWorkItem(item.id, {
          status: "merged",
          execution: {
            ...item.execution,
            prNumber: pr.number,
            prUrl: pr.htmlUrl,
            completedAt: pr.mergedAt,
            outcome: "merged",
          },
        });
        events.push(event);
      } else if (pr?.state === "closed" && !pr.mergedAt) {
        const event = makeEvent("status_change", item.id, "reviewing", "failed",
          `PR #${pr.number} closed without merge (reason: pr_closed)`);
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            prNumber: pr.number,
            prUrl: pr.htmlUrl,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(event);
      }
    }
  }

  // 3. Check concurrency per repo (log concurrency_block events for awareness)
  const repoIndex = await listRepos();
  const concurrencyMap = new Map<string, number>();
  for (const exec of activeExecutions) {
    concurrencyMap.set(exec.targetRepo, (concurrencyMap.get(exec.targetRepo) ?? 0) + 1);
  }
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;
    const activeCount = concurrencyMap.get(repo.fullName) ?? 0;
    if (activeCount >= repo.concurrencyLimit) {
      const queuedForRepo = await listWorkItems({ status: "ready", targetRepo: repo.fullName });
      if (queuedForRepo.length > 0) {
        events.push(makeEvent(
          "concurrency_block",
          queuedForRepo[0].id,
          undefined,
          undefined,
          `Repo ${repo.fullName} at concurrency limit (${activeCount}/${repo.concurrencyLimit}); ${queuedForRepo.length} item(s) queued`
        ));
      }
    }
  }

  // 4. Auto-dispatch: for repos with available capacity, dispatch next ready item
  const GLOBAL_CONCURRENCY_LIMIT = 3;
  const totalActive = activeExecutions.filter(
    (e) => e.status === "executing" || e.status === "reviewing"
  ).length;

  if (totalActive < GLOBAL_CONCURRENCY_LIMIT) {
    for (const repoEntry of repoIndex) {
      if (activeExecutions.filter(e => e.status === "executing" || e.status === "reviewing").length >= GLOBAL_CONCURRENCY_LIMIT) break;
      const repo = await getRepo(repoEntry.id);
      if (!repo) continue;
      const activeCount = concurrencyMap.get(repo.fullName) ?? 0;
      if (activeCount >= repo.concurrencyLimit) continue;

      const nextItem = await getNextDispatchable(repo.fullName);
      if (!nextItem) continue;

      try {
        const result = await dispatchWorkItem(nextItem.id);
        events.push(makeEvent(
          "auto_dispatch", nextItem.id, "ready", "executing",
          `Auto-dispatched to ${repo.fullName} (branch: ${result.branch})`
        ));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        events.push(makeEvent(
          "error", nextItem.id, undefined, undefined,
          `Auto-dispatch failed: ${msg}`
        ));
      }
    }
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

  // 7. Append events to rolling log (keep last 200)
  if (events.length > 0) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...events].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }

  return state;
}

export async function getATCState(): Promise<ATCState> {
  const state = await loadJson<ATCState>(ATC_STATE_KEY);
  if (!state) {
    return {
      lastRunAt: new Date(0).toISOString(),
      activeExecutions: [],
      queuedItems: 0,
      recentEvents: [],
    };
  }
  return state;
}

export async function getATCEvents(limit = 20): Promise<ATCEvent[]> {
  const events = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
  return events.slice(-limit);
}

function makeEvent(
  type: ATCEvent["type"],
  workItemId: string,
  previousStatus: string | undefined,
  newStatus: string | undefined,
  details: string
): ATCEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    workItemId,
    details,
    previousStatus,
    newStatus,
  };
}
