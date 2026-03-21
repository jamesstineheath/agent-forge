import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
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
  async ({ step }) => {
    // Step 1: Preflight
    const preflight = await step.run("preflight", async () => {
      if (await isPipelineKilled()) {
        return { skipped: true, reason: "kill-switch" } as const;
      }
      const locked = await acquireLock(PROJECT_MANAGER_LOCK_KEY);
      if (!locked) {
        return { skipped: true, reason: "lock held" } as const;
      }
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    try {
      // Step 2: Run project manager (single step — decomposition inside can take minutes)
      const pmResult = await step.run("pm-agent-cycle", async () => {
        const ctx: CycleContext = { now: new Date(), events: [] };
        await runProjectManager(ctx);
        return { events: ctx.events };
      });

      // Step 3: Persist
      await step.run("persist", async () => {
        await persistEvents(pmResult.events);

        const queuedEntries = await listWorkItems({ status: "queued" });
        const readyEntries = await listWorkItems({ status: "ready" });
        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: [],
          queuedItems: queuedEntries.length + readyEntries.length,
          recentEvents: pmResult.events.slice(-20),
        });

        const trace = startTrace("project-manager");
        addPhase(trace, { name: "pm-cycle", durationMs: 0 });
        completeTrace(trace, "success", `Project manager cycle complete, ${pmResult.events.length} events`);
        await persistTrace(trace);
        await cleanupOldTraces("project-manager", 7);

        await recordAgentRun("project-manager");
        await releaseLock(PROJECT_MANAGER_LOCK_KEY);
      });

      return { success: true, events: pmResult.events.length };
    } catch (err) {
      await step.run("release-lock-on-error", async () => {
        await releaseLock(PROJECT_MANAGER_LOCK_KEY);
      });
      throw err;
    }
  },
);
