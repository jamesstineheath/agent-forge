import { randomUUID } from "crypto";
import { loadJson, saveJson, deleteJson } from "./storage";
import { listWorkItems, getWorkItem, updateWorkItem, getNextDispatchable, getAllDispatchable, reconcileWorkItemIndex } from "./work-items";
import { listRepos, getRepo } from "./repos";
import { getWorkflowRuns, getPRByBranch, getPRByNumber, getPRFiles, listBranches, deleteBranch, getBranchLastCommitDate, getPRLifecycleState, getPRMergeability, rebasePR, closePRWithReason, pushFile } from "./github";
import { dispatchWorkItem } from "./orchestrator";
import type { ATCEvent, ATCState, WorkItem, HLOLifecycleState } from "./types";
import type { PR } from "./github";
import { getExecuteProjects, transitionToExecuting, transitionToFailed, checkProjectCompletion, transitionProject, writeOutcomeSummary, getRetryProjects, clearRetryFlag, markProjectFailedFromRetry } from "./projects";
import { decomposeProject } from "./decomposer";
import { validatePlan } from "./plan-validator";
import { getPendingEscalations, expireEscalation, resolveEscalation, updateEscalation } from "./escalation";
import { summarizeDailyCacheMetrics } from "./cache-metrics";
import { reviewBacklog, assessProjectHealth, composeDigest } from "./pm-agent";

/**
 * Parse "Estimated files:" from handoff markdown content.
 * Returns an array of file paths listed after the metadata field.
 */
export function parseEstimatedFiles(content: string): string[] {
  const match = content.match(/\*\*Estimated files?:\*\*\s*(.+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

const ATC_STATE_KEY = "atc/state";
const ATC_EVENTS_KEY = "atc/events";
const ATC_BRANCH_CLEANUP_KEY = "atc/last-branch-cleanup";

// Projects with human-authored plans that predate the PM quality gate.
// These bypass the plan quality gate check in §4.5.
// Remove entries once they have a proper PM-agent plan or are completed.
const QUALITY_GATE_EXEMPT_PROJECTS = new Set([
  "PRJ-9",  // PA Real Estate Agent v2 — human-authored plan
]);
const ATC_LOCK_KEY = "atc/cycle-lock";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_HARD_CEILING_MS = 10 * 60 * 1000; // 10 minutes — force-clear zombie locks
const CYCLE_TIMEOUT_MS = 240 * 1000; // 240s — abort before Vercel's 300s Fluid Compute limit
// Stage-aware stall timeouts:
// - Executing (no workflow run yet): GHA queue delays can be 5-15 min
// - Executing (workflow running): 35 min from workflow start covers most handoffs
// - Reviewing (no PR): something went wrong — shorter timeout
const STALL_TIMEOUT_EXECUTING_NO_RUN_MINUTES = 20;
const STALL_TIMEOUT_EXECUTING_WITH_RUN_MINUTES = 35;
const STALL_TIMEOUT_REVIEWING_NO_PR_MINUTES = 30;
const CONFLICT_CHECK_DELAY_MINUTES = 15; // Don't check mergeability until PR has been in "reviewing" for this long
const MAX_EVENTS = 1000;
const CLEANUP_THROTTLE_MINUTES = 60;
const STALE_BRANCH_HOURS = 48;
const MAX_BRANCHES_PER_REPO = 20;

/**
 * Optimistic distributed lock using Vercel Blob.
 * Not a true atomic CAS (Blob doesn't support it), but sufficient given
 * the ATC cron interval is measured in minutes. The write-then-reread
 * pattern catches most races.
 */
export async function acquireATCLock(): Promise<boolean> {
  const existing = await loadJson<{ acquiredAt: string; id: string }>(ATC_LOCK_KEY);

  if (existing) {
    const age = Date.now() - new Date(existing.acquiredAt).getTime();

    if (age >= LOCK_HARD_CEILING_MS) {
      console.warn(
        `[atc] Lock exceeded hard ceiling (age: ${Math.round(age / 1000)}s). Force-clearing.`,
      );
      await deleteJson(ATC_LOCK_KEY);
    } else if (age < LOCK_TTL_MS) {
      console.log(`[atc] Cycle lock held (age: ${Math.round(age / 1000)}s). Skipping.`);
      return false;
    } else {
      console.log(`[atc] Expired lock found (age: ${Math.round(age / 1000)}s). Clearing before re-acquire.`);
      await deleteJson(ATC_LOCK_KEY);
    }
  }

  const lockId = randomUUID();
  await saveJson(ATC_LOCK_KEY, { acquiredAt: new Date().toISOString(), id: lockId });
  const reread = await loadJson<{ id: string }>(ATC_LOCK_KEY);
  return reread?.id === lockId;
}

export async function releaseATCLock(): Promise<void> {
  await deleteJson(ATC_LOCK_KEY);
}

function hasFileOverlap(filesA: string[], filesB: string[]): boolean {
  const setB = new Set(filesB);
  return filesA.some(f => setB.has(f));
}

// High-churn files that should serialize all work items touching them.
// Any item touching one of these files will be blocked from dispatch while
// another item touching the same file is active (executing or reviewing).
const HIGH_CHURN_FILES = new Set([
  "lib/atc.ts",
]);

class CycleTimeoutError extends Error {
  constructor(ms: number) {
    super(`ATC cycle timed out after ${ms}ms`);
    this.name = 'CycleTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CycleTimeoutError(ms)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

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

  // === PHASE 0: INDEX RECONCILIATION ===
  // Detect and repair index/blob drift so repaired items are visible in this cycle
  try {
    const reconcileResult = await reconcileWorkItemIndex();
    if (reconcileResult.repaired > 0) {
      console.warn('[atc] index reconciliation repaired items', reconcileResult);
    }
  } catch (err) {
    console.error('[atc] index reconciliation failed', err);
    // Non-fatal: continue with ATC cycle
  }

  // === PHASE 1: DISPATCH (runs first to avoid timeout starvation) ===
  // Build lightweight active state from work item data (no GitHub API calls)
  // so we can check concurrency and dispatch ASAP.

  // 1. Load active work items (executing or reviewing)
  const [executingEntries, reviewingEntries] = await Promise.all([
    listWorkItems({ status: "executing" }),
    listWorkItems({ status: "reviewing" }),
  ]);
  const activeEntries = [...executingEntries, ...reviewingEntries];

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
    // Use stored files or parse from handoff — no GitHub API call needed
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

  // 1.3: Auto-dispatch (previously Section 4)
  const GLOBAL_CONCURRENCY_LIMIT = 5;
  const totalActive = activeExecutions.filter(
    (e) => e.status === "executing" || e.status === "reviewing"
  ).length;

  if (totalActive < GLOBAL_CONCURRENCY_LIMIT) {
    let slotsRemaining = GLOBAL_CONCURRENCY_LIMIT - totalActive;

    for (const repoEntry of repoIndex) {
      if (slotsRemaining <= 0) break;
      const repo = await getRepo(repoEntry.id);
      if (!repo) continue;
      const activeCount = concurrencyMap.get(repo.fullName) ?? 0;
      const repoSlotsAvailable = repo.concurrencyLimit - activeCount;
      if (repoSlotsAvailable <= 0) continue;

      const candidates = await getAllDispatchable(repo.fullName);
      if (candidates.length === 0) {
        // Observability: log when ready items exist but none are dispatchable
        const readyForRepo = await listWorkItems({ status: "ready", targetRepo: repo.fullName });
        if (readyForRepo.length > 0) {
          console.log(`[ATC dispatch] ${repo.fullName}: ${readyForRepo.length} ready items, 0 dispatchable (all blocked by deps or conflicts)`);
        }
        continue;
      }

      console.log(`[ATC dispatch] ${repo.fullName}: ${candidates.length} dispatchable candidate(s), ${slotsRemaining} slot(s) available`);

      const toDispatch = candidates.slice(0, Math.min(slotsRemaining, repoSlotsAvailable));

      for (const item of toDispatch) {
        // Conflict check: skip if any active execution in this repo touches overlapping files
        const itemFiles = item.handoff?.content
          ? parseEstimatedFiles(item.handoff.content)
          : [];
        const repoActiveExecs = activeExecutions.filter(e => e.targetRepo === repo.fullName);
        const conflicting = repoActiveExecs.find(e => hasFileOverlap(itemFiles, e.filesBeingModified));
        if (conflicting) {
          events.push(makeEvent(
            "conflict", item.id, undefined, undefined,
            `Dispatch blocked: file overlap with active item ${conflicting.workItemId} in ${repo.fullName}`
          ));
          continue;
        }

        // High-churn file serialization
        const itemHighChurn = itemFiles.filter(f => HIGH_CHURN_FILES.has(f));
        if (itemHighChurn.length > 0) {
          const highChurnConflict = activeExecutions.find(e =>
            e.filesBeingModified.some(f => itemHighChurn.includes(f))
          );
          if (highChurnConflict) {
            events.push(makeEvent(
              "conflict", item.id, undefined, undefined,
              `Dispatch blocked: high-churn file(s) [${itemHighChurn.join(", ")}] overlap with active item ${highChurnConflict.workItemId}`
            ));
            continue;
          }
        }

        try {
          const result = await dispatchWorkItem(item.id);
          events.push(makeEvent(
            "auto_dispatch", item.id, "ready", "executing",
            `Auto-dispatched to ${repo.fullName} (branch: ${result.branch})`
          ));
          slotsRemaining--;
          concurrencyMap.set(repo.fullName, (concurrencyMap.get(repo.fullName) ?? 0) + 1);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          await updateWorkItem(item.id, {
            status: "failed",
            execution: {
              ...item.execution,
              completedAt: now.toISOString(),
              outcome: "failed",
            },
          });
          events.push(makeEvent(
            "error", item.id, "ready", "failed",
            `Auto-dispatch failed: ${msg}`
          ));
        }
      }
    }

    // --- Standalone item dispatch (fast lane) ---
    // Standalone items (any source except 'project') have no project parent.
    // Pick up 'filed' or 'ready' items and dispatch if repo has capacity.
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
      // Skip project-decomposed items — they're dispatched via the project loop above
      if (!item || item.source.type === "project") continue;

      const activeForRepo = concurrencyMap.get(item.targetRepo) ?? 0;
      const repoConfig = repoConfigByName.get(item.targetRepo);
      const limit = repoConfig?.concurrencyLimit ?? 1;

      if (activeForRepo >= limit) {
        console.log(`[ATC] Repo ${item.targetRepo} at concurrency limit, skipping standalone item: ${item.id}`);
        continue;
      }

      if (item.status === "filed") {
        await updateWorkItem(item.id, { status: "ready" });
      }

      console.log(`[ATC] Dispatching standalone item: ${item.id} (source: ${item.source.type})`);
      try {
        const result = await dispatchWorkItem(item.id);
        events.push(makeEvent(
          "auto_dispatch", item.id, item.status, "executing",
          `Auto-dispatched standalone item (source: ${item.source.type}) to ${item.targetRepo} (branch: ${result.branch})`
        ));
        slotsRemaining--;
        concurrencyMap.set(item.targetRepo, (concurrencyMap.get(item.targetRepo) ?? 0) + 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        await updateWorkItem(item.id, {
          status: "failed",
          execution: {
            ...item.execution,
            completedAt: now.toISOString(),
            outcome: "failed",
          },
        });
        events.push(makeEvent(
          "error", item.id, "ready", "failed",
          `Standalone item auto-dispatch failed: ${msg}`
        ));
      }
    }
  } else {
    console.log(`[ATC dispatch] Global concurrency limit reached (${totalActive}/${GLOBAL_CONCURRENCY_LIMIT}), skipping dispatch`);
  }

  // 1.4: Update active-work-items.md in each repo (activates Spec Reviewer conflict detection)
  try {
    const activeItems = await Promise.all([
      listWorkItems({ status: "executing" }),
      listWorkItems({ status: "reviewing" }),
      listWorkItems({ status: "ready" }),
    ]);
    const [executingItems, reviewingItems, readyItems] = activeItems;

    // Build markdown content (no timestamp — content must be stable for change detection)
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

    if (executingItems.length === 0 && reviewingItems.length === 0 && readyItems.length === 0) {
      lines.push("*No active work items.*", "");
    }

    const activeWorkItemsMd = lines.join("\n");

    // Push to each registered repo (only if content actually changed)
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
          console.log(`[atc] active-work-items.md unchanged in ${repo.fullName}, skipped push`);
        }
      } catch (pushErr) {
        // Non-fatal: log and continue
        console.warn(`[atc] Failed to update active-work-items.md in ${repo.fullName}:`, pushErr);
      }
    }
  } catch (err) {
    console.error("[atc] active-work-items.md generation failed:", err);
  }

  // === PHASE 2: MONITORING (process active items with GitHub API calls) ===
  // Clear and rebuild activeExecutions with enriched data from GitHub
  activeExecutions.length = 0;

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

    // Stage-aware stall timeout check.
    // Reviewing items with an open PR are waiting for code review/CI — this is
    // normal and can take hours/days. No timeout applies to them.
    const hasOpenPR = item.status === "reviewing" && item.execution?.prNumber != null;
    const stallTimeout = item.status === "reviewing"
      ? STALL_TIMEOUT_REVIEWING_NO_PR_MINUTES
      : STALL_TIMEOUT_EXECUTING_NO_RUN_MINUTES; // refined below for executing items with workflow runs
    if (elapsedMinutes >= stallTimeout && !hasOpenPR) {
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

    // Populate filesBeingModified: use PR files if available, else parse handoff metadata
    let filesBeingModified: string[] = [];
    if (pr && item.execution?.prNumber) {
      filesBeingModified = await getPRFiles(item.targetRepo, item.execution.prNumber);
      // Persist actual PR files on the work item for more accurate future conflict checks
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
      } else if (latestRun && latestRun.status !== "completed" && elapsedMinutes >= STALL_TIMEOUT_EXECUTING_WITH_RUN_MINUTES) {
        // Workflow run exists but has been in progress too long
        const event = makeEvent("timeout", item.id, "executing", "failed",
          `Workflow run ${latestRun.id} in progress for ${Math.round(elapsedMinutes)} minutes (reason: timeout)`);
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
      } else if (pr?.state === "open" && elapsedMinutes >= CONFLICT_CHECK_DELAY_MINUTES) {
        // §2.7: Merge conflict detection for open PRs in "reviewing" status
        const prNumber = item.execution?.prNumber ?? pr.number;
        const mergeability = await getPRMergeability(item.targetRepo, prNumber);

        if (mergeability.mergeable === false && mergeability.mergeableState === "dirty") {
          // Actual merge conflict — attempt auto-rebase
          const [owner, repoName] = item.targetRepo.split("/");
          const rebaseResult = await rebasePR(owner, repoName, prNumber);

          if (rebaseResult.success) {
            events.push(makeEvent("conflict", item.id, "reviewing", "reviewing",
              `PR #${prNumber} had merge conflict, auto-rebased successfully`));
          } else {
            // Rebase failed — close PR and fail for re-dispatch
            try {
              await closePRWithReason(owner, repoName, prNumber, "merge_conflicts",
                `Auto-rebase failed: ${rebaseResult.error}. Work item will be re-dispatched.`);
            } catch (closeErr) {
              console.warn(`[atc] Failed to close conflicted PR #${prNumber}:`, closeErr);
            }
            const event = makeEvent("conflict", item.id, "reviewing", "failed",
              `PR #${prNumber} merge conflict unresolvable (${rebaseResult.error}), closed for re-dispatch`);
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
          // No conflict but behind main — proactively rebase
          const [owner, repoName] = item.targetRepo.split("/");
          const rebaseResult = await rebasePR(owner, repoName, prNumber);
          if (rebaseResult.success) {
            events.push(makeEvent("conflict", item.id, "reviewing", "reviewing",
              `PR #${prNumber} was behind base, auto-rebased`));
          }
          // If rebase fails here, skip — will be caught as "dirty" on next cycle
        }
      }
    }
  }

  // 2.5: Generating timeout detection — catch items stuck in "generating" (handoff gen failed silently)
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
      events.push(makeEvent(
        "timeout", item.id, "generating", "failed",
        `Handoff generation stalled for ${Math.round(elapsed)} minutes (reason: generating_timeout)`
      ));
    }
  }

  // 2.8: Failed work item PR reconciliation
  // A work item can be marked "failed" due to a workflow step failure (e.g., "Report results" bash error)
  // even though its PR actually merged. Check all failed items with a prNumber — if the PR merged,
  // reconcile the work item to "merged".
  const failedEntries = await listWorkItems({ status: "failed" });
  for (const entry of failedEntries) {
    const item = await getWorkItem(entry.id);
    if (!item || !item.execution?.prNumber) continue;

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
        events.push(makeEvent(
          "work_item_reconciled", item.id, "failed", "merged",
          `Reconciled: work item was "failed" but PR #${pr.number} is merged (merged at ${pr.mergedAt})`
        ));
      } else if (!pr || (pr.state === "closed" && !pr.mergedAt)) {
        // PR is closed without merge or doesn't exist — genuinely failed, leave as-is
      } else if (pr.state === "open") {
        // PR is still open — leave as "failed" and let the Handoff Lifecycle
        // Orchestrator (HLO) handle retries via GitHub Actions. Moving failed
        // items back to "reviewing" causes re-dispatch loops where ATC picks
        // them up again and burns retry attempts.
        events.push(makeEvent(
          "work_item_reconciled", item.id, "failed", "failed",
          `Work item "failed" but PR #${pr.number} is still open — deferring to HLO for retry/recovery`
        ));
      }
    } catch (err) {
      console.error(`[atc] PR reconciliation failed for work item ${item.id}:`, err);
    }
  }

  // 4.1: Dependency block detection (uses repoIndex from Phase 1)
  for (const repoEntry of repoIndex) {
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;
    const { getBlockedByDependencies } = await import("./work-items");
    const blocked = await getBlockedByDependencies(repo.fullName);
    for (const item of blocked) {
      const unmetDeps: string[] = [];
      for (const depId of item.dependencies) {
        const dep = await getWorkItem(depId);
        if (dep && dep.status !== "merged") {
          unmetDeps.push(`${dep.title} (${dep.status})`);
        }
      }
      events.push(makeEvent(
        "dependency_block",
        item.id,
        undefined,
        undefined,
        `Waiting on dependencies: ${unmetDeps.join(", ")}`
      ));
    }

    // Dead dependency auto-cancellation: cancel items whose deps are permanently unresolvable
    // Note: "cancelled" is NOT a dead state — cancelled deps are treated as resolved
    // (the work was either done under a different item ID or is no longer needed).
    const DEAD_DEP_STATUSES = ["failed", "parked"];
    for (const item of blocked) {
      const deadDeps: string[] = [];
      for (const depId of item.dependencies) {
        const dep = await getWorkItem(depId);
        if (!dep) {
          // Dep blob missing — could be transient. Do NOT auto-cancel.
          console.warn(`[atc] Dead-dep check: dependency ${depId} for item ${item.id} returned null. Skipping (possible transient failure).`);
          continue; // Skip, don't treat as dead
        } else if (DEAD_DEP_STATUSES.includes(dep.status)) {
          // Dependency failed/parked - will never reach "merged"
          deadDeps.push(depId);
        }
      }

      if (deadDeps.length > 0) {
        await updateWorkItem(item.id, { status: "cancelled" as any });
        events.push(makeEvent(
          "auto_cancel", item.id, item.status, "cancelled",
          `Auto-cancelled: ${deadDeps.length} dead dependency(ies) [${deadDeps.join(", ")}]`
        ));
      }
    }
  }

  // 3.4: Auto-cancel obsolete remediation items
  // Direct-source items that reference another work item (by ID in their description)
  // and that referenced item has already been resolved (merged/cancelled)
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

    // Look for referenced work item IDs in the description (UUID pattern)
    const uuidPattern = /\b([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi;
    const referencedIds = [...(fullItem.description?.matchAll(uuidPattern) ?? [])].map(m => m[1]);

    // Filter out self-references and check if ALL referenced items are resolved
    const otherRefs = referencedIds.filter(id => id !== fullItem.id);
    if (otherRefs.length === 0) continue; // No external references

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
      events.push(makeEvent(
        "auto_cancel", fullItem.id, fullItem.status, "cancelled",
        `Auto-cancelled: remediation item is obsolete — all referenced items [${otherRefs.join(", ")}] are resolved`
      ));
    }
  }

  // 3.5: Retry failed items (max 2 retries, then park)
  const MAX_RETRIES = 2;
  const failedThisCycle = events
    .filter(e => e.newStatus === "failed" && e.type !== "error")
    .map(e => e.workItemId);

  for (const failedId of failedThisCycle) {
    const item = await getWorkItem(failedId);
    if (!item) continue;

    // Guard: if item has an open PR, defer to reconciler/HLO — don't reset to ready
    if (item.execution?.prNumber != null) {
      console.log(`[ATC] Skipping retry for ${item.id} — has PR #${item.execution.prNumber}, deferring to reconciler`);
      continue;
    }

    const retryCount = item.execution?.retryCount ?? 0;

    if (retryCount < MAX_RETRIES) {
      // Delete stale branch before re-dispatch to prevent 422 "Reference already exists"
      if (item.handoff?.branch) {
        try {
          const deleted = await deleteBranch(item.targetRepo, item.handoff.branch);
          if (deleted) {
            console.log(`[ATC] Deleted stale branch ${item.handoff.branch} before retry dispatch for ${item.id}`);
          }
        } catch (err) {
          // Branch doesn't exist — that's fine, proceed with retry
          console.warn(`[ATC] Failed to delete branch ${item.handoff.branch} before retry:`, err);
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
      events.push(makeEvent(
        "retry", failedId, "failed", "ready",
        `Retry ${retryCount + 1}/${MAX_RETRIES}: resetting to ready for re-dispatch`
      ));
    } else {
      await updateWorkItem(failedId, {
        status: "parked",
        execution: {
          ...item.execution,
          outcome: "parked",
        },
      });
      events.push(makeEvent(
        "parked", failedId, "failed", "parked",
        `Parked after ${retryCount} retries. Requires human attention.`
      ));
    }
  }

  // 3.6: Re-evaluate failed items whose dependencies have all resolved
  const failedForDepCheck = await listWorkItems({ status: "failed" });
  for (const entry of failedForDepCheck) {
    const item = await getWorkItem(entry.id);
    if (!item) continue;
    if (item.dependencies.length === 0) continue;
    // Guard: if item has an open PR, defer to reconciler — don't reset to ready
    if (item.execution?.prNumber != null) continue;
    const retryCount = item.execution?.retryCount ?? 0;
    if (retryCount >= 2) continue; // Already retried enough

    // Check if ALL dependencies are now in a resolved state
    let allDepsResolved = true;
    let anyDepChanged = false;
    for (const depId of item.dependencies) {
      const dep = await getWorkItem(depId);
      if (!dep) { allDepsResolved = false; break; }
      if (dep.status === "merged" || dep.status === "cancelled") {
        // Check if dep was resolved AFTER the item failed
        if (item.execution?.completedAt && dep.updatedAt > item.execution.completedAt) {
          anyDepChanged = true;
        }
      } else {
        allDepsResolved = false;
        break;
      }
    }

    if (allDepsResolved && anyDepChanged) {
      // Delete stale branch before re-dispatch to prevent 422 "Reference already exists"
      if (item.handoff?.branch) {
        try {
          const deleted = await deleteBranch(item.targetRepo, item.handoff.branch);
          if (deleted) {
            console.log(`[ATC] Deleted stale branch ${item.handoff.branch} before dep-resolved retry for ${item.id}`);
          }
        } catch {
          // Branch doesn't exist — fine, proceed
        }
      }

      await updateWorkItem(item.id, {
        status: "ready" as any,
        execution: {
          ...item.execution,
          outcome: undefined, // Clear previous outcome
        },
      });
      events.push(makeEvent(
        "dep_resolved", item.id, "failed", "ready",
        `Auto-reset to ready: all dependencies resolved since last failure (retry ${retryCount + 1})`
      ));
    }
  }

  // §4 — Project retry processing
  // Process projects flagged for retry before decomposition picks them up
  try {
    const retryProjects = await getRetryProjects();
    if (retryProjects.length > 0) {
      console.log(`[atc] §4: found ${retryProjects.length} project(s) flagged for retry`);
    }

    for (const project of retryProjects) {
      const retryCount = project.retryCount ?? 0;

      // Check retry cap
      if (retryCount >= 3) {
        console.log(`[atc] §4: project ${project.projectId} has hit retry cap (retryCount=${retryCount}), marking failed`);
        await markProjectFailedFromRetry(project.id);
        events.push(makeEvent(
          "project_retry", project.projectId, undefined, "Failed",
          `Retry cap exceeded (retryCount=${retryCount}), marked Failed`
        ));
        continue;
      }

      // Clear the dedup guard so §4.5 will re-decompose this project
      try {
        await deleteJson(`atc/project-decomposed/${project.projectId}`);
        console.log(`[atc] §4: cleared dedup guard for project ${project.projectId}`);
      } catch {
        // Guard may not exist; not an error
        console.log(`[atc] §4: no dedup guard to clear for project ${project.projectId} (ok)`);
      }

      // Cancel stale work items from previous attempt
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

      // Reset retry flag, increment count, set status to Execute
      await clearRetryFlag(project.id, retryCount);

      // Log ATC event
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

      // Dedup guard: O(1) check via dedicated dedup key per project
      const dedupKey = `atc/project-decomposed/${project.projectId}`;
      const alreadyDecomposed = await loadJson<{ decomposedAt: string }>(dedupKey);

      // Partial-failure recovery: project has dedup guard but zero work items
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
          // Fall through to re-decompose
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
      // Loop-detection guard: count decomposition attempts per project
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

      // Bypass quality gate for exempt projects (human-authored plans)
      const isExempt = QUALITY_GATE_EXEMPT_PROJECTS.has(project.projectId);
      if (isExempt) {
        console.log(`[ATC §4.5] Project "${project.title}" (${project.projectId}) is exempt from quality gate — proceeding to decomposition.`);
      }

      if (!isExempt) {
        const validation = await validatePlan(project.id);
        if (!validation.valid) {
          const failedChecks = validation.issues
            .map((i) => `[${i.severity.toUpperCase()}]${i.section ? ` ${i.section}:` : ''} ${i.message}`);
          const issueList = failedChecks.join('\n');

          const rejectionReason =
            `Plan quality gate rejected project "${project.title}" (${project.projectId}). ` +
            `Checks failed: ${failedChecks.join("; ")}. ` +
            `Project will be transitioned to Failed to prevent infinite loop. ` +
            `If this project has a human-authored plan, add its projectId to QUALITY_GATE_EXEMPT_PROJECTS in lib/atc.ts to bypass.`;
          console.error(`[ATC §4.5 Quality Gate] ${rejectionReason}`);

          try {
            const { sendProjectEscalationEmail } = await import('./gmail');
            await sendProjectEscalationEmail({
              projectId: project.projectId,
              projectTitle: project.title,
              reason: `Plan validation found ${validation.issues.length} issue(s):\n\n${issueList}\n\nProject transitioned to Failed. Fix the plan and re-trigger, or add to QUALITY_GATE_EXEMPT_PROJECTS if this is a human-authored plan.`,
              escalationType: 'plan_validation_failed',
            });
          } catch (emailErr) {
            console.error(`[ATC §4.5] Failed to send escalation email for ${project.title}:`, emailErr);
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

        // Save dedup key after successful decomposition
        await saveJson(dedupKey, { decomposedAt: now.toISOString(), workItemCount: workItems.length });

        // Clear loop-detection counter on success
        await deleteJson(loopGuardKey);

        events.push(makeEvent(
          "project_trigger", project.projectId, undefined, undefined,
          `Project "${project.title}" decomposed into ${workItems.length} work items`
        ));

        // Send decomposition summary email
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

  // 7. Append events to rolling log (keep last 200)
  if (events.length > 0) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...events].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }

  // 7b. Persist events to per-work-item logs (full history, no cap)
  const itemEventMap = new Map<string, ATCEvent[]>();
  for (const evt of events) {
    if (evt.workItemId === "system") continue;
    const existing = itemEventMap.get(evt.workItemId) ?? [];
    existing.push(evt);
    itemEventMap.set(evt.workItemId, existing);
  }
  for (const [itemId, itemEvents] of itemEventMap) {
    try {
      const key = `work-items/${itemId}/events`;
      const existingItemEvents = (await loadJson<ATCEvent[]>(key)) ?? [];
      await saveJson(key, [...existingItemEvents, ...itemEvents]);
    } catch (err) {
      console.warn(`[atc] Failed to persist events for work item ${itemId}:`, err);
    }
  }

  // 8. Periodic branch cleanup
  try {
    const cleanupResult = await cleanupStaleBranches();
    if (cleanupResult && cleanupResult.deletedCount > 0) {
      events.push(makeEvent(
        "cleanup", "system", undefined, undefined,
        `Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}, errors ${cleanupResult.errors}`
      ));
      // Re-save events since we added cleanup events
      const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
      const updated = [...existing, ...events.filter(e => e.type === "cleanup")].slice(-MAX_EVENTS);
      await saveJson(ATC_EVENTS_KEY, updated);
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
            .filter(id => id && id !== "index") // Exclude the index file itself
        );

        const indexEntries = await listWorkItems({});
        const indexIds = new Set(indexEntries.map(e => e.id));

        // Safety guard: if index is empty but blobs exist, skip to prevent data loss
        if (indexEntries.length === 0 && blobs.length > 0) {
          console.warn(`[atc] Reconciliation safety: index is empty but ${blobs.length} blob(s) exist. Skipping to prevent data loss.`);
          await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
          // DO NOT proceed to delete any blobs
        } else {
          // Find dangling blobs (in blob store but not in index)
          const danglingIds = [...blobIds].filter(id => id && !indexIds.has(id));
          if (danglingIds.length > 0 && danglingIds.length > blobIds.size * 0.5) {
            console.error(`[atc] Reconciliation safety: ${danglingIds.length}/${blobIds.size} blobs flagged as dangling (>50%). Refusing to delete. Likely index corruption.`);
          } else if (danglingIds.length > 0) {
            for (const id of danglingIds) {
              await deleteJson(`work-items/${id}`);
            }
            events.push(makeEvent(
              "cleanup", "system", undefined, undefined,
              `Blob reconciliation: deleted ${danglingIds.length} dangling work-item blob(s)`
            ));
          }

          // Reverse reconciliation: remove stale index entries pointing to missing blobs
          const staleIndexEntries = indexEntries.filter(e => !blobIds.has(e.id));
          if (staleIndexEntries.length > 0 && staleIndexEntries.length < indexEntries.length) {
            const cleanedIndex = indexEntries.filter(e => blobIds.has(e.id));
            await saveJson("work-items/index", cleanedIndex);
            events.push(makeEvent(
              "cleanup", "system", undefined, undefined,
              `Index reconciliation: removed ${staleIndexEntries.length} stale index entries`
            ));
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

  // 10. Escalation timeout monitoring: flag escalations older than 24h
  try {
    const pending = await getPendingEscalations();
    const ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

    for (const esc of pending) {
      const createdTime = new Date(esc.createdAt).getTime();
      const age = now.getTime() - createdTime;

      if (age > ESCALATION_TIMEOUT_MS) {
        // Mark as expired but don't auto-resolve
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

  // Save events if escalation timeouts were detected
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
      if (!esc.threadId) {
        // No thread ID means email was not sent (graceful degradation)
        continue;
      }

      const replyMessage = await checkForReply(esc.threadId);
      if (replyMessage) {
        // Reply found! Parse content and resolve
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
    const REMINDER_THRESHOLD = 24 * 60 * 60 * 1000; // 24 hours

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
              "escalation_resolved", // reuse type for reminder events
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
  // 13a: Stuck "Executing" recovery — projects that transitioned to Executing but never decomposed
  //      (e.g., ATC cycle timed out before reaching Section 4.5). Reset to "Execute" so next cycle retries.
  // 13b: Project completion detection — when all work items reach terminal state, update Notion accordingly.
  try {
    const { listProjects } = await import("./projects");
    const { updateProjectStatus } = await import("./notion");
    const executingProjects = await listProjects("Executing");

    // Cache the full work item list once (avoid repeated list calls per project)
    const allItemEntries = await listWorkItems({});
    const allItemsById = new Map<string, WorkItem>();
    for (const entry of allItemEntries) {
      const item = await getWorkItem(entry.id);
      if (item) allItemsById.set(item.id, item);
    }

    for (const project of executingProjects) {
      // Find all work items for this project
      const projectItems = [...allItemsById.values()].filter(
        (item) => item.source.type === "project" && item.source.sourceId === project.projectId
      );

      // 13a: Stuck Executing recovery
      if (projectItems.length === 0) {
        const dedupKey = `atc/project-decomposed/${project.projectId}`;
        const hasDedup = await loadJson<{ decomposedAt: string }>(dedupKey);
        if (!hasDedup) {
          // No dedup guard + no work items = decomposition never ran. Reset to Execute.
          await updateProjectStatus(project.id, "Execute");
          events.push(makeEvent(
            "project_trigger", project.projectId, "Executing", "Execute",
            `Stuck recovery: project "${project.title}" was Executing with no work items and no dedup guard. Reset to Execute for re-decomposition.`
          ));
        }
        // If dedup exists but 0 items, the partial-failure recovery in Section 4.5 handles it
        continue;
      }

      // 13b: Project completion detection
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

        // Write outcome summary to Notion (non-blocking)
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
    // hloStateMap is available for downstream sections in this same cycle
    void hloStateMap; // Will be consumed by future SLA/remediation sections
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

  return state;
}

// § 14 — PM Agent Daily Sweep
// Only runs once per day (check last run timestamp in Vercel Blob)
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
    // Run backlog review
    const review = await reviewBacklog();
    console.log(`[ATC §14] Backlog review complete: ${review.recommendations.length} recommendations`);

    // Run health assessment for all projects
    const healths = await assessProjectHealth();
    const atRisk = healths.filter(h => h.status === 'at-risk' || h.status === 'stalling' || h.status === 'blocked');
    console.log(`[ATC §14] Health assessment: ${healths.length} projects, ${atRisk.length} at risk`);

    // Compose and send digest
    await composeDigest({
      includeHealth: true,
      includeBacklog: true,
      includeRecommendations: true,
      recipientEmail: 'james.stine.heath@gmail.com',
    });
    console.log('[ATC §14] Digest sent');

    // Record sweep timestamp
    await saveJson(SWEEP_KEY, { timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[ATC §14] PM Agent sweep failed:', error);
    // Don't throw — sweep failure shouldn't break the ATC cycle
  }
}

// === §15: Poll HLO Lifecycle State from Open PRs ===
// Reads HLO lifecycle state for all work items in 'reviewing' status.
// Returns a map for downstream sections (SLA tracking, remediation, etc.)

export interface HLOStateEntry {
  workItem: WorkItem;
  hloState: HLOLifecycleState | null;
  prInfo: PR | null;
}

async function pollHLOStateFromOpenPRs(
  workItems: WorkItem[]
): Promise<Map<number, HLOStateEntry>> {
  const reviewingItems = workItems.filter(
    (wi) => wi.status === 'reviewing' && wi.execution?.prNumber != null
  );

  const resultMap = new Map<number, HLOStateEntry>();

  await Promise.all(
    reviewingItems.map(async (wi) => {
      const prNumber = wi.execution!.prNumber!;
      const targetRepo = wi.targetRepo; // "owner/repo" format
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

  // Throttle check
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

  // --- Phase A: Clean branches for work items in terminal/failed states ---
  // This catches branches from failed executions that may not yet be 48h old.
  const CLEANUP_ELIGIBLE_STATUSES = ["failed", "parked", "cancelled"] as const;
  for (const status of CLEANUP_ELIGIBLE_STATUSES) {
    const entries = await listWorkItems({ status });
    for (const entry of entries) {
      const item = await getWorkItem(entry.id);
      if (!item || !item.handoff?.branch) continue;

      // Guard: skip if the work item has an associated PR (open PR = branch still needed)
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
        // deleteBranch returns false for 404 (branch already gone) — not an error
      } catch {
        errors++;
      }
    }
  }

  // --- Phase B: Time-based stale branch cleanup (existing logic) ---
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

  // Save timestamp
  await saveJson(ATC_BRANCH_CLEANUP_KEY, { lastRunAt: now.toISOString() });

  return { deletedCount, skipped, errors };
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

export async function getWorkItemEvents(workItemId: string): Promise<ATCEvent[]> {
  const key = `work-items/${workItemId}/events`;
  return (await loadJson<ATCEvent[]>(key)) ?? [];
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
