import { inngest } from "./client";
import { writeExecutionLog } from "./execution-log";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { saveJson } from "@/lib/storage";
import { listPlans } from "@/lib/plans";
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
    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    try {
      await writeExecutionLog({
        functionId: 'health-monitor-cycle',
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

      // Step 2b: Dashboard self-health check
      const dashboardHealth = await step.run(
        "dashboard-health-check",
        async () => {
          const { checkDashboardHealth } = await import(
            "@/lib/atc/health-monitor"
          );
          const result = await checkDashboardHealth();
          if (!result.healthy) {
            const { sendEmail } = await import("@/lib/gmail");
            await sendEmail({
              subject: "[Agent Forge] Dashboard API Health Alert",
              body: `Dashboard health check failed.\n\nFailing endpoints:\n${result.failures.map((f) => `- ${f}`).join("\n")}\n\nThis may indicate a database schema mismatch, a deployment failure, or an infrastructure issue. Check Vercel runtime logs for details.`,
            }).catch((err) =>
              console.error(
                "[health-monitor] Failed to send dashboard health alert:",
                err
              )
            );
          }
          return result;
        }
      );

      // Step 2c: Plan progress polling
      const progressResult = await step.run("plan-progress-polling", async () => {
        const { pollPlanProgress } = await import("@/lib/atc/plan-progress");
        return pollPlanProgress();
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

        // Pipeline v2: plan counts for ATC state
        const readyPlans = await listPlans({ status: "ready" });
        const executingPlans = await listPlans({ status: "executing" });
        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: executingPlans.map(p => ({
            workItemId: p.id,
            targetRepo: p.targetRepo,
            branch: p.branchName,
            status: p.status,
            startedAt: p.startedAt ?? p.createdAt,
            elapsedMinutes: p.startedAt ? Math.round((Date.now() - new Date(p.startedAt).getTime()) / 60000) : 0,
            filesBeingModified: p.affectedFiles ?? [],
          })),
          queuedItems: readyPlans.length,
          recentEvents: allEvents.slice(-20),
        });

        const trace = startTrace("health-monitor");
        addPhase(trace, { name: "health-check-cycle", durationMs: 0 });
        addPhase(trace, { name: "plan-progress-polling", durationMs: 0 });
        addPhase(trace, { name: "hlo-polling", durationMs: hloResult.durationMs });
        for (const e of hloResult.output.errors) addError(trace, `hlo-polling: ${e}`);
        completeTrace(trace, "success", `Health monitor cycle complete, ${allEvents.length} events`);
        await persistTrace(trace);
        await cleanupOldTraces("health-monitor", 7);

        await recordAgentRun("health-monitor");
        await releaseLock(HEALTH_MONITOR_LOCK_KEY);
      });

      try {
        await writeExecutionLog({
          functionId: 'health-monitor-cycle',
          status: 'success',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
        });
      } catch (_logErr) {
        // non-fatal
      }

      return { success: true, events: healthResult.events.length + hloResult.output.events.length };
    } catch (err) {
      await step.run("release-lock-on-error", async () => {
        await releaseLock(HEALTH_MONITOR_LOCK_KEY);
      });

      try {
        await writeExecutionLog({
          functionId: 'health-monitor-cycle',
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
