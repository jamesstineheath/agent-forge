import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { persistEvents } from "@/lib/atc/events";
import { runHealthMonitor } from "@/lib/atc/health-monitor";
import { runHloPolling, type SupervisorPhaseOutput } from "@/lib/atc/supervisor";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import type { CycleContext } from "@/lib/atc/types";

const HEALTH_MONITOR_LOCK_KEY = "atc/health-monitor-lock";

export const healthMonitorCycle = inngest.createFunction(
  {
    id: "health-monitor-cycle",
    name: "Health Monitor Cycle",
    triggers: [
      { cron: "*/15 * * * *" },
      { event: "agent/health-monitor.requested" },
    ],
  },
  async ({ step }) => {
    // Step 1: Preflight
    const preflight = await step.run("preflight", async () => {
      if (await isPipelineKilled()) {
        return { skipped: true, reason: "kill-switch" } as const;
      }
      const locked = await acquireLock(HEALTH_MONITOR_LOCK_KEY);
      if (!locked) {
        return { skipped: true, reason: "lock held" } as const;
      }
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    try {
      // Step 2: Health Monitoring
      const healthResult = await step.run("health-monitoring", async () => {
        const ctx: CycleContext = { now: new Date(), events: [] };
        const activeExecutions = await runHealthMonitor(ctx);
        return { events: ctx.events, activeExecutions };
      });

      // Step 3: HLO Polling (absorbed from Supervisor)
      const hloResult = await step.run("hlo-polling", async () => {
        const start = Date.now();
        const output = await runHloPolling();
        return { output, durationMs: Date.now() - start };
      });

      // Step 4: Persist
      await step.run("persist", async () => {
        const allEvents = [...healthResult.events, ...hloResult.output.events];
        await persistEvents(allEvents);

        const queuedEntries = await listWorkItems({ status: "queued" });
        const readyEntries = await listWorkItems({ status: "ready" });
        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: healthResult.activeExecutions,
          queuedItems: queuedEntries.length + readyEntries.length,
          recentEvents: allEvents.slice(-20),
        });

        const trace = startTrace("health-monitor");
        addPhase(trace, { name: "health-check-cycle", durationMs: 0 });
        addPhase(trace, { name: "hlo-polling", durationMs: hloResult.durationMs });
        for (const e of hloResult.output.errors) addError(trace, `hlo-polling: ${e}`);
        completeTrace(trace, "success", `Health monitor cycle complete, ${allEvents.length} events`);
        await persistTrace(trace);
        await cleanupOldTraces("health-monitor", 7);

        await recordAgentRun("health-monitor");
        await releaseLock(HEALTH_MONITOR_LOCK_KEY);
      });

      return { success: true, events: healthResult.events.length + hloResult.output.events.length };
    } catch (err) {
      await step.run("release-lock-on-error", async () => {
        await releaseLock(HEALTH_MONITOR_LOCK_KEY);
      });
      throw err;
    }
  },
);
