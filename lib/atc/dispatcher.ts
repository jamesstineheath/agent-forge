import { listWorkItems, getWorkItem, updateWorkItem, getAllDispatchable, reconcileWorkItemIndex } from "../work-items";
import { listRepos, getRepo } from "../repos";
import { pushFile } from "../github";
import { dispatchWorkItem } from "../orchestrator";
import type { ATCState, WorkItem } from "../types";
import type { CycleContext } from "./types";
import { GLOBAL_CONCURRENCY_LIMIT } from "./types";
import { parseEstimatedFiles, hasFileOverlap, HIGH_CHURN_FILES, makeEvent } from "./utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "./tracing";

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

/**
 * Dispatcher agent: maximizes throughput within concurrency limits.
 *
 * Responsibilities:
 * - Phase 0: Index reconciliation
 * - Phase 1: Dispatch ready items (project + standalone)
 * - Conflict detection & concurrency enforcement
 * - active-work-items.md updates
 */
export async function runDispatcher(ctx: CycleContext): Promise<ATCState["activeExecutions"]> {
  const { now, events } = ctx;
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
            `⚡ Expedited dispatch to ${item.targetRepo} (branch: ${result.branch})`
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

      const toDispatch = candidates.slice(0, Math.min(slotsRemaining, repoSlotsAvailable));

      for (const item of toDispatch) {
        const itemFiles = item.handoff?.content ? parseEstimatedFiles(item.handoff.content) : [];
        const repoActiveExecs = activeExecutions.filter((e) => e.targetRepo === repo.fullName);
        const conflicting = repoActiveExecs.find((e) => hasFileOverlap(itemFiles, e.filesBeingModified));
        if (conflicting) {
          addDecision(trace, { workItemId: item.id, action: 'blocked', reason: `file overlap with ${conflicting.workItemId}` });
          events.push(
            makeEvent(
              "conflict",
              item.id,
              undefined,
              undefined,
              `Dispatch blocked: file overlap with active item ${conflicting.workItemId} in ${repo.fullName}`
            )
          );
          continue;
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
            continue;
          }
        }

        try {
          const result = await dispatchWorkItem(item.id);
          addDecision(trace, { workItemId: item.id, action: 'dispatched', reason: `dispatched to ${repo.fullName} (branch: ${result.branch})` });
          events.push(
            makeEvent(
              "auto_dispatch",
              item.id,
              "ready",
              "executing",
              `Auto-dispatched to ${repo.fullName} (branch: ${result.branch})`
            )
          );
          slotsRemaining--;
          concurrencyMap.set(repo.fullName, (concurrencyMap.get(repo.fullName) ?? 0) + 1);
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
        }
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
            `Auto-dispatched standalone item (source: ${item.source.type}) to ${item.targetRepo} (branch: ${result.branch})`
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

  addPhase(trace, { name: 'dispatch', durationMs: Date.now() - phaseStart, decisions: trace.decisions.length });
  phaseStart = Date.now();

  // 1.4: Update active-work-items.md in each repo
  try {
    const activeItems = await Promise.all([
      listWorkItems({ status: "executing" }),
      listWorkItems({ status: "reviewing" }),
      listWorkItems({ status: "retrying" }),
      listWorkItems({ status: "ready" }),
    ]);
    const [executingItems, reviewingItems, retryingItems, readyItems] = activeItems;

    const lines: string[] = [
      "# Active Work Items",
      "",
      "> Auto-generated by ATC. Do not edit manually.",
      "",
    ];

    if (executingItems.length > 0) {
      lines.push("## Currently Executing", "");
      for (const entry of executingItems) {
        const item = await getWorkItem(entry.id);
        if (!item) continue;
        const files = item.handoff?.content ? parseEstimatedFiles(item.handoff.content) : [];
        lines.push(`- **${item.title}** (${item.targetRepo})`);
        lines.push(`  - Branch: \`${item.handoff?.branch ?? "unknown"}\``);
        if (files.length > 0) lines.push(`  - Files: ${files.join(", ")}`);
        lines.push(`  - Started: ${item.execution?.startedAt ?? "unknown"}`);
        lines.push("");
      }
    }

    if (reviewingItems.length > 0) {
      lines.push("## In Review", "");
      for (const entry of reviewingItems) {
        const item = await getWorkItem(entry.id);
        if (!item) continue;
        const files = item.execution?.filesModified ?? [];
        lines.push(`- **${item.title}** (${item.targetRepo})`);
        lines.push(`  - Branch: \`${item.handoff?.branch ?? "unknown"}\``);
        if (item.execution?.prUrl) lines.push(`  - PR: ${item.execution.prUrl}`);
        if (files.length > 0) lines.push(`  - Files: ${files.join(", ")}`);
        lines.push("");
      }
    }

    if (retryingItems.length > 0) {
      lines.push("## Retrying", "");
      for (const entry of retryingItems) {
        const item = await getWorkItem(entry.id);
        if (!item) continue;
        lines.push(`- **${item.title}** (${item.targetRepo})`);
        lines.push(`  - Branch: \`${item.handoff?.branch ?? "unknown"}\``);
        lines.push(`  - Retry: ${item.execution?.retryCount ?? "?"}`);
        lines.push("");
      }
    }

    if (readyItems.length > 0) {
      lines.push("## Queued for Dispatch", "");
      for (const entry of readyItems) {
        const item = await getWorkItem(entry.id);
        if (!item) continue;
        const files = item.handoff?.content ? parseEstimatedFiles(item.handoff.content) : [];
        lines.push(`- **${item.title}** (${item.targetRepo})`);
        if (files.length > 0) lines.push(`  - Estimated files: ${files.join(", ")}`);
        lines.push("");
      }
    }

    if (executingItems.length === 0 && reviewingItems.length === 0 && retryingItems.length === 0 && readyItems.length === 0) {
      lines.push("*No active work items.*", "");
    }

    const activeWorkItemsMd = lines.join("\n");

    for (const repoEntry of repoIndex) {
      const repo = await getRepo(repoEntry.id);
      if (!repo) continue;
      try {
        const { pushed } = await pushFile(
          repo.fullName,
          "main",
          "docs/active-work-items.md",
          activeWorkItemsMd,
          "chore: update active work items [skip ci]",
          { skipIfUnchanged: true }
        );
        if (!pushed) {
          console.log(`[dispatcher] active-work-items.md unchanged in ${repo.fullName}, skipped push`);
        }
      } catch (pushErr) {
        console.warn(`[dispatcher] Failed to update active-work-items.md in ${repo.fullName}:`, pushErr);
      }
    }
  } catch (err) {
    console.error("[dispatcher] active-work-items.md generation failed:", err);
  }

  addPhase(trace, { name: 'active_work_items_update', durationMs: Date.now() - phaseStart });

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
      await cleanupOldTraces('dispatcher');
    } catch (tracingErr) {
      console.error('[Dispatcher] Tracing failed (non-fatal):', tracingErr);
    }
  }
}
