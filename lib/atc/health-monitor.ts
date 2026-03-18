import { listWorkItems, getWorkItem, updateWorkItem } from "../work-items";
import { listRepos, getRepo } from "../repos";
import {
  getWorkflowRuns,
  getPRByBranch,
  getPRByNumber,
  getPRFiles,
  getPRMergeability,
  rebasePR,
  closePRWithReason,
  deleteBranch,
  triggerWorkflow,
} from "../github";
import { escalate } from "../escalation";
import { incrementalIndex } from "../knowledge-graph/indexer";
import type { ATCEvent, ATCState, WorkItem } from "../types";
import type { CycleContext } from "./types";
import {
  STALL_TIMEOUT_EXECUTING_NO_RUN_MINUTES,
  STALL_TIMEOUT_EXECUTING_WITH_RUN_MINUTES,
  STALL_TIMEOUT_REVIEWING_NO_PR_MINUTES,
  CONFLICT_CHECK_DELAY_MINUTES,
  MAX_RETRIES,
} from "./types";
import { parseEstimatedFiles, makeEvent } from "./utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "./tracing";
export { classifyCIFailure } from "./ci-classifier";
export type { CIFailureClassification } from "./ci-classifier";

// Default code-CI retry budget (distinct from general MAX_RETRIES which resets to ready)
const CODE_CI_RETRY_BUDGET_DEFAULT = 1;

// Idempotency window: don't re-trigger a code retry within this window
const CODE_RETRY_IDEMPOTENCY_MINUTES = 15;

/**
 * Stub CI failure classifier.
 * TODO: replace with real classifier from CI failure classifier work item once merged.
 */
function classifyCIFailure(conclusion: string | null): { type: 'code' | 'infra' | 'flaky'; errorLogs: string } {
  // Treat all non-success, non-skipped failures as 'code' until classifier is merged
  return {
    type: 'code',
    errorLogs: `Workflow failed with conclusion: ${conclusion ?? 'unknown'}`,
  };
}

/**
 * Handle a CI failure classified as 'code' by triggering a re-execution or escalating.
 */
export async function handleCodeCIFailure(
  item: WorkItem,
  errorLogs: string,
  ctx: CycleContext
): Promise<void> {
  const retryBudget = item.retryBudget ?? CODE_CI_RETRY_BUDGET_DEFAULT;
  const retryCount = item.execution?.retryCount ?? 0;

  if (retryCount < retryBudget) {
    // Idempotency guard: check if a retry was recently triggered
    const recentRetryEvent = ctx.events.find(
      (e) =>
        e.workItemId === item.id &&
        e.type === 'ci_code_retry_triggered' as ATCEvent['type'] &&
        (Date.now() - new Date(e.timestamp).getTime()) < CODE_RETRY_IDEMPOTENCY_MINUTES * 60_000
    );
    if (recentRetryEvent) {
      console.log(
        `[HealthMonitor] Skipping duplicate code retry for ${item.id} — triggered ${CODE_RETRY_IDEMPOTENCY_MINUTES}min ago`
      );
      return;
    }

    const retryContext = JSON.stringify({
      previousAttempt: retryCount + 1,
      errorLogs: errorLogs.slice(0, 4000),
      workItemId: item.id,
      timestamp: new Date().toISOString(),
    });

    const branch = item.handoff?.branch;
    if (!branch) {
      console.warn(`[HealthMonitor] Cannot retry ${item.id} — no handoff branch`);
      return;
    }

    try {
      // Dispatch against 'main' (not the PR branch) so the workflow file has the correct inputs.
      // The handoff_file input tells the executor which branch/handoff to work on.
      await triggerWorkflow(
        item.targetRepo,
        'execute-handoff.yml',
        'main',
        {
          branch,
          handoff_file: item.handoff?.content ? `handoffs/${item.id}.md` : '',
        }
      );

      await updateWorkItem(item.id, {
        execution: {
          ...item.execution,
          retryCount: retryCount + 1,
        },
      });

      const event = makeEvent(
        'ci_code_retry_triggered' as ATCEvent['type'],
        item.id,
        item.status,
        item.status,
        `Code CI retry ${retryCount + 1}/${retryBudget}: re-dispatched execute-handoff with error context`
      );
      ctx.events.push(event);

      console.log(
        `[HealthMonitor] ci.code_retry_triggered workItem=${item.id} attempt=${retryCount + 1}/${retryBudget}`
      );
    } catch (retryErr) {
      // Non-fatal: log the error but don't crash the entire Health Monitor cycle
      console.error(
        `[HealthMonitor] Code CI retry dispatch failed for ${item.id} (non-fatal):`,
        retryErr instanceof Error ? retryErr.message : String(retryErr)
      );
    }
  } else {
    // Budget exhausted — mark failed and escalate
    await updateWorkItem(item.id, { status: 'failed' });

    await escalate(
      item.id,
      `CI failed with code error after ${retryCount} retry attempt(s). Manual intervention required.`,
      0.8,
      {
        errorContext: errorLogs.slice(0, 2000),
        retryCount,
        retryBudget,
      }
    );

    const event = makeEvent(
      'ci_code_retry_exhausted' as ATCEvent['type'],
      item.id,
      item.status,
      'failed',
      `Code CI retry budget exhausted (${retryCount}/${retryBudget}). Escalation created.`
    );
    ctx.events.push(event);

    console.log(
      `[HealthMonitor] ci.code_retry_exhausted workItem=${item.id} — marked failed, escalation created`
    );
  }
}

/**
 * Health Monitor agent: ensures every active execution progresses or gets unstuck.
 *
 * Responsibilities:
 * - Phase 2: Poll active items with GitHub API
 * - Stall/timeout detection
 * - Merge conflict recovery (§2.7) + auto-rebase
 * - Failed item reconciliation (§2.8)
 * - Dependency management (§4.1)
 * - Auto-cancel obsolete remediation items (§3.4)
 * - Retry failed items (§3.5)
 * - Re-evaluate failed items with resolved deps (§3.6)
 */
export async function runHealthMonitor(ctx: CycleContext): Promise<ATCState["activeExecutions"]> {
  const { now, events } = ctx;
  const trace = startTrace('health-monitor');
  let phaseStart = Date.now();

  try {

  // Load active work items
  const [executingEntries, reviewingEntries] = await Promise.all([
    listWorkItems({ status: "executing" }),
    listWorkItems({ status: "reviewing" }),
  ]);
  const activeEntries = [...executingEntries, ...reviewingEntries];

  // === PHASE 2: MONITORING ===
  const activeExecutions: ATCState["activeExecutions"] = [];

  for (const entry of activeEntries) {
    const item = await getWorkItem(entry.id);
    if (!item) continue;

    const branch = item.handoff?.branch;
    const startedAt = item.execution?.startedAt;
    if (!branch) continue;

    const elapsedMinutes = startedAt
      ? (now.getTime() - new Date(startedAt).getTime()) / 60_000
      : 0;

    // Stage-aware stall timeout check
    const hasOpenPR = item.status === "reviewing" && item.execution?.prNumber != null;
    const stallTimeout =
      item.status === "reviewing"
        ? STALL_TIMEOUT_REVIEWING_NO_PR_MINUTES
        : STALL_TIMEOUT_EXECUTING_NO_RUN_MINUTES;
    if (elapsedMinutes >= stallTimeout && !hasOpenPR) {
      const event = makeEvent(
        "timeout",
        item.id,
        item.status,
        "failed",
        `Execution stalled: no progress for ${Math.round(elapsedMinutes)} minutes (reason: timeout)`
      );
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

    // Populate filesBeingModified
    let filesBeingModified: string[] = [];
    if (pr && item.execution?.prNumber) {
      filesBeingModified = await getPRFiles(item.targetRepo, item.execution.prNumber);
      if (filesBeingModified.length > 0 && !item.execution?.filesModified?.length) {
        await updateWorkItem(item.id, {
          execution: { ...item.execution, filesModified: filesBeingModified },
        });
      }
    } else if (item.execution?.filesModified?.length) {
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

    if (item.status === "executing") {
      // Handle 'skipped' conclusion as ambiguous: the workflow may have been
      // skipped due to a workflow_run trigger with a non-matching condition,
      // while a prior workflow_dispatch run already created a PR.
      if (
        latestRun?.status === "completed" &&
        latestRun.conclusion === "skipped" &&
        pr
      ) {
        // A PR exists on this branch — the execution likely succeeded via a
        // prior run. Treat as success rather than failure.
        const event = makeEvent(
          "work_item_reconciled",
          item.id,
          "executing",
          "reviewing",
          `Workflow run ${latestRun.id} concluded 'skipped' but PR #${pr.number} exists — reconciling to reviewing`
        );
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
      } else if (
        latestRun?.status === "completed" &&
        latestRun.conclusion === "skipped" &&
        !pr
      ) {
        // Skipped and no PR — check if the run was long enough to suggest
        // actual execution happened (> 2 minutes)
        const durationMs =
          new Date(latestRun.updatedAt).getTime() - new Date(latestRun.createdAt).getTime();
        if (durationMs > 2 * 60 * 1000 || item.handoff?.branch) {
          // Ambiguous skip: ran for a while or has a branch — try to find a PR
          const reconcilePr = await getPRByBranch(item.targetRepo, branch);
          if (reconcilePr) {
            const event = makeEvent(
              "work_item_reconciled",
              item.id,
              "executing",
              "reviewing",
              `Workflow concluded 'skipped' but found PR #${reconcilePr.number} via branch lookup — reconciling`
            );
            await updateWorkItem(item.id, {
              status: "reviewing",
              execution: {
                ...item.execution,
                workflowRunId: latestRun.id,
                prNumber: reconcilePr.number,
                prUrl: reconcilePr.htmlUrl,
              },
            });
            events.push(event);
          } else {
            // No PR found after ambiguous skip — mark failed
            const event = makeEvent(
              "status_change",
              item.id,
              "executing",
              "failed",
              `Workflow run ${latestRun.id} concluded 'skipped', no PR found (reason: no_pr_after_execution)`
            );
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
          }
        } else {
          // Truly skipped (short run, no branch) — mark failed
          const event = makeEvent(
            "status_change",
            item.id,
            "executing",
            "failed",
            `Workflow run ${latestRun.id} concluded 'skipped' (reason: workflow_failed)`
          );
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
        }
      } else if (pr?.mergedAt) {
        const event = makeEvent("status_change", item.id, "executing", "merged", `PR #${pr.number} merged`);
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

        // Trigger incremental re-index on PR merge
        try {
          const mergedPrFiles = await getPRFiles(item.targetRepo, pr.number);
          if (mergedPrFiles.length > 0) {
            const indexResult = await incrementalIndex(item.targetRepo, mergedPrFiles);
            console.log(
              `[health-monitor] Incremental re-index for ${item.targetRepo}: ${mergedPrFiles.length} files from PR #${pr.number}, ${indexResult.entitiesUpdated} entities updated`
            );
          }
        } catch (indexErr) {
          console.warn(
            `[health-monitor] Incremental re-index failed for PR #${pr.number}:`,
            indexErr instanceof Error ? indexErr.message : String(indexErr)
          );
        }
      } else if (pr?.state === "closed" && !pr.mergedAt) {
        const event = makeEvent(
          "status_change",
          item.id,
          "executing",
          "failed",
          `PR #${pr.number} closed without merge (reason: pr_closed)`
        );
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
        const event = makeEvent(
          "status_change",
          item.id,
          "executing",
          "reviewing",
          `Workflow run ${latestRun.id} completed successfully, PR #${pr.number} open`
        );
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
      } else if (
        latestRun?.status === "completed" &&
        latestRun.conclusion !== "success" &&
        latestRun.conclusion !== "skipped" &&
        latestRun.conclusion !== null
      ) {
        // Classify the CI failure and attempt code retry if eligible
        const { type: failureType, errorLogs } = classifyCIFailure(latestRun.conclusion);
        const retryBudget = item.retryBudget ?? CODE_CI_RETRY_BUDGET_DEFAULT;
        const currentRetryCount = item.execution?.retryCount ?? 0;

        if (failureType === 'code' && currentRetryCount < retryBudget) {
          // Update workflow run info before retry
          await updateWorkItem(item.id, {
            execution: {
              ...item.execution,
              workflowRunId: latestRun.id,
            },
          });
          // Re-fetch item with updated execution data
          const updatedItem = await getWorkItem(item.id);
          if (updatedItem) {
            await handleCodeCIFailure(updatedItem, errorLogs, ctx);
          }
        } else {
          const event = makeEvent(
            "status_change",
            item.id,
            "executing",
            "failed",
            `Workflow run ${latestRun.id} failed with conclusion: ${latestRun.conclusion} (reason: workflow_failed)`
          );
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

          // If code failure with exhausted budget, escalate
          if (failureType === 'code' && currentRetryCount >= retryBudget) {
            await handleCodeCIFailure(item, errorLogs, ctx);
          }
        }
      } else if (
        latestRun &&
        latestRun.status !== "completed" &&
        elapsedMinutes >= STALL_TIMEOUT_EXECUTING_WITH_RUN_MINUTES
      ) {
        const event = makeEvent(
          "timeout",
          item.id,
          "executing",
          "failed",
          `Workflow run ${latestRun.id} in progress for ${Math.round(elapsedMinutes)} minutes (reason: timeout)`
        );
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
      } else if (!latestRun && elapsedMinutes >= STALL_TIMEOUT_EXECUTING_NO_RUN_MINUTES) {
        const event = makeEvent(
          "timeout",
          item.id,
          "executing",
          "failed",
          `No workflow run found after ${Math.round(elapsedMinutes)} minutes (reason: timeout)`
        );
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
        const event = makeEvent("status_change", item.id, "reviewing", "merged", `PR #${pr.number} merged`);
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

        // Trigger incremental re-index on PR merge
        try {
          const mergedPrFiles = await getPRFiles(item.targetRepo, pr.number);
          if (mergedPrFiles.length > 0) {
            const indexResult = await incrementalIndex(item.targetRepo, mergedPrFiles);
            console.log(
              `[health-monitor] Incremental re-index for ${item.targetRepo}: ${mergedPrFiles.length} files from PR #${pr.number}, ${indexResult.entitiesUpdated} entities updated`
            );
          }
        } catch (indexErr) {
          console.warn(
            `[health-monitor] Incremental re-index failed for PR #${pr.number}:`,
            indexErr instanceof Error ? indexErr.message : String(indexErr)
          );
        }
      } else if (pr?.state === "closed" && !pr.mergedAt) {
        const event = makeEvent(
          "status_change",
          item.id,
          "reviewing",
          "failed",
          `PR #${pr.number} closed without merge (reason: pr_closed)`
        );
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
      } else if (pr?.state === "open" && elapsedMinutes >= CONFLICT_CHECK_DELAY_MINUTES) {
        // §2.7: Merge conflict detection
        const prNumber = item.execution?.prNumber ?? pr.number;
        const mergeability = await getPRMergeability(item.targetRepo, prNumber);

        if (mergeability.mergeable === false && mergeability.mergeableState === "dirty") {
          const [owner, repoName] = item.targetRepo.split("/");
          const rebaseResult = await rebasePR(owner, repoName, prNumber);

          if (rebaseResult.success) {
            events.push(
              makeEvent(
                "conflict",
                item.id,
                "reviewing",
                "reviewing",
                `PR #${prNumber} had merge conflict, auto-rebased successfully`
              )
            );
          } else {
            try {
              await closePRWithReason(
                owner,
                repoName,
                prNumber,
                "merge_conflicts",
                `Auto-rebase failed: ${rebaseResult.error}. Work item will be re-dispatched.`
              );
            } catch (closeErr) {
              console.warn(`[health-monitor] Failed to close conflicted PR #${prNumber}:`, closeErr);
            }
            const event = makeEvent(
              "conflict",
              item.id,
              "reviewing",
              "failed",
              `PR #${prNumber} merge conflict unresolvable (${rebaseResult.error}), closed for re-dispatch`
            );
            await updateWorkItem(item.id, {
              status: "failed",
              failureCategory: "transient",
              execution: {
                ...item.execution,
                prNumber,
                prUrl: pr.htmlUrl,
                completedAt: now.toISOString(),
                outcome: "failed",
              },
            });
            events.push(event);
          }
        } else if (mergeability.mergeableState === "behind") {
          const [owner, repoName] = item.targetRepo.split("/");
          const rebaseResult = await rebasePR(owner, repoName, prNumber);
          if (rebaseResult.success) {
            events.push(
              makeEvent(
                "conflict",
                item.id,
                "reviewing",
                "reviewing",
                `PR #${prNumber} was behind base, auto-rebased`
              )
            );
          }
        }
      }
    }
  }

  addPhase(trace, { name: 'monitoring', durationMs: Date.now() - phaseStart, activeItems: activeEntries.length });
  phaseStart = Date.now();

  // 2.5: Generating timeout detection
  const GENERATING_TIMEOUT_MINUTES = 15;
  const generatingEntries = await listWorkItems({ status: "generating" as any });
  for (const entry of generatingEntries) {
    const item = await getWorkItem(entry.id);
    if (!item) continue;
    const elapsed = (now.getTime() - new Date(item.updatedAt).getTime()) / 60_000;
    if (elapsed >= GENERATING_TIMEOUT_MINUTES) {
      await updateWorkItem(item.id, {
        status: "failed",
        execution: {
          ...item.execution,
          completedAt: now.toISOString(),
          outcome: "failed",
        },
      });
      events.push(
        makeEvent(
          "timeout",
          item.id,
          "generating",
          "failed",
          `Handoff generation stalled for ${Math.round(elapsed)} minutes (reason: generating_timeout)`
        )
      );
    }
  }

  addPhase(trace, { name: 'generating_timeout_detection', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // 2.8: Failed work item PR reconciliation
  const failedEntries = await listWorkItems({ status: "failed" });
  for (const entry of failedEntries) {
    const item = await getWorkItem(entry.id);
    if (!item || !item.execution?.prNumber) continue;

    // Guard: skip if item blob status diverges from index (already updated by MCP or another process)
    if (item.status !== 'failed') {
      console.log(`[health-monitor] Skipping reconciliation for ${item.id} — blob status is "${item.status}", not "failed" (index stale)`);
      continue;
    }

    try {
      const pr = await getPRByNumber(item.targetRepo, item.execution.prNumber);
      if (pr?.mergedAt) {
        await updateWorkItem(item.id, {
          status: "merged",
          execution: {
            ...item.execution,
            prUrl: pr.htmlUrl,
            completedAt: pr.mergedAt,
            outcome: "merged",
          },
        });
        events.push(
          makeEvent(
            "work_item_reconciled",
            item.id,
            "failed",
            "merged",
            `Reconciled: work item was "failed" but PR #${pr.number} is merged (merged at ${pr.mergedAt})`
          )
        );

        // §2.8 extension: trigger incremental re-index on PR merge
        try {
          const prFiles = await getPRFiles(item.targetRepo, pr.number);
          if (prFiles.length > 0) {
            const result = await incrementalIndex(item.targetRepo, prFiles);
            console.log(
              `[health-monitor §2.8] Incremental re-index triggered for ${item.targetRepo} (${prFiles.length} files from PR #${pr.number}, ${result.entitiesUpdated} entities updated)`
            );
          }
        } catch (indexErr) {
          console.warn(
            `[health-monitor §2.8] Incremental re-index failed for PR #${pr.number}:`,
            indexErr instanceof Error ? indexErr.message : String(indexErr)
          );
        }
      } else if (!pr || (pr.state === "closed" && !pr.mergedAt)) {
        // Genuinely failed, leave as-is
      } else if (pr.state === "open") {
        events.push(
          makeEvent(
            "work_item_reconciled",
            item.id,
            "failed",
            "failed",
            `Work item "failed" but PR #${pr.number} is still open — deferring to HLO for retry/recovery`
          )
        );
      }
    } catch (err) {
      console.error(`[health-monitor] PR reconciliation failed for work item ${item.id}:`, err);
    }
  }

  addPhase(trace, { name: 'failed_pr_reconciliation', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // 4.1: Dependency block detection
  const repoIndex = await listRepos();
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;
    const { getBlockedByDependencies } = await import("../work-items");
    const blocked = await getBlockedByDependencies(repo.fullName);
    for (const item of blocked) {
      const unmetDeps: string[] = [];
      for (const depId of item.dependencies) {
        const dep = await getWorkItem(depId);
        if (dep && dep.status !== "merged") {
          unmetDeps.push(`${dep.title} (${dep.status})`);
        }
      }
      events.push(
        makeEvent(
          "dependency_block",
          item.id,
          undefined,
          undefined,
          `Waiting on dependencies: ${unmetDeps.join(", ")}`
        )
      );
    }

    // Dead dependency auto-cancellation
    const DEAD_DEP_STATUSES = ["failed", "parked"];
    for (const item of blocked) {
      const deadDeps: string[] = [];
      for (const depId of item.dependencies) {
        const dep = await getWorkItem(depId);
        if (!dep) {
          console.warn(
            `[health-monitor] Dead-dep check: dependency ${depId} for item ${item.id} returned null. Skipping.`
          );
          continue;
        } else if (DEAD_DEP_STATUSES.includes(dep.status)) {
          deadDeps.push(depId);
        }
      }

      if (deadDeps.length > 0) {
        await updateWorkItem(item.id, { status: "cancelled" as any });
        events.push(
          makeEvent(
            "auto_cancel",
            item.id,
            item.status,
            "cancelled",
            `Auto-cancelled: ${deadDeps.length} dead dependency(ies) [${deadDeps.join(", ")}]`
          )
        );
      }
    }
  }

  addPhase(trace, { name: 'dependency_management', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // 3.4: Auto-cancel obsolete remediation items
  const RESOLVED_STATUSES = ["merged", "cancelled"];
  const allActiveEntries = [
    ...executingEntries,
    ...reviewingEntries,
    ...(await listWorkItems({ status: "ready" })),
    ...(await listWorkItems({ status: "blocked" })),
  ];
  for (const entry of allActiveEntries) {
    const fullItem = await getWorkItem(entry.id);
    if (!fullItem || fullItem.source.type !== "direct") continue;
    if (RESOLVED_STATUSES.includes(fullItem.status)) continue;

    const uuidPattern = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi;
    const referencedIds = [...(fullItem.description?.matchAll(uuidPattern) ?? [])].map((m) => m[1]);

    const otherRefs = referencedIds.filter((id) => id !== fullItem.id);
    if (otherRefs.length === 0) continue;

    let allRefsResolved = true;
    for (const refId of otherRefs) {
      const refItem = await getWorkItem(refId);
      if (!refItem || !RESOLVED_STATUSES.includes(refItem.status)) {
        allRefsResolved = false;
        break;
      }
    }

    if (allRefsResolved) {
      await updateWorkItem(fullItem.id, { status: "cancelled" as any });
      events.push(
        makeEvent(
          "auto_cancel",
          fullItem.id,
          fullItem.status,
          "cancelled",
          `Auto-cancelled: remediation item is obsolete — all referenced items [${otherRefs.join(", ")}] are resolved`
        )
      );
    }
  }

  addPhase(trace, { name: 'auto_cancel', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // 3.5: Retry failed items (max 2 retries, then park)
  const failedThisCycle = events
    .filter((e) => e.newStatus === "failed" && e.type !== "error")
    .map((e) => e.workItemId);

  for (const failedId of failedThisCycle) {
    const item = await getWorkItem(failedId);
    if (!item) continue;

    if (item.execution?.prNumber != null) {
      console.log(
        `[health-monitor] Skipping retry for ${item.id} — has PR #${item.execution.prNumber}, deferring to reconciler`
      );
      continue;
    }

    const retryCount = item.execution?.retryCount ?? 0;

    if (retryCount < MAX_RETRIES) {
      if (item.handoff?.branch) {
        try {
          const deleted = await deleteBranch(item.targetRepo, item.handoff.branch);
          if (deleted) {
            console.log(
              `[health-monitor] Deleted stale branch ${item.handoff.branch} before retry dispatch for ${item.id}`
            );
          }
        } catch (err) {
          console.warn(
            `[health-monitor] Failed to delete branch ${item.handoff.branch} before retry:`,
            err
          );
        }
      }

      await updateWorkItem(failedId, {
        status: "ready",
        execution: {
          ...item.execution,
          retryCount: retryCount + 1,
          completedAt: undefined,
          outcome: undefined,
        },
      });
      events.push(
        makeEvent(
          "retry",
          failedId,
          "failed",
          "ready",
          `Retry ${retryCount + 1}/${MAX_RETRIES}: resetting to ready for re-dispatch`
        )
      );
    } else {
      await updateWorkItem(failedId, {
        status: "parked",
        execution: {
          ...item.execution,
          outcome: "parked",
        },
      });
      events.push(
        makeEvent(
          "parked",
          failedId,
          "failed",
          "parked",
          `Parked after ${retryCount} retries. Requires human attention.`
        )
      );
    }
  }

  addPhase(trace, { name: 'retry', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // 3.6: Re-evaluate failed items whose dependencies have all resolved
  const failedForDepCheck = await listWorkItems({ status: "failed" });
  for (const entry of failedForDepCheck) {
    const item = await getWorkItem(entry.id);
    if (!item) continue;
    if (item.dependencies.length === 0) continue;
    if (item.execution?.prNumber != null) continue;
    const retryCount = item.execution?.retryCount ?? 0;
    if (retryCount >= 2) continue;

    let allDepsResolved = true;
    let anyDepChanged = false;
    for (const depId of item.dependencies) {
      const dep = await getWorkItem(depId);
      if (!dep) {
        allDepsResolved = false;
        break;
      }
      if (dep.status === "merged" || dep.status === "cancelled") {
        if (item.execution?.completedAt && dep.updatedAt > item.execution.completedAt) {
          anyDepChanged = true;
        }
      } else {
        allDepsResolved = false;
        break;
      }
    }

    if (allDepsResolved && anyDepChanged) {
      if (item.handoff?.branch) {
        try {
          const deleted = await deleteBranch(item.targetRepo, item.handoff.branch);
          if (deleted) {
            console.log(
              `[health-monitor] Deleted stale branch ${item.handoff.branch} before dep-resolved retry for ${item.id}`
            );
          }
        } catch {
          // Branch doesn't exist — fine, proceed
        }
      }

      await updateWorkItem(item.id, {
        status: "ready" as any,
        execution: {
          ...item.execution,
          outcome: undefined,
        },
      });
      events.push(
        makeEvent(
          "dep_resolved",
          item.id,
          "failed",
          "ready",
          `Auto-reset to ready: all dependencies resolved since last failure (retry ${retryCount + 1})`
        )
      );
    }
  }

  addPhase(trace, { name: 'dep_resolved_reevaluation', durationMs: Date.now() - phaseStart });

  completeTrace(trace, 'success');
  return activeExecutions;

  } catch (err) {
    addError(trace, String(err));
    completeTrace(trace, 'error');
    throw err;
  } finally {
    try {
      await persistTrace(trace);
      await cleanupOldTraces('health-monitor');
    } catch (tracingErr) {
      console.error('[HealthMonitor] Tracing failed (non-fatal):', tracingErr);
    }
  }
}
