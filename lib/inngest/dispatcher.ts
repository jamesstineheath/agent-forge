import { inngest } from "./client";
import { writeExecutionLog } from "./execution-log";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { saveJson } from "@/lib/storage";
import { listPlans, getActivePlansForRepo, updatePlanStatus } from "@/lib/plans";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addDecision, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import { generatePlanPrompt } from "@/lib/plan-prompt";
import { triggerWorkflow } from "@/lib/github";
import type { Plan } from "@/lib/types";

const DISPATCHER_LOCK_KEY = "atc/dispatcher-lock";

/**
 * Check if a plan can be dispatched based on KG file overlap with active plans.
 * Plans targeting different repos always pass. Within the same repo, check file overlap.
 */
async function canDispatch(plan: Plan, activePlans: Plan[]): Promise<boolean> {
  const sameRepoActive = activePlans.filter(p => p.targetRepo === plan.targetRepo);
  if (sameRepoActive.length === 0) return true;

  const planFiles = new Set<string>(plan.affectedFiles ?? []);
  if (planFiles.size === 0) return false; // Conservative: no KG data = no parallel

  for (const active of sameRepoActive) {
    const activeFiles = new Set<string>(active.affectedFiles ?? []);
    const overlap = [...planFiles].filter(f => activeFiles.has(f));
    if (overlap.length > 0) return false;
  }
  return true;
}

/**
 * Pipeline v2 Dispatcher: dispatches ready Plans to execute-handoff workflow.
 *
 * Replaces the work-item dispatcher. Plans targeting different repos run in
 * parallel. Same-repo plans only dispatch if no file overlap in blast radius.
 */
export const dispatcherCycle = inngest.createFunction(
  {
    id: "dispatcher-cycle",
    name: "Dispatcher Cycle",
    triggers: [
      { cron: "*/15 * * * *" },
      { event: "agent/dispatcher.requested" },
    ],
  },
  async ({ step }) => {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    try {
      await writeExecutionLog({
        functionId: 'dispatcher-cycle',
        status: 'running',
        startedAt,
        completedAt: null,
        durationMs: null,
      });
    } catch (_logErr) {
      // non-fatal
    }

    // Step 1: Preflight
    const preflight = await step.run("v2-preflight", async () => {
      console.log("[dispatcher v2] Starting preflight");
      if (await isPipelineKilled()) {
        console.log("[dispatcher v2] Kill switch is ON — skipping");
        return { skipped: true, reason: "kill-switch" } as const;
      }
      const locked = await acquireLock(DISPATCHER_LOCK_KEY);
      if (!locked) {
        console.log("[dispatcher v2] Lock held — skipping");
        return { skipped: true, reason: "lock held" } as const;
      }
      console.log("[dispatcher v2] Preflight passed");
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    const trace = startTrace("dispatcher");
    const decisions: string[] = [];

    try {
      // Step 2: Dispatch ready plans
      const dispatchResult = await step.run("v2-dispatch-plans", async () => {
        const readyPlans = await listPlans({ status: "ready" });
        if (readyPlans.length === 0) {
          return { dispatched: 0, skipped: 0, decisions: ["No ready plans"] };
        }

        // Sort by PRD rank (lower = higher priority), then by createdAt
        readyPlans.sort((a, b) => {
          if (a.prdRank !== null && b.prdRank !== null) {
            return a.prdRank - b.prdRank;
          }
          if (a.prdRank !== null) return -1;
          if (b.prdRank !== null) return 1;
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        let dispatched = 0;
        let skipped = 0;
        const localDecisions: string[] = [];

        for (const plan of readyPlans) {
          // Check concurrency: can we dispatch this plan?
          const activePlans = await getActivePlansForRepo(plan.targetRepo);
          const allowed = await canDispatch(plan, activePlans);

          if (!allowed) {
            skipped++;
            localDecisions.push(`Skipped "${plan.prdTitle}" — file overlap with active plan in ${plan.targetRepo}`);
            continue;
          }

          try {
            // Update status to dispatching
            await updatePlanStatus(plan.id, "dispatching");

            // Extract repo short name for workflow dispatch
            const repoFullName = plan.targetRepo.includes("/")
              ? plan.targetRepo
              : `jamesstineheath/${plan.targetRepo}`;

            // Trigger execute-handoff workflow with plan inputs
            await triggerWorkflow(repoFullName, "execute-handoff.yml", plan.branchName, {
              plan_id: plan.id,
              max_budget: String(plan.estimatedBudget ?? 10),
              max_duration_minutes: String(plan.maxDurationMinutes ?? 60),
            });

            dispatched++;
            localDecisions.push(
              `Dispatched "${plan.prdTitle}" to ${repoFullName} (branch: ${plan.branchName}, budget: $${plan.estimatedBudget})`
            );
            console.log(`[dispatcher] Dispatched plan ${plan.id} for "${plan.prdTitle}"`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await updatePlanStatus(plan.id, "failed", {
              errorLog: `Dispatch failed: ${msg}`,
            });
            localDecisions.push(`Failed to dispatch "${plan.prdTitle}": ${msg}`);
            console.error(`[dispatcher] Failed to dispatch plan ${plan.id}:`, err);
          }
        }

        return { dispatched, skipped, decisions: localDecisions };
      });

      decisions.push(...dispatchResult.decisions);

      // Step 3: Persist
      await step.run("v2-persist", async () => {
        const readyPlans = await listPlans({ status: "ready" });
        const executingPlans = await listPlans({ status: "executing" });
        const dispatchingPlans = await listPlans({ status: "dispatching" });

        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: [...executingPlans, ...dispatchingPlans].map(p => ({
            workItemId: p.id,
            targetRepo: p.targetRepo,
            branch: p.branchName,
            status: p.status,
            startedAt: p.startedAt ?? p.createdAt,
            elapsedMinutes: p.startedAt
              ? Math.round((Date.now() - new Date(p.startedAt).getTime()) / 60000)
              : 0,
            filesBeingModified: p.affectedFiles ?? [],
          })),
          queuedItems: readyPlans.length,
          recentEvents: decisions.slice(-20).map(d => ({
            type: "auto_dispatch" as const,
            timestamp: new Date().toISOString(),
            details: d,
          })),
        });

        addPhase(trace, { name: "dispatch-plans", durationMs: Date.now() - startTime });
        for (const d of decisions) addDecision(trace, { action: "dispatch", reason: d });
        completeTrace(trace, "success", `Dispatched ${dispatchResult.dispatched}, skipped ${dispatchResult.skipped}`);
        await persistTrace(trace);
        await cleanupOldTraces("dispatcher", 7);
        await recordAgentRun("dispatcher");
        await releaseLock(DISPATCHER_LOCK_KEY);
      });

      try {
        await writeExecutionLog({
          functionId: 'dispatcher-cycle',
          status: 'success',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
        });
      } catch (_logErr) {
        // non-fatal
      }

      return { success: true, dispatched: dispatchResult.dispatched };
    } catch (err) {
      await step.run("v2-release-lock-on-error", async () => {
        await releaseLock(DISPATCHER_LOCK_KEY);
      });

      try {
        await writeExecutionLog({
          functionId: 'dispatcher-cycle',
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (_logErr) {
        // non-fatal
      }

      throw err;
    }
  },
);
