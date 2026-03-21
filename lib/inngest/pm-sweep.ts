import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { writeExecutionLog } from "./execution-log";
import { runPmSweep, type SupervisorPhaseOutput } from "@/lib/atc/supervisor";
import { startTrace, addPhase, addError, completeTrace, persistTrace } from "@/lib/atc/tracing";

export const pmSweep = inngest.createFunction(
  {
    id: "pm-sweep",
    name: "PM Sweep",
    triggers: [
      { cron: "0 8 * * *" },
      { event: "agent/pm-sweep.requested" },
    ],
  },
  async ({ step }) => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'pm-sweep', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[pm-sweep] Failed to write running log:', e);
    }

    try {
    const preflight = await step.run("preflight", async () => {
      if (await isPipelineKilled()) {
        return { skipped: true, reason: "kill-switch" } as const;
      }
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    // Run the full PM sweep as a single step (includes backlog review, health assessment, digest)
    const result = await step.run("pm-sweep", async () => {
      const start = Date.now();
      const output = await runPmSweep();
      return { output, durationMs: Date.now() - start };
    });

    await step.run("persist", async () => {
      const trace = startTrace("supervisor");
      addPhase(trace, { name: "pm-sweep", durationMs: result.durationMs });
      for (const e of result.output.errors) addError(trace, `pm-sweep: ${e}`);
      completeTrace(trace, "success", `PM sweep: ${result.output.decisions.length} decisions`);
      await persistTrace(trace);
    });

    try {
      await writeExecutionLog({
        functionId: 'pm-sweep',
        status: 'success',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      });
    } catch (e) {
      console.error('[pm-sweep] Failed to write success log:', e);
    }

    return { success: true, decisions: result.output.decisions.length };
    } catch (err) {
      try {
        await writeExecutionLog({
          functionId: 'pm-sweep',
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (logErr) {
        console.error('[pm-sweep] Failed to write error log:', logErr);
      }
      throw err;
    }
  },
);
