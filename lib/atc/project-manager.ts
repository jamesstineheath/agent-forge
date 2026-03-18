/**
 * Agent 3: Project Manager
 *
 * Goal: Move projects from planning to completion.
 * Responsibilities:
 *   - §4: Project retry processing
 *   - §4.5: Plan quality gate + decomposition
 *   - §13a: Stuck "Executing" recovery
 *   - §13b: Project completion detection
 */

import { loadJson, saveJson, deleteJson } from "../storage";
import { listWorkItems, getWorkItem, updateWorkItem } from "../work-items";
import {
  getExecuteProjects,
  transitionToExecuting,
  transitionToFailed,
  checkProjectCompletion,
  transitionProject,
  writeOutcomeSummary,
  getRetryProjects,
  clearRetryFlag,
  markProjectFailedFromRetry,
} from "../projects";
import { decomposeProject } from "../decomposer";
import { validatePlan } from "../plan-validator";
import {
  escalate,
  findPendingProjectEscalation,
} from "../escalation";
import type { WorkItem } from "../types";
import type { CycleContext } from "./utils";
import { makeEvent, recordAgentRun } from "./utils";

// Projects with human-authored plans that predate the PM quality gate.
// These bypass the plan quality gate check in §4.5.
const QUALITY_GATE_EXEMPT_PROJECTS = new Set([
  "PRJ-9", // PA Real Estate Agent v2 — human-authored plan
]);

export async function runProjectManager(ctx: CycleContext): Promise<void> {
  const start = Date.now();
  const { now, events } = ctx;

  // §4 — Project retry processing
  try {
    const retryProjects = await getRetryProjects();
    if (retryProjects.length > 0) {
      console.log(
        `[project-manager] §4: found ${retryProjects.length} project(s) flagged for retry`,
      );
    }

    for (const project of retryProjects) {
      const retryCount = project.retryCount ?? 0;

      if (retryCount >= 3) {
        console.log(
          `[project-manager] §4: project ${project.projectId} has hit retry cap (retryCount=${retryCount}), marking failed`,
        );
        await markProjectFailedFromRetry(project.id);
        events.push(
          makeEvent(
            "project_retry",
            project.projectId,
            undefined,
            "Failed",
            `Retry cap exceeded (retryCount=${retryCount}), marked Failed`,
          ),
        );
        continue;
      }

      // Clear the dedup guard so §4.5 will re-decompose this project
      try {
        await deleteJson(`atc/project-decomposed/${project.projectId}`);
        console.log(
          `[project-manager] §4: cleared dedup guard for project ${project.projectId}`,
        );
      } catch {
        console.log(
          `[project-manager] §4: no dedup guard to clear for project ${project.projectId} (ok)`,
        );
      }

      // Cancel stale work items from previous attempt
      const staleStates: WorkItem["status"][] = [
        "failed",
        "parked",
        "blocked",
        "ready",
        "filed",
        "queued",
      ];
      const allEntries = await listWorkItems({});
      const projectItems: WorkItem[] = [];
      for (const entry of allEntries) {
        const wi = await getWorkItem(entry.id);
        if (
          wi &&
          wi.source.type === "project" &&
          wi.source.sourceId === project.projectId
        ) {
          projectItems.push(wi);
        }
      }
      const itemsToCancel = projectItems.filter((item) =>
        staleStates.includes(item.status),
      );

      for (const item of itemsToCancel) {
        await updateWorkItem(item.id, { status: "cancelled" });
      }
      console.log(
        `[project-manager] §4: cancelled ${itemsToCancel.length} stale work items for project ${project.projectId}`,
      );

      await clearRetryFlag(project.id, retryCount);

      events.push(
        makeEvent(
          "project_retry",
          project.projectId,
          undefined,
          "Execute",
          `Retry initiated (newRetryCount=${retryCount + 1}, cancelledItems=${itemsToCancel.length})`,
        ),
      );

      console.log(
        `[project-manager] §4: project ${project.projectId} reset for retry (attempt ${retryCount + 1})`,
      );
    }
  } catch (err) {
    console.error(`[project-manager] §4 error:`, err);
  }

  // §4.5: Detect Notion projects with Status = "Execute", transition, and decompose
  try {
    const executeProjects = await getExecuteProjects();
    for (const project of executeProjects) {
      const success = await transitionToExecuting(project);
      if (!success) continue;

      // Dedup guard
      const dedupKey = `atc/project-decomposed/${project.projectId}`;
      const alreadyDecomposed = await loadJson<{ decomposedAt: string }>(
        dedupKey,
      );

      // Partial-failure recovery
      if (alreadyDecomposed) {
        const existingItems = await listWorkItems({});
        const projectWorkItems: WorkItem[] = [];
        for (const entry of existingItems) {
          const wi = await getWorkItem(entry.id);
          if (
            wi &&
            wi.source.type === "project" &&
            wi.source.sourceId === project.projectId
          ) {
            projectWorkItems.push(wi);
          }
        }

        if (projectWorkItems.length === 0) {
          console.warn(
            `[project-manager] Partial-failure recovery: project ${project.projectId} has dedup guard but 0 work items. Clearing guard.`,
          );
          await deleteJson(dedupKey);
        } else {
          events.push(
            makeEvent(
              "project_trigger",
              project.projectId,
              undefined,
              undefined,
              `Dedup guard: project "${project.title}" already decomposed at ${alreadyDecomposed.decomposedAt}, skipping`,
            ),
          );
          continue;
        }
      }

      events.push(
        makeEvent(
          "status_change",
          project.projectId,
          "Execute",
          "Executing",
          `Project "${project.title}" (${project.projectId}) transitioned to Executing`,
        ),
      );

      // §4.5 Plan Quality Gate — loop-detection guard
      const loopGuardKey = `atc/decomp-attempts/${project.projectId}`;
      const loopGuard = await loadJson<{ attempts: number }>(loopGuardKey);
      const currentAttempts = (loopGuard?.attempts ?? 0) + 1;
      await saveJson(loopGuardKey, { attempts: currentAttempts });

      if (currentAttempts > 3) {
        console.error(
          `[project-manager §4.5 Loop Guard] Project "${project.title}" (${project.projectId}) has attempted decomposition ${currentAttempts} times without success. Forcing to Failed.`,
        );
        await transitionToFailed(project);
        await deleteJson(loopGuardKey);
        events.push(
          makeEvent(
            "error",
            project.projectId,
            "Executing",
            "Failed",
            `Decomposition loop detected after ${currentAttempts} attempts for "${project.title}". Forced to Failed.`,
          ),
        );
        continue;
      }

      // Bypass quality gate for exempt projects
      const isExempt = QUALITY_GATE_EXEMPT_PROJECTS.has(project.projectId);
      if (isExempt) {
        console.log(
          `[project-manager §4.5] Project "${project.title}" (${project.projectId}) is exempt from quality gate — proceeding to decomposition.`,
        );
      }

      if (!isExempt) {
        const validation = await validatePlan(project.id);
        if (!validation.valid) {
          const failedChecks = validation.issues.map(
            (i) =>
              `[${i.severity.toUpperCase()}]${i.section ? ` ${i.section}:` : ""} ${i.message}`,
          );
          const issueList = failedChecks.join("\n");

          const rejectionReason =
            `Plan quality gate rejected project "${project.title}" (${project.projectId}). ` +
            `Checks failed: ${failedChecks.join("; ")}. ` +
            `Project will be transitioned to Failed to prevent infinite loop. ` +
            `If this project has a human-authored plan, add its projectId to QUALITY_GATE_EXEMPT_PROJECTS in lib/atc/project-manager.ts to bypass.`;
          console.error(
            `[project-manager §4.5 Quality Gate] ${rejectionReason}`,
          );

          const escalationReason = `Plan validation found ${validation.issues.length} issue(s):\n\n${issueList}\n\nProject transitioned to Failed. Fix the plan and re-trigger, or add to QUALITY_GATE_EXEMPT_PROJECTS if this is a human-authored plan.`;

          const existingEscalation = await findPendingProjectEscalation(
            project.projectId,
            escalationReason,
          );
          if (existingEscalation) {
            console.log(
              `[project-manager §4.5] Pending escalation already exists for project ${project.projectId}, skipping email`,
            );
          } else {
            try {
              await escalate(
                `project-${project.projectId}`,
                escalationReason,
                0.9,
                { projectTitle: project.title, issues: validation.issues },
                project.projectId,
              );
            } catch (emailErr) {
              console.error(
                `[project-manager §4.5] Failed to send escalation email for ${project.title}:`,
                emailErr,
              );
            }
          }

          await transitionToFailed(project);
          events.push(
            makeEvent(
              "error",
              project.projectId,
              "Executing",
              "Failed",
              `Plan quality gate rejected "${project.title}": ${validation.issues.length} issue(s). Transitioned to Failed.`,
            ),
          );
          continue;
        }
      }

      console.log(
        `[project-manager §4.5] Plan validated for ${project.title}, proceeding to decomposition`,
      );

      try {
        const result = await decomposeProject(project);
        const workItems = result.workItems;

        if (workItems.length === 0) {
          console.error(
            `[project-manager] Decomposition produced 0 work items for "${project.title}" (${project.projectId}). ` +
              `Transitioning to Failed.`,
          );
          await transitionToFailed(project);
          events.push(
            makeEvent(
              "error",
              project.projectId,
              "Executing",
              "Failed",
              `Decomposition produced 0 work items for "${project.title}", transitioning to Failed`,
            ),
          );
          continue;
        }

        await saveJson(dedupKey, {
          decomposedAt: now.toISOString(),
          workItemCount: workItems.length,
        });
        await deleteJson(loopGuardKey);

        events.push(
          makeEvent(
            "project_trigger",
            project.projectId,
            undefined,
            undefined,
            `Project "${project.title}" decomposed into ${workItems.length} work items`,
          ),
        );

        // Send decomposition summary email
        try {
          const { sendDecompositionSummary } = await import("../gmail");
          await sendDecompositionSummary(
            project,
            workItems,
            result.phases ?? undefined,
            result.phaseBreakdown,
          );
        } catch (emailErr) {
          console.error(
            "[project-manager] Decomposition summary email failed:",
            emailErr,
          );
        }
      } catch (decomposeErr) {
        const msg =
          decomposeErr instanceof Error
            ? decomposeErr.message
            : String(decomposeErr);
        console.error(
          `[project-manager] Decomposition failed for project ${project.projectId}:`,
          decomposeErr,
        );
        await transitionToFailed(project);
        events.push(
          makeEvent(
            "error",
            project.projectId,
            "Executing",
            "Failed",
            `Decomposition failed for "${project.title}": ${msg}`,
          ),
        );
      }
    }
  } catch (err) {
    console.error("[project-manager] Project sweep failed:", err);
  }

  // §13: Project lifecycle management
  try {
    const { listProjects } = await import("../projects");
    const { updateProjectStatus } = await import("../notion");
    const executingProjects = await listProjects("Executing");

    // Cache the full work item list once
    const allItemEntries = await listWorkItems({});
    const allItemsById = new Map<string, WorkItem>();
    for (const entry of allItemEntries) {
      const item = await getWorkItem(entry.id);
      if (item) allItemsById.set(item.id, item);
    }

    for (const project of executingProjects) {
      const projectItems = [...allItemsById.values()].filter(
        (item) =>
          item.source.type === "project" &&
          item.source.sourceId === project.projectId,
      );

      // §13a: Stuck Executing recovery
      if (projectItems.length === 0) {
        const dedupKey = `atc/project-decomposed/${project.projectId}`;
        const hasDedup = await loadJson<{ decomposedAt: string }>(dedupKey);
        if (!hasDedup) {
          await updateProjectStatus(project.id, "Execute");
          events.push(
            makeEvent(
              "project_trigger",
              project.projectId,
              "Executing",
              "Execute",
              `Stuck recovery: project "${project.title}" was Executing with no work items and no dedup guard. Reset to Execute for re-decomposition.`,
            ),
          );
        }
        continue;
      }

      // §13b: Project completion detection
      const result = await checkProjectCompletion(project.projectId, [
        ...allItemsById.values(),
      ]);

      if (result.isTerminal && result.status) {
        await transitionProject(project.id, result.status, result.summary);

        events.push(
          makeEvent(
            "project_completion",
            project.projectId,
            "Executing",
            result.status,
            `Project "${project.title}" → ${result.status}: ${result.summary}`,
          ),
        );

        console.log(
          `[project-manager §13b] Project ${project.projectId} transitioned to ${result.status}: ${result.summary}`,
        );

        try {
          await writeOutcomeSummary(project.projectId, result.status);
          console.log(
            `[project-manager §13b] Outcome summary written for project ${project.projectId} → ${result.status}`,
          );
        } catch (summaryErr) {
          console.error(
            `[project-manager §13b] Failed to write outcome summary for project ${project.projectId}: ${summaryErr}`,
          );
        }
      }
    }
  } catch (err) {
    console.error("[project-manager] Project lifecycle management failed:", err);
  }

  await recordAgentRun("project-manager", Date.now() - start);
}
