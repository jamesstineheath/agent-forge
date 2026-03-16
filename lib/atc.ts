import { randomUUID } from "crypto";
import { loadJson, saveJson, deleteJson } from "./storage";
import { listWorkItems, getWorkItem, updateWorkItem, getNextDispatchable, getAllDispatchable } from "./work-items";
import { listRepos, getRepo } from "./repos";
import { getWorkflowRuns, getPRByBranch, getPRFiles, listBranches, deleteBranch, getBranchLastCommitDate } from "./github";
import { dispatchWorkItem } from "./orchestrator";
import type { ATCEvent, ATCState, WorkItem } from "./types";
import { getExecuteProjects, transitionToExecuting, transitionToFailed } from "./projects";
import { decomposeProject } from "./decomposer";
import { getPendingEscalations, expireEscalation, resolveEscalation, updateEscalation } from "./escalation";
import { summarizeDailyCacheMetrics } from "./cache-metrics";

const ATC_STATE_KEY = "atc/state";
const ATC_EVENTS_KEY = "atc/events";
const ATC_BRANCH_CLEANUP_KEY = "atc/last-branch-cleanup";
const ATC_LOCK_KEY = "atc/cycle-lock";
const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALL_TIMEOUT_MINUTES = 30;
const MAX_EVENTS = 200;
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
    if (age < LOCK_TTL_MS) {
      console.log(`[atc] Cycle lock held (age: ${Math.round(age / 1000)}s). Skipping.`);
      return false;
    }
  }
  const lockId = randomUUID();
  await saveJson(ATC_LOCK_KEY, { acquiredAt: new Date().toISOString(), id: lockId });
  // Re-read to check for race (optimistic lock)
  const reread = await loadJson<{ id: string }>(ATC_LOCK_KEY);
  return reread?.id === lockId;
}

export async function releaseATCLock(): Promise<void> {
  await deleteJson(ATC_LOCK_KEY);
}

function parseEstimatedFiles(handoffContent: string): string[] {
  const match = handoffContent.match(/\*\*Estimated files:\*\*\s*(.+)/i);
  if (!match) return [];
  return match[1].split(",").map(f => f.trim()).filter(Boolean);
}

function hasFileOverlap(filesA: string[], filesB: string[]): boolean {
  const setB = new Set(filesB);
  return filesA.some(f => setB.has(f));
}

export async function runATCCycle(): Promise<ATCState> {
  const locked = await acquireATCLock();
  if (!locked) {
    return await getATCState(); // Return last known state
  }
  try {
    return await _runATCCycleInner();
  } finally {
    await releaseATCLock();
  }
}

async function _runATCCycleInner(): Promise<ATCState> {
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

    // Check for stall timeout (before fetching PR files to skip extra API calls)
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

    // Populate filesBeingModified: use PR files if available, else parse handoff metadata
    let filesBeingModified: string[] = [];
    if (pr && item.execution?.prNumber) {
      filesBeingModified = await getPRFiles(item.targetRepo, item.execution.prNumber);
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
      if (candidates.length === 0) continue;

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

        try {
          const result = await dispatchWorkItem(item.id);
          events.push(makeEvent(
            "auto_dispatch", item.id, "ready", "executing",
            `Auto-dispatched to ${repo.fullName} (branch: ${result.branch})`
          ));
          slotsRemaining--;
          // Update concurrency map for subsequent iterations this cycle
          concurrencyMap.set(repo.fullName, (concurrencyMap.get(repo.fullName) ?? 0) + 1);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          // Transition to failed so retry logic (section 3.5) handles it
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
  }

  // 4.1: Dependency block detection
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
    const TERMINAL_FAILURE_STATUSES = ["failed", "parked", "cancelled"];
    for (const item of blocked) {
      const deadDeps: string[] = [];
      for (const depId of item.dependencies) {
        const dep = await getWorkItem(depId);
        if (!dep) {
          // Dep blob missing — could be transient. Do NOT auto-cancel.
          console.warn(`[atc] Dead-dep check: dependency ${depId} for item ${item.id} returned null. Skipping (possible transient failure).`);
          continue; // Skip, don't treat as dead
        } else if (TERMINAL_FAILURE_STATUSES.includes(dep.status)) {
          // Dependency failed/parked/cancelled - will never reach "merged"
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

  // 3.5: Retry failed items (max 2 retries, then park)
  const MAX_RETRIES = 2;
  const failedThisCycle = events
    .filter(e => e.newStatus === "failed" && e.type !== "error")
    .map(e => e.workItemId);

  for (const failedId of failedThisCycle) {
    const item = await getWorkItem(failedId);
    if (!item) continue;
    const retryCount = item.execution?.retryCount ?? 0;

    if (retryCount < MAX_RETRIES) {
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

      try {
        const result = await decomposeProject(project);
        const workItems = result.workItems;

        if (workItems.length === 0) {
          await transitionToFailed(project);
          events.push(makeEvent(
            "error", project.projectId, "Executing", "Failed",
            `Decomposition produced 0 work items for "${project.title}", transitioning to Failed`
          ));
          continue;
        }

        // Save dedup key after successful decomposition
        await saveJson(dedupKey, { decomposedAt: now.toISOString(), workItemCount: workItems.length });

        events.push(makeEvent(
          "project_trigger", project.projectId, undefined, undefined,
          `Project "${project.title}" decomposed into ${workItems.length} work items`
        ));

        // Send decomposition summary email
        try {
          const { sendDecompositionSummary } = await import("./gmail");
          await sendDecompositionSummary(project, workItems, result.phases ?? undefined);
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

  // Section 13: Project completion detection
  try {
    const { listProjects, transitionToComplete, transitionToFailed } = await import("./projects");
    const executingProjects = await listProjects("Executing");

    for (const project of executingProjects) {
      // Find all work items for this project
      const allItems = await listWorkItems({});
      const projectItems: WorkItem[] = [];
      for (const entry of allItems) {
        const item = await getWorkItem(entry.id);
        if (item && item.source.type === "project" && item.source.sourceId === project.projectId) {
          projectItems.push(item);
        }
      }

      // Skip if no work items yet (decomposition pending)
      if (projectItems.length === 0) continue;

      const terminalStatuses = ["merged", "parked", "failed", "cancelled"];
      const allTerminal = projectItems.every((item) => terminalStatuses.includes(item.status));
      if (!allTerminal) continue;

      const hasFailed = projectItems.some((item) => item.status === "failed");
      if (hasFailed) {
        await transitionToFailed(project);
        events.push(makeEvent(
          "project_trigger",
          project.projectId,
          "Executing",
          "Failed",
          `Project "${project.title}" failed: ${projectItems.filter(i => i.status === "failed").length} work items failed`
        ));
      } else {
        await transitionToComplete(project);
        events.push(makeEvent(
          "project_trigger",
          project.projectId,
          "Executing",
          "Complete",
          `Project "${project.title}" complete: ${projectItems.filter(i => i.status === "merged").length} merged, ${projectItems.filter(i => i.status === "parked").length} parked`
        ));
      }
    }
  } catch (err) {
    console.error("[atc] Project completion detection failed:", err);
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

  // Cache metrics summary (observability)
  await summarizeDailyCacheMetrics().catch((err) =>
    console.error("[ATC] cache metrics summary failed:", err)
  );

  return state;
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
