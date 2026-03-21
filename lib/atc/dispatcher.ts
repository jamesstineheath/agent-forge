import { listWorkItems, listWorkItemsFull, getWorkItem, updateWorkItem, createWorkItem, getAllDispatchable, reconcileWorkItemIndex } from "../work-items";
import { listRepos, getRepo } from "../repos";
import { dispatchWorkItem } from "../orchestrator";
import type { ATCState, WorkItem, Priority } from "../types";
import type { CycleContext } from "./types";
import { GLOBAL_CONCURRENCY_LIMIT } from "./types";
import { parseEstimatedFiles, hasFileOverlap, HIGH_CHURN_FILES, makeEvent, dispatchSortComparator } from "./utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "./tracing";
import { queryTriagedBugs, updateBugPage, type TriagedBug, type BugSeverity } from "../bugs";
import { assignWavesSafe, type WaveSchedulerInput } from "../wave-scheduler";
import { emitWaveAssigned, emitWaveDispatched } from "./events";
import { createWaveFallbackEscalation } from "../escalation";

/**
 * Dispatch items that were blocked on a dependency that just resolved.
 * Called by the event reactor when a PR merges, to immediately dispatch
 * newly-unblocked items without waiting for the next cron cycle.
 */
export async function dispatchUnblockedItems(
  mergedItemId: string,
  targetRepo: string
): Promise<{ dispatched: string[] }> {
  const dispatched: string[] = [];

  // Find items that depend on the merged item
  const readyEntries = await listWorkItems({ status: "ready", targetRepo });
  if (readyEntries.length === 0) return { dispatched };

  // Load active executions for concurrency check
  const [executingEntries, reviewingEntries, retryingEntries] = await Promise.all([
    listWorkItems({ status: "executing" }),
    listWorkItems({ status: "reviewing" }),
    listWorkItems({ status: "retrying" }),
  ]);
  const totalActive = executingEntries.length + reviewingEntries.length + retryingEntries.length;

  if (totalActive >= GLOBAL_CONCURRENCY_LIMIT) return { dispatched };

  // Check repo concurrency
  const activeForRepo = [...executingEntries, ...reviewingEntries, ...retryingEntries]
    .filter((e) => {
      const entryShort = e.targetRepo.includes("/") ? e.targetRepo.split("/")[1] : e.targetRepo;
      const targetShort = targetRepo.includes("/") ? targetRepo.split("/")[1] : targetRepo;
      return e.targetRepo === targetRepo || entryShort === targetShort;
    }).length;

  const repoIndex = await listRepos();
  let repoLimit = 3; // default
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (repo?.fullName === targetRepo) {
      repoLimit = repo.concurrencyLimit;
      break;
    }
  }

  let slotsRemaining = Math.min(
    GLOBAL_CONCURRENCY_LIMIT - totalActive,
    repoLimit - activeForRepo
  );

  if (slotsRemaining <= 0) return { dispatched };

  for (const entry of readyEntries) {
    if (slotsRemaining <= 0) break;
    const item = await getWorkItem(entry.id);
    if (!item) continue;

    // Only dispatch items that actually depended on the merged item
    if (!item.dependencies.includes(mergedItemId)) continue;

    // Verify ALL dependencies are now resolved (not just the one that triggered)
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allResolved = depItems.every((dep) => dep !== null && (dep.status === "merged" || dep.status === "cancelled"));
    if (!allResolved) continue;

    try {
      const result = await dispatchWorkItem(item.id);
      dispatched.push(item.id);
      slotsRemaining--;
      console.log(`[event-reactor] dispatched unblocked item ${item.id} (branch: ${result.branch})`);
    } catch (err) {
      console.error(`[event-reactor] failed to dispatch unblocked item ${item.id}:`, err);
    }
  }

  return { dispatched };
}

function parsePriorityNumber(priority: string | undefined): number {
  if (!priority) return 99;
  const match = priority.match(/P(\d+)/i);
  return match ? parseInt(match[1], 10) : 99;
}

function computePrioritySkipped(
  dispatchedItem: WorkItem,
  otherItems: WorkItem[]
): { count: number; skippedItemIds: string[]; note: string } | undefined {
  const dispatchedPNum = parsePriorityNumber(dispatchedItem.priority);
  const dispatchedTime = dispatchedItem.createdAt;

  const skipped = otherItems.filter((item) => {
    const itemPNum = parsePriorityNumber(item.priority);
    const itemTime = item.createdAt;
    return itemPNum > dispatchedPNum && itemTime < dispatchedTime;
  });

  if (skipped.length === 0) return undefined;

  // Find most common priority among skipped items
  const pCounts = new Map<string, number>();
  for (const item of skipped) {
    const p = item.priority ?? "P1";
    pCounts.set(p, (pCounts.get(p) ?? 0) + 1);
  }
  let mostCommon = "P1";
  let maxCount = 0;
  for (const [p, count] of pCounts) {
    if (count > maxCount) {
      mostCommon = p;
      maxCount = count;
    }
  }

  return {
    count: skipped.length,
    skippedItemIds: skipped.map((i) => i.id),
    note: `${dispatchedItem.priority ?? "P1"} item dispatched ahead of ${skipped.length} earlier-queued ${mostCommon} item${skipped.length > 1 ? "s" : ""}`,
  };
}

// --- Notion Bug Ingestion ---

/** Map Notion severity to WorkItem priority. */
function severityToPriority(severity: BugSeverity): WorkItem["priority"] {
  switch (severity) {
    case "Critical":
    case "High":
      return "high";
    case "Medium":
      return "medium";
    case "Low":
      return "low";
    default:
      return "low";
  }
}

/** Map Notion severity to triage priority for dispatch ordering. */
function severityToTriagePriority(severity: BugSeverity): Priority {
  switch (severity) {
    case "Critical":
      return "P0";
    case "High":
      return "P1";
    case "Medium":
    case "Low":
      return "P2";
    default:
      return "P2";
  }
}

/**
 * Ingest triaged bugs from Notion, filtered by severity, creating work items
 * and counting them against available dispatch slots.
 *
 * @param ctx          Cycle context for event emission
 * @param slotsRemaining  Mutable object so mutations are visible to caller
 * @param concurrencyMap  Per-repo active execution counts
 * @param activeExecutions  Active execution list (appended to)
 * @param severityFilter   Which severities to process in this call
 */
async function dispatchTriagedBugs(
  ctx: CycleContext,
  slotsRemaining: { count: number },
  concurrencyMap: Map<string, number>,
  activeExecutions: ATCState["activeExecutions"],
  severityFilter: BugSeverity[],
): Promise<void> {
  if (slotsRemaining.count <= 0) return;

  let bugs: TriagedBug[];
  try {
    bugs = await queryTriagedBugs();
  } catch (err) {
    console.error("[dispatcher] Failed to query Notion bugs:", err);
    return;
  }

  // Filter to requested severities
  const filtered = bugs.filter((b) => severityFilter.includes(b.severity));
  if (filtered.length === 0) return;

  // Load all work items to check for duplicates via source.sourceId
  const allItems = await listWorkItemsFull();
  const existingBugSourceIds = new Set(
    allItems
      .filter((wi) => wi.triggeredBy === "notion-bug" && wi.source.sourceId)
      .map((wi) => wi.source.sourceId),
  );

  // Load repo configs for per-repo concurrency limits
  const repoIndex = await listRepos();
  const repoConfigByName = new Map<string, { concurrencyLimit: number }>();
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (repo) repoConfigByName.set(repo.fullName, repo);
  }

  for (const bug of filtered) {
    if (slotsRemaining.count <= 0) break;

    // Duplicate guard 1: Notion page already has a Work Item ID
    if (bug.workItemId) continue;

    // Duplicate guard 2: work item with this sourceId already exists in Postgres
    if (existingBugSourceIds.has(bug.id)) continue;

    // Check per-repo concurrency
    const repoKey = bug.targetRepo;
    const repoActive = concurrencyMap.get(repoKey) ?? 0;
    const repoConfig = repoConfigByName.get(repoKey);
    const perRepoCap = repoConfig?.concurrencyLimit ?? 3;
    if (repoActive >= perRepoCap) {
      ctx.events.push(
        makeEvent(
          "concurrency_block",
          "system",
          undefined,
          undefined,
          `Bug ${bug.title}: repo ${repoKey} at concurrency limit (${repoActive}/${perRepoCap})`,
        ),
      );
      continue;
    }

    try {
      const description = [
        bug.context,
        bug.affectedFiles.length > 0
          ? `\n\nAffected files: ${bug.affectedFiles.join(", ")}`
          : "",
      ].join("");

      const workItem = await createWorkItem({
        title: bug.title || `Bug: ${bug.id.slice(0, 8)}`,
        description: description || `Bug from Notion: ${bug.id}`,
        targetRepo: bug.targetRepo,
        source: {
          type: "direct",
          sourceId: bug.id,
        },
        priority: severityToPriority(bug.severity),
        riskLevel: "medium",
        complexity: "moderate",
        dependencies: [],
        triggeredBy: "notion-bug",
        triagePriority: severityToTriagePriority(bug.severity),
      });

      // createWorkItem sets status to "filed" — move to "ready"
      await updateWorkItem(workItem.id, {
        status: "ready",
        type: "bugfix",
      });

      // Update Notion bug page with work item ID + status
      try {
        await updateBugPage(bug.id, workItem.id);
      } catch (notionErr) {
        console.error(
          `[dispatcher] Created work item ${workItem.id} but failed to update Notion bug ${bug.id}:`,
          notionErr,
        );
      }

      // Track concurrency
      concurrencyMap.set(repoKey, repoActive + 1);
      activeExecutions.push({
        workItemId: workItem.id,
        targetRepo: bug.targetRepo,
        branch: "",
        status: "ready",
        startedAt: new Date().toISOString(),
        elapsedMinutes: 0,
        filesBeingModified: bug.affectedFiles,
      });
      slotsRemaining.count--;

      ctx.events.push(
        makeEvent(
          "auto_dispatch",
          workItem.id,
          "filed",
          "ready",
          `Bug ingested from Notion: ${bug.title} (${bug.severity})`,
          { priority: workItem.priority, rank: 1 },
        ),
      );

      console.log(
        `[dispatcher] Created work item ${workItem.id} for bug ${bug.id} (${bug.severity})`,
      );
    } catch (err) {
      console.error(
        `[dispatcher] Failed to create work item for bug ${bug.id}:`,
        err,
      );
    }
  }
}

/**
 * Dispatch a single work item with conflict detection. Returns 'dispatched', 'blocked', or 'failed'.
 * Extracted so it can be called both sequentially (fallback) and concurrently (wave dispatch).
 */
async function dispatchSingleItem(
  item: WorkItem,
  repoFullName: string,
  allCandidates: WorkItem[],
  trace: ReturnType<typeof startTrace>,
  events: ATCState["recentEvents"],
  now: Date,
  activeExecutions: ATCState["activeExecutions"],
): Promise<'dispatched' | 'blocked' | 'failed'> {
  const itemFiles = item.handoff?.content ? parseEstimatedFiles(item.handoff.content) : [];
  const repoActiveExecs = activeExecutions.filter((e) => e.targetRepo === repoFullName);
  const conflicting = repoActiveExecs.find((e) => hasFileOverlap(itemFiles, e.filesBeingModified));
  if (conflicting) {
    addDecision(trace, { workItemId: item.id, action: 'blocked', reason: `file overlap with ${conflicting.workItemId}` });
    events.push(
      makeEvent(
        "conflict",
        item.id,
        undefined,
        undefined,
        `Dispatch blocked: file overlap with active item ${conflicting.workItemId} in ${repoFullName}`
      )
    );
    return 'blocked';
  }

  const itemHighChurn = itemFiles.filter((f) => HIGH_CHURN_FILES.has(f));
  if (itemHighChurn.length > 0) {
    const highChurnConflict = activeExecutions.find((e) =>
      e.filesBeingModified.some((f) => itemHighChurn.includes(f))
    );
    if (highChurnConflict) {
      addDecision(trace, { workItemId: item.id, action: 'blocked', reason: `high-churn file overlap with ${highChurnConflict.workItemId}` });
      events.push(
        makeEvent(
          "conflict",
          item.id,
          undefined,
          undefined,
          `Dispatch blocked: high-churn file(s) [${itemHighChurn.join(", ")}] overlap with active item ${highChurnConflict.workItemId}`
        )
      );
      return 'blocked';
    }
  }

  try {
    const result = await dispatchWorkItem(item.id);
    const rank = allCandidates.indexOf(item) + 1;
    const prioritySkipped = computePrioritySkipped(item, allCandidates.filter((c) => c.id !== item.id));
    addDecision(trace, { workItemId: item.id, action: 'dispatched', reason: `dispatched to ${repoFullName} (branch: ${result.branch})` });
    events.push(
      makeEvent(
        "auto_dispatch",
        item.id,
        "ready",
        "executing",
        `Auto-dispatched to ${repoFullName} (branch: ${result.branch})`,
        { priority: item.priority, rank, ...(prioritySkipped ? { prioritySkipped } : {}) }
      )
    );
    activeExecutions.push({
      workItemId: item.id,
      targetRepo: repoFullName,
      branch: result.branch,
      status: "executing",
      startedAt: new Date().toISOString(),
      elapsedMinutes: 0,
      filesBeingModified: itemFiles,
    });
    return 'dispatched';
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    addDecision(trace, { workItemId: item.id, action: 'dispatch_failed', reason: msg });
    await updateWorkItem(item.id, {
      status: "failed",
      execution: {
        ...item.execution,
        completedAt: now.toISOString(),
        outcome: "failed",
      },
    });
    events.push(
      makeEvent("error", item.id, "ready", "failed", `Auto-dispatch failed: ${msg}`)
    );
    return 'failed';
  }
}

/**
 * Dispatcher agent: maximizes throughput within concurrency limits.
 *
 * Responsibilities:
 * - Phase 0: Index reconciliation
 * - Phase 1: Dispatch ready items (project + standalone)
 * - Conflict detection & concurrency enforcement
 */
export async function runDispatcher(ctx: CycleContext): Promise<ATCState["activeExecutions"]> {
  const { now, events } = ctx;

  // === EARLY EXIT: no ready items and no triaged bugs ===
  const readyEntries = await listWorkItems({ status: "ready" });
  if (readyEntries.length === 0) {
    console.log("[Dispatcher] No ready items — skipping cycle");
    return [];
  }
  // === END EARLY EXIT ===

  const trace = startTrace('dispatcher');
  let phaseStart = Date.now();

  try {

  // === PHASE 0: INDEX RECONCILIATION ===
  try {
    const reconcileResult = await reconcileWorkItemIndex();
    if (reconcileResult.repaired > 0) {
      console.warn("[dispatcher] index reconciliation repaired items", reconcileResult);
    }
    addPhase(trace, { name: 'index_reconciliation', durationMs: Date.now() - phaseStart, repaired: reconcileResult.repaired });
  } catch (err) {
    addError(trace, `index reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("[dispatcher] index reconciliation failed", err);
  }
  phaseStart = Date.now();

  // === PHASE 1: DISPATCH ===

  // 1. Load active work items (executing, reviewing, or retrying)
  const [executingEntries, reviewingEntries, retryingEntries] = await Promise.all([
    listWorkItems({ status: "executing" }),
    listWorkItems({ status: "reviewing" }),
    listWorkItems({ status: "retrying" }),
  ]);
  const activeEntries = [...executingEntries, ...reviewingEntries, ...retryingEntries];

  // 1.1: Build lightweight activeExecutions for dispatch (no GitHub API)
  const activeExecutions: ATCState["activeExecutions"] = [];
  for (const entry of activeEntries) {
    const item = await getWorkItem(entry.id);
    if (!item) continue;
    const branch = item.handoff?.branch;
    if (!branch) continue;
    const startedAt = item.execution?.startedAt;
    const elapsedMinutes = startedAt
      ? (now.getTime() - new Date(startedAt).getTime()) / 60_000
      : 0;
    let filesBeingModified: string[] = [];
    if (item.execution?.filesModified?.length) {
      filesBeingModified = item.execution.filesModified;
    } else if (item.handoff?.content) {
      filesBeingModified = parseEstimatedFiles(item.handoff.content);
    }
    activeExecutions.push({
      workItemId: item.id,
      targetRepo: item.targetRepo,
      branch,
      status: item.status,
      startedAt: startedAt ?? now.toISOString(),
      elapsedMinutes: Math.round(elapsedMinutes),
      filesBeingModified,
    });
  }

  // 1.2: Check concurrency per repo
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
        events.push(
          makeEvent(
            "concurrency_block",
            queuedForRepo[0].id,
            undefined,
            undefined,
            `Repo ${repo.fullName} at concurrency limit (${activeCount}/${repo.concurrencyLimit}); ${queuedForRepo.length} item(s) queued`
          )
        );
      }
    }
  }

  // 1.3a: Expedited dispatch (bypasses concurrency limits)
  let expeditedCount = 0;
  {
    const readyEntries = await listWorkItems({ status: "ready" });
    const expeditedItems: WorkItem[] = [];
    for (const entry of readyEntries) {
      const item = await getWorkItem(entry.id);
      if (item?.expedite) expeditedItems.push(item);
    }

    for (const item of expeditedItems) {
      try {
        const result = await dispatchWorkItem(item.id);
        console.log(`[dispatcher] ⚡ expedited dispatch: ${item.title} (bypassing concurrency limits)`);
        addDecision(trace, { workItemId: item.id, action: 'dispatched', reason: `expedited dispatch to ${item.targetRepo} (branch: ${result.branch})` });
        events.push(
          makeEvent(
            "auto_dispatch",
            item.id,
            "ready",
            "executing",
            `⚡ Expedited dispatch to ${item.targetRepo} (branch: ${result.branch})`,
            { priority: item.priority, rank: 1 }
          )
        );
        expeditedCount++;
        // Count toward running totals so normal dispatch doesn't over-dispatch
        concurrencyMap.set(item.targetRepo, (concurrencyMap.get(item.targetRepo) ?? 0) + 1);
        activeExecutions.push({
          workItemId: item.id,
          targetRepo: item.targetRepo,
          branch: result.branch,
          status: "executing",
          startedAt: new Date().toISOString(),
          elapsedMinutes: 0,
          filesBeingModified: item.handoff?.content ? parseEstimatedFiles(item.handoff.content) : [],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        addDecision(trace, { workItemId: item.id, action: 'dispatch_failed', reason: `expedited dispatch failed: ${msg}` });
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(
          makeEvent("error", item.id, "ready", "failed", `Expedited dispatch failed: ${msg}`)
        );
      }
    }
  }

  // 1.3b: Auto-dispatch (normal, respects concurrency)
  const totalActive = activeExecutions.filter(
    (e) => e.status === "executing" || e.status === "reviewing" || e.status === "retrying"
  ).length;

  let slotsRemaining = GLOBAL_CONCURRENCY_LIMIT - totalActive;

  // --- Critical bugs BEFORE PRD work items ---
  const slotsObj = { count: slotsRemaining };
  await dispatchTriagedBugs(ctx, slotsObj, concurrencyMap, activeExecutions, ["Critical"]);
  slotsRemaining = slotsObj.count;

  if (totalActive < GLOBAL_CONCURRENCY_LIMIT) {
    for (const repoEntry of repoIndex) {
      if (slotsRemaining <= 0) break;
      const repo = await getRepo(repoEntry.id);
      if (!repo) continue;
      const activeCount = concurrencyMap.get(repo.fullName) ?? 0;
      const repoSlotsAvailable = repo.concurrencyLimit - activeCount;
      if (repoSlotsAvailable <= 0) continue;

      const candidates = await getAllDispatchable(repo.fullName);
      if (candidates.length === 0) {
        const readyForRepo = await listWorkItems({ status: "ready", targetRepo: repo.fullName });
        if (readyForRepo.length > 0) {
          console.log(
            `[dispatcher] ${repo.fullName}: ${readyForRepo.length} ready items, 0 dispatchable (all blocked by deps or conflicts)`
          );
        }
        continue;
      }

      console.log(
        `[dispatcher] ${repo.fullName}: ${candidates.length} dispatchable candidate(s), ${slotsRemaining} slot(s) available`
      );

      // Sort eligible items by priority (P0 first), then rank (lower = higher precedence),
      // then createdAt (earliest first). Legacy items without priority/rank default to P1/999.
      candidates.sort(dispatchSortComparator);

      // --- Wave scheduling ---
      // Convert candidates to WaveSchedulerInput format
      const waveInputs: WaveSchedulerInput[] = candidates.map((item) => ({
        id: item.id,
        dependsOn: item.dependencies,
        filesBeingModified: item.handoff?.content ? parseEstimatedFiles(item.handoff.content) : [],
        createdAt: new Date(item.createdAt),
      }));

      const { assignments, fallback, error: waveError } = assignWavesSafe(waveInputs);

      // Build lookup: workItemId → waveNumber
      const waveMap = new Map<string, number>();
      for (const a of assignments) {
        waveMap.set(a.workItemId, a.waveNumber);
      }
      const totalWaves = assignments.length > 0 ? Math.max(...assignments.map((a) => a.waveNumber)) + 1 : 1;

      if (fallback) {
        // Fallback: sequential dispatch + escalation
        console.warn(`[dispatcher] Wave scheduler fallback for ${repo.fullName}: ${waveError}`);
        addDecision(trace, { workItemId: candidates[0]?.id ?? 'unknown', action: 'dispatched', reason: `wave scheduler fallback — sequential dispatch (error: ${waveError})` });

        // Create escalation (fire-and-forget to not block dispatch)
        const projectId = candidates[0]?.source.sourceId ?? repo.fullName;
        createWaveFallbackEscalation(projectId, waveError ?? 'unknown error').catch((err) =>
          console.error('[dispatcher] Failed to create wave fallback escalation:', err)
        );

        // Sequential fallback: dispatch one at a time (existing behavior)
        const toDispatch = candidates.slice(0, Math.min(slotsRemaining, repoSlotsAvailable));
        for (const item of toDispatch) {
          const dispatchResult = await dispatchSingleItem(item, repo.fullName, candidates, trace, events, now, activeExecutions);
          if (dispatchResult === 'dispatched') {
            slotsRemaining--;
            concurrencyMap.set(repo.fullName, (concurrencyMap.get(repo.fullName) ?? 0) + 1);
          }
        }
      } else {
        // Persist waveNumber on each work item
        await Promise.allSettled(
          candidates.map((item) => {
            const waveNum = waveMap.get(item.id) ?? 0;
            return updateWorkItem(item.id, { waveNumber: waveNum });
          })
        );

        // Emit wave:assigned event
        const projectId = candidates[0]?.source.sourceId ?? repo.fullName;
        await emitWaveAssigned(
          projectId,
          0, // current wave being assigned
          candidates.map((i) => i.id),
          totalWaves,
        );

        // Find lowest incomplete wave (items not yet in terminal/executing states)
        const TERMINAL_STATES = new Set(['merged', 'verified', 'failed', 'parked', 'cancelled', 'executing', 'reviewing', 'retrying']);
        const incompleteWaveNums = [
          ...new Set(
            candidates
              .filter((item) => !TERMINAL_STATES.has(item.status))
              .map((item) => waveMap.get(item.id) ?? 0)
          ),
        ].sort((a, b) => a - b);

        const currentWaveNum = incompleteWaveNums[0];
        if (currentWaveNum === undefined) continue; // all waves complete

        // Get items in current wave
        const waveItems = candidates.filter(
          (item) => waveMap.get(item.id) === currentWaveNum && !TERMINAL_STATES.has(item.status)
        );

        // Apply concurrency budget
        const budget = Math.min(slotsRemaining, repoSlotsAvailable, waveItems.length);
        const itemsToDispatch = waveItems.slice(0, budget);

        if (itemsToDispatch.length === 0) continue;

        console.log(
          `[dispatcher] ${repo.fullName}: dispatching wave ${currentWaveNum}/${totalWaves - 1} with ${itemsToDispatch.length} item(s) concurrently`
        );

        // Dispatch all items in current wave concurrently
        const dispatchResults = await Promise.allSettled(
          itemsToDispatch.map((item) =>
            dispatchSingleItem(item, repo.fullName, candidates, trace, events, now, activeExecutions)
          )
        );

        // Count successful dispatches and update concurrency tracking
        const waveDispatchResults: Array<{ id: string; status: 'dispatched' | 'failed'; error?: string }> = [];
        let concurrentDispatches = 0;
        for (let i = 0; i < dispatchResults.length; i++) {
          const result = dispatchResults[i];
          const item = itemsToDispatch[i];
          if (result.status === 'fulfilled' && result.value === 'dispatched') {
            slotsRemaining--;
            concurrencyMap.set(repo.fullName, (concurrencyMap.get(repo.fullName) ?? 0) + 1);
            concurrentDispatches++;
            waveDispatchResults.push({ id: item.id, status: 'dispatched' });
          } else {
            const error = result.status === 'rejected' ? String(result.reason) : 'blocked or failed';
            waveDispatchResults.push({ id: item.id, status: 'failed', error });
          }
        }

        // Emit wave:dispatched event
        await emitWaveDispatched(
          projectId,
          currentWaveNum,
          itemsToDispatch.length,
          concurrentDispatches,
        );
      }
    }

    // --- Standalone item dispatch (fast lane) ---
    const [directFiledEntries, directReadyEntries] = await Promise.all([
      listWorkItems({ status: "filed" }),
      listWorkItems({ status: "ready" }),
    ]);
    const directCandidateEntries = [...directFiledEntries, ...directReadyEntries];

    const repoConfigByName = new Map<string, { concurrencyLimit: number }>();
    for (const repoEntry of repoIndex) {
      const repo = await getRepo(repoEntry.id);
      if (repo) repoConfigByName.set(repo.fullName, repo);
    }

    for (const entry of directCandidateEntries) {
      if (slotsRemaining <= 0) break;

      const item = await getWorkItem(entry.id);
      if (!item || item.source.type === "project") continue;

      const activeForRepo = concurrencyMap.get(item.targetRepo) ?? 0;
      const repoConfig = repoConfigByName.get(item.targetRepo);
      const limit = repoConfig?.concurrencyLimit ?? 1;

      if (activeForRepo >= limit) {
        console.log(
          `[dispatcher] Repo ${item.targetRepo} at concurrency limit, skipping standalone item: ${item.id}`
        );
        continue;
      }

      if (item.status === "filed") {
        await updateWorkItem(item.id, { status: "ready" });
      }

      console.log(
        `[dispatcher] Dispatching standalone item: ${item.id} (source: ${item.source.type})`
      );
      try {
        const result = await dispatchWorkItem(item.id);
        addDecision(trace, { workItemId: item.id, action: 'dispatched', reason: `standalone item dispatched to ${item.targetRepo} (branch: ${result.branch})` });
        events.push(
          makeEvent(
            "auto_dispatch",
            item.id,
            item.status,
            "executing",
            `Auto-dispatched standalone item (source: ${item.source.type}) to ${item.targetRepo} (branch: ${result.branch})`,
            { priority: item.priority, rank: 1 }
          )
        );
        slotsRemaining--;
        concurrencyMap.set(item.targetRepo, (concurrencyMap.get(item.targetRepo) ?? 0) + 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        addDecision(trace, { workItemId: item.id, action: 'dispatch_failed', reason: `standalone dispatch failed: ${msg}` });
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(
          makeEvent("error", item.id, "ready", "failed", `Standalone item auto-dispatch failed: ${msg}`)
        );
      }
    }
  } else {
    console.log(
      `[dispatcher] Global concurrency limit reached (${totalActive}/${GLOBAL_CONCURRENCY_LIMIT}), skipping dispatch`
    );
  }

  // --- High/Medium/Low bugs AFTER PRD work items ---
  slotsObj.count = slotsRemaining;
  await dispatchTriagedBugs(ctx, slotsObj, concurrencyMap, activeExecutions, ["High", "Medium", "Low"]);
  slotsRemaining = slotsObj.count;

  addPhase(trace, { name: 'dispatch', durationMs: Date.now() - phaseStart, decisions: trace.decisions.length });

  const dispatched = trace.decisions.filter(d => d.action === 'dispatched').length;
  const blocked = trace.decisions.filter(d => d.action === 'blocked').length;
  completeTrace(trace, 'success', `Dispatched ${dispatched} items (${expeditedCount} expedited), blocked ${blocked}`);
  return activeExecutions;

  } catch (err) {
    addError(trace, String(err));
    completeTrace(trace, 'error');
    throw err;
  } finally {
    try {
      await persistTrace(trace);
      await cleanupOldTraces('dispatcher', 7);
    } catch (tracingErr) {
      console.error('[Dispatcher] Tracing failed (non-fatal):', tracingErr);
    }
  }
}
