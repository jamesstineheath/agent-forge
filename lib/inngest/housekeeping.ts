import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
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
  async ({ step }) => {
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

    return { success: true };
  },
);
