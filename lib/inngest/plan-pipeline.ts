import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { writeExecutionLog } from "./execution-log";
import { loadJson, saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import type { PhaseResult, PhaseExecutionLog } from "@/lib/atc/supervisor-manifest";
import {
  runCriteriaImport,
  runArchitecturePlanning,
  runDecomposition,
  type SupervisorPhaseOutput,
} from "@/lib/atc/supervisor";

const SUPERVISOR_LOCK_KEY = "atc/supervisor-lock";
const EXECUTION_LOG_KEY = "af-data/supervisor/execution-log";
const EXECUTION_LOG_HISTORY_KEY = "af-data/supervisor/execution-log-history";
const MAX_HISTORY_ENTRIES = 10;

function phaseResultFromOutput(
  name: string,
  tier: "critical" | "standard" | "housekeeping",
  output: SupervisorPhaseOutput,
  durationMs: number,
): PhaseResult {
  return {
    name,
    tier,
    status: output.errors.length > 0 ? "failure" : "success",
    durationMs,
    decisions: output.decisions.length > 0 ? output.decisions : undefined,
    errors: output.errors.length > 0 ? output.errors : undefined,
  };
}

export const planPipeline = inngest.createFunction(
  {
    id: "plan-pipeline",
    name: "Plan Pipeline",
    triggers: [
      { cron: "*/10 * * * *" },
      { event: "agent/supervisor.requested" },
    ],
  },
  async ({ step }) => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'plan-pipeline', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[plan-pipeline] Failed to write running log:', e);
    }

    // Step 1: Preflight — kill switch + lock
    const preflight = await step.run("preflight", async () => {
      if (await isPipelineKilled()) {
        return { skipped: true, reason: "kill-switch" } as const;
      }
      const locked = await acquireLock(SUPERVISOR_LOCK_KEY);
      if (!locked) {
        return { skipped: true, reason: "lock held" } as const;
      }
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    const cycleId = crypto.randomUUID();
    const cycleStart = Date.now();
    const phaseResults: PhaseResult[] = [];

    try {
      // Step 2: Criteria Import
      const criteriaResult = await step.run("criteria-import", async () => {
        const start = Date.now();
        const output = await runCriteriaImport();
        return { output, durationMs: Date.now() - start };
      });
      phaseResults.push(
        phaseResultFromOutput("criteria-import", "critical", criteriaResult.output, criteriaResult.durationMs),
      );

      // Step 3: Architecture Planning (can take up to 800s)
      const archResult = await step.run("architecture-planning", async () => {
        const start = Date.now();
        const output = await runArchitecturePlanning();
        return { output, durationMs: Date.now() - start };
      });
      phaseResults.push(
        phaseResultFromOutput("architecture-planning", "critical", archResult.output, archResult.durationMs),
      );

      // Step 4: Decomposition (can take up to 800s)
      const decompResult = await step.run("decomposition", async () => {
        const start = Date.now();
        const output = await runDecomposition();
        return { output, durationMs: Date.now() - start };
      });
      phaseResults.push(
        phaseResultFromOutput("decomposition", "critical", decompResult.output, decompResult.durationMs),
      );

      // Step 5: Persist results
      await step.run("persist-results", async () => {
        const executionLog: PhaseExecutionLog = {
          cycleId,
          startedAt: new Date(cycleStart).toISOString(),
          completedAt: new Date().toISOString(),
          totalDurationMs: Date.now() - cycleStart,
          phases: phaseResults,
          deferredPhases: [],
        };

        // Persist execution log
        await saveJson(EXECUTION_LOG_KEY, executionLog);

        // Append to rolling history
        let history: PhaseExecutionLog[] = [];
        try {
          const existing = await loadJson<PhaseExecutionLog[]>(EXECUTION_LOG_HISTORY_KEY);
          if (existing) history = existing;
        } catch { /* first run */ }
        history.unshift(executionLog);
        if (history.length > MAX_HISTORY_ENTRIES) history = history.slice(0, MAX_HISTORY_ENTRIES);
        await saveJson(EXECUTION_LOG_HISTORY_KEY, history);

        // Write trace
        const trace = startTrace("supervisor");
        for (const pr of phaseResults) {
          addPhase(trace, { name: pr.name, durationMs: pr.durationMs });
          if (pr.errors) {
            for (const err of pr.errors) addError(trace, `${pr.name}: ${err}`);
          }
          if (pr.decisions) {
            for (const d of pr.decisions) addDecision(trace, { action: pr.name, reason: d });
          }
        }
        completeTrace(trace, "success");
        await persistTrace(trace);
        await cleanupOldTraces("supervisor", 7);

        // Update ATC state
        const queuedEntries = await listWorkItems({ status: "queued" });
        const readyEntries = await listWorkItems({ status: "ready" });
        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: [],
          queuedItems: queuedEntries.length + readyEntries.length,
          recentEvents: phaseResults.slice(-20).map((p) => ({
            type: p.status,
            timestamp: new Date().toISOString(),
            details: `Phase ${p.name}: ${p.status} (${p.durationMs}ms)`,
          })),
        });

        await recordAgentRun("supervisor");
        await releaseLock(SUPERVISOR_LOCK_KEY);

        return executionLog;
      });

      try {
        await writeExecutionLog({
          functionId: 'plan-pipeline',
          status: 'success',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
        });
      } catch (e) {
        console.error('[plan-pipeline] Failed to write success log:', e);
      }

      return { success: true, cycleId, phases: phaseResults.length };
    } catch (err) {
      try {
        await writeExecutionLog({
          functionId: 'plan-pipeline',
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (logErr) {
        console.error('[plan-pipeline] Failed to write error log:', logErr);
      }

      // Ensure lock is released on error
      await step.run("release-lock-on-error", async () => {
        await releaseLock(SUPERVISOR_LOCK_KEY);
      });
      throw err;
    }
  },
);
