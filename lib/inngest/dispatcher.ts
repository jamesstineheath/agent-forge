import { inngest } from "./client";
import { writeExecutionLog } from "./execution-log";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { persistEvents } from "@/lib/atc/events";
import { runDispatcher } from "@/lib/atc/dispatcher";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import type { CycleContext } from "@/lib/atc/types";

const DISPATCHER_LOCK_KEY = "atc/dispatcher-lock";

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
    const preflight = await step.run("preflight", async () => {
      if (await isPipelineKilled()) {
        return { skipped: true, reason: "kill-switch" } as const;
      }
      const locked = await acquireLock(DISPATCHER_LOCK_KEY);
      if (!locked) {
        return { skipped: true, reason: "lock held" } as const;
      }
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    try {
      // Step 2: Dispatch
      const dispatchResult = await step.run("dispatch", async () => {
        const ctx: CycleContext = { now: new Date(), events: [] };
        const activeExecutions = await runDispatcher(ctx);
        return { events: ctx.events, activeExecutions };
      });

      // Step 3: Persist
      await step.run("persist", async () => {
        await persistEvents(dispatchResult.events);

        const queuedEntries = await listWorkItems({ status: "queued" });
        const readyEntries = await listWorkItems({ status: "ready" });
        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: dispatchResult.activeExecutions,
          queuedItems: queuedEntries.length + readyEntries.length,
          recentEvents: dispatchResult.events.slice(-20),
        });

        const trace = startTrace("dispatcher");
        const dispatchEvents = dispatchResult.events.filter((e) => e.type === "auto_dispatch");
        addPhase(trace, { name: "dispatch-cycle", durationMs: 0 });
        completeTrace(trace, "success", `Dispatched ${dispatchEvents.length} items, ${dispatchResult.events.length} events`);
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

      return { success: true, events: dispatchResult.events.length };
    } catch (err) {
      await step.run("release-lock-on-error", async () => {
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
