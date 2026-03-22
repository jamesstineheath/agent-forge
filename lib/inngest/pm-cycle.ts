import { inngest } from "./client";
import { writeExecutionLog } from "./execution-log";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { saveJson } from "@/lib/storage";
import { listPlans } from "@/lib/plans";
import { persistEvents } from "@/lib/atc/events";
import { runProjectManager } from "@/lib/atc/project-manager";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import type { CycleContext } from "@/lib/atc/types";

const PROJECT_MANAGER_LOCK_KEY = "atc/project-manager-lock";

export const pmCycle = inngest.createFunction(
  {
    id: "pm-cycle",
    name: "PM Cycle",
    triggers: [
      { cron: "*/30 * * * *" },
      { event: "agent/project-manager.requested" },
    ],
  },
  async () => {
    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    try {
      await writeExecutionLog({
        functionId: 'pm-cycle',
        status: 'running',
        startedAt,
        completedAt: null,
        durationMs: null,
      });
    } catch (_logErr) {
      // non-fatal
    }

    // Step 1: Preflight
    if (await isPipelineKilled()) {
      return { success: true, skipped: true, reason: "kill-switch" };
    }
    const locked = await acquireLock(PROJECT_MANAGER_LOCK_KEY);
    if (!locked) {
      return { success: true, skipped: true, reason: "lock held" };
    }

    try {
      // Step 2: Run project manager (single step — decomposition inside can take minutes)
      const ctx: CycleContext = { now: new Date(), events: [] };
      await runProjectManager(ctx);
      const pmResult = { events: ctx.events };

      // Step 3: Persist
      await persistEvents(pmResult.events);

      // Pipeline v2: plan counts for ATC state
      const readyPlans = await listPlans({ status: "ready" });
      await saveJson(ATC_STATE_KEY, {
        lastRunAt: new Date().toISOString(),
        activeExecutions: [],
        queuedItems: readyPlans.length,
        recentEvents: pmResult.events.slice(-20),
      });

      const trace = startTrace("project-manager");
      addPhase(trace, { name: "pm-cycle", durationMs: 0 });
      completeTrace(trace, "success", `Project manager cycle complete, ${pmResult.events.length} events`);
      await persistTrace(trace);
      await cleanupOldTraces("project-manager", 7);

      await recordAgentRun("project-manager");
      await releaseLock(PROJECT_MANAGER_LOCK_KEY);

      try {
        await writeExecutionLog({
          functionId: 'pm-cycle',
          status: 'success',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
        });
      } catch (_logErr) {
        // non-fatal
      }

      return { success: true, events: pmResult.events.length };
    } catch (err) {
      await releaseLock(PROJECT_MANAGER_LOCK_KEY);

      try {
        await writeExecutionLog({
          functionId: 'pm-cycle',
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
