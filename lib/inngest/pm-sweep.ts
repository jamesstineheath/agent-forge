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
    ],
  },
  async () => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'pm-sweep', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[pm-sweep] Failed to write running log:', e);
    }

    try {
    if (await isPipelineKilled()) {
      return { success: true, skipped: true, reason: "kill-switch" };
    }

    // Run the full PM sweep as a single step (includes backlog review, health assessment, digest)
    const sweepStart = Date.now();
    const sweepOutput = await runPmSweep();
    const result = { output: sweepOutput, durationMs: Date.now() - sweepStart };

    // Persist
    const trace = startTrace("supervisor");
    addPhase(trace, { name: "pm-sweep", durationMs: result.durationMs });
    for (const e of result.output.errors) addError(trace, `pm-sweep: ${e}`);
    completeTrace(trace, "success", `PM sweep: ${result.output.decisions.length} decisions`);
    await persistTrace(trace);

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
