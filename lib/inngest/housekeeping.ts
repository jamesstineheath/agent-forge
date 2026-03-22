import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { writeExecutionLog } from "./execution-log";
import {
  runBranchCleanup,
  runDriftDetection,
  runRepoReindex,
  runCacheMetrics,
  type SupervisorPhaseOutput,
} from "@/lib/atc/supervisor";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace } from "@/lib/atc/tracing";

export const housekeeping = inngest.createFunction(
  {
    id: "housekeeping",
    name: "Housekeeping",
    triggers: [
      { cron: "0 */6 * * *" },
    ],
  },
  async () => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'housekeeping', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[housekeeping] Failed to write running log:', e);
    }

    try {
    if (await isPipelineKilled()) {
      return { success: true, skipped: true, reason: "kill-switch" };
    }

    // Step 1: Branch Cleanup
    const branchStart = Date.now();
    const branchOutput = await runBranchCleanup();
    const branchResult = { output: branchOutput, durationMs: Date.now() - branchStart };

    // Step 2: Drift Detection
    const driftStart = Date.now();
    const driftOutput = await runDriftDetection();
    const driftResult = { output: driftOutput, durationMs: Date.now() - driftStart };

    // Step 3: Repo Reindex + Cache Metrics
    const maintenanceStart = Date.now();
    const reindexOutput = await runRepoReindex();
    const cacheOutput = await runCacheMetrics();
    const maintenanceResult = {
      output: {
        decisions: [...reindexOutput.decisions, ...cacheOutput.decisions],
        errors: [...reindexOutput.errors, ...cacheOutput.errors],
        events: [...reindexOutput.events, ...cacheOutput.events],
      } satisfies SupervisorPhaseOutput,
      durationMs: Date.now() - maintenanceStart,
    };

    // Persist
    const trace = startTrace("supervisor");
    const phases = [
      { name: "branch-cleanup", result: branchResult },
      { name: "drift-detection", result: driftResult },
      { name: "maintenance", result: maintenanceResult },
    ];

    for (const { name, result } of phases) {
      addPhase(trace, { name, durationMs: result.durationMs });
      for (const d of result.output.decisions) addDecision(trace, { action: name, reason: d });
      for (const e of result.output.errors) addError(trace, `${name}: ${e}`);
    }

    completeTrace(trace, "success", "Housekeeping cycle complete");
    await persistTrace(trace);

    try {
      await writeExecutionLog({
        functionId: 'housekeeping',
        status: 'success',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      });
    } catch (e) {
      console.error('[housekeeping] Failed to write success log:', e);
    }

    return { success: true };
    } catch (err) {
      try {
        await writeExecutionLog({
          functionId: 'housekeeping',
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (logErr) {
        console.error('[housekeeping] Failed to write error log:', logErr);
      }
      throw err;
    }
  },
);
