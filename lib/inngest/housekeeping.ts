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
      { event: "agent/housekeeping.requested" },
    ],
  },
  async ({ step }) => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'housekeeping', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[housekeeping] Failed to write running log:', e);
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

    // Step 1: Branch Cleanup
    const branchResult = await step.run("branch-cleanup", async () => {
      const start = Date.now();
      const output = await runBranchCleanup();
      return { output, durationMs: Date.now() - start };
    });

    // Step 2: Drift Detection
    const driftResult = await step.run("drift-detection", async () => {
      const start = Date.now();
      const output = await runDriftDetection();
      return { output, durationMs: Date.now() - start };
    });

    // Step 3: Repo Reindex + Cache Metrics
    const maintenanceResult = await step.run("maintenance", async () => {
      const start = Date.now();
      const reindexOutput = await runRepoReindex();
      const cacheOutput = await runCacheMetrics();
      return {
        output: {
          decisions: [...reindexOutput.decisions, ...cacheOutput.decisions],
          errors: [...reindexOutput.errors, ...cacheOutput.errors],
          events: [...reindexOutput.events, ...cacheOutput.events],
        } satisfies SupervisorPhaseOutput,
        durationMs: Date.now() - start,
      };
    });

    await step.run("persist", async () => {
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
    });

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
