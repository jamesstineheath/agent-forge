import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { writeExecutionLog } from "./execution-log";
import { saveJson } from "@/lib/storage";
import { listPlans } from "@/lib/plans";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { persistEvents } from "@/lib/atc/events";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import type { ATCEvent } from "@/lib/atc/types";
import {
  runEscalationManagement,
  runIntentValidationPhase,
  runSpendMonitoring,
  runAgentHealth,
  type SupervisorPhaseOutput,
} from "@/lib/atc/supervisor";

export const pipelineOversight = inngest.createFunction(
  {
    id: "pipeline-oversight",
    name: "Pipeline Oversight",
    triggers: [
      { cron: "*/30 * * * *" },
      { event: "agent/supervisor.requested" },
    ],
  },
  async () => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'pipeline-oversight', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[pipeline-oversight] Failed to write running log:', e);
    }

    try {
    // Preflight: kill switch only (no lock needed for read-only monitoring)
    if (await isPipelineKilled()) {
      return { success: true, skipped: true, reason: "kill-switch" };
    }

    const allEvents: ATCEvent[] = [];

    // Step 1: Escalation Management
    const escalationStart = Date.now();
    const escalationOutput = await runEscalationManagement();
    const escalationResult = { output: escalationOutput, durationMs: Date.now() - escalationStart };
    allEvents.push(...escalationResult.output.events);

    // Step 2: Intent Validation
    const intentStart = Date.now();
    const intentOutput = await runIntentValidationPhase();
    const intentResult = { output: intentOutput, durationMs: Date.now() - intentStart };
    allEvents.push(...intentResult.output.events);

    // Step 3: Spend Monitoring
    const spendStart = Date.now();
    const spendOutput = await runSpendMonitoring();
    const spendResult = { output: spendOutput, durationMs: Date.now() - spendStart };
    allEvents.push(...spendResult.output.events);

    // Step 4: Agent Health
    const healthStart = Date.now();
    const healthOutput = await runAgentHealth();
    const healthResult = { output: healthOutput, durationMs: Date.now() - healthStart };
    allEvents.push(...healthResult.output.events);

    // Persist
    if (allEvents.length > 0) {
      await persistEvents(allEvents);
    }

    const trace = startTrace("supervisor");
    const phases = [
      { name: "escalation-management", result: escalationResult },
      { name: "intent-validation", result: intentResult },
      { name: "spend-monitoring", result: spendResult },
      { name: "agent-health", result: healthResult },
    ];

    for (const { name, result } of phases) {
      addPhase(trace, { name, durationMs: result.durationMs });
      for (const d of result.output.decisions) addDecision(trace, { action: name, reason: d });
      for (const e of result.output.errors) addError(trace, `${name}: ${e}`);
    }

    completeTrace(trace, "success", `Oversight cycle: ${allEvents.length} events`);
    await persistTrace(trace);

    // Update ATC state (Pipeline v2: plan counts)
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

    await recordAgentRun("supervisor");

    try {
      await writeExecutionLog({
        functionId: 'pipeline-oversight',
        status: 'success',
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
      });
    } catch (e) {
      console.error('[pipeline-oversight] Failed to write success log:', e);
    }

    return { success: true, events: allEvents.length };
    } catch (err) {
      try {
        await writeExecutionLog({
          functionId: 'pipeline-oversight',
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (logErr) {
        console.error('[pipeline-oversight] Failed to write error log:', logErr);
      }
      throw err;
    }
  },
);
