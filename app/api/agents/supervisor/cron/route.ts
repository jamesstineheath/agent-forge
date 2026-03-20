import { NextRequest, NextResponse } from "next/server";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { PHASE_MANIFEST, type PhaseResult, type PhaseExecutionLog } from "@/lib/atc/supervisor-manifest";

export const maxDuration = 800;

const SUPERVISOR_LOCK_KEY = "atc/supervisor-lock";
const EXECUTION_LOG_KEY = "af-data/supervisor/execution-log";
const COORDINATOR_BUDGET_MS = 780_000; // 780s — leave 20s for cleanup (Pro Fluid Compute ceiling: 800s)

async function handleCron(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await isPipelineKilled()) {
    return NextResponse.json({ success: true, skipped: true, reason: "kill-switch" });
  }

  const locked = await acquireLock(SUPERVISOR_LOCK_KEY);
  if (!locked) {
    return NextResponse.json({ success: true, skipped: true, reason: "lock held" });
  }

  const cycleId = crypto.randomUUID();
  const cycleStart = Date.now();
  const now = new Date();
  const trace = startTrace('supervisor');
  const phaseResults: PhaseResult[] = [];
  const deferredPhases: string[] = [];
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3002';

  try {
    for (const phase of PHASE_MANIFEST) {
      const elapsed = Date.now() - cycleStart;
      const remaining = COORDINATOR_BUDGET_MS - elapsed;

      // Defer housekeeping phases if time budget is exhausted
      if (remaining < phase.timeoutMs && phase.tier === 'housekeeping') {
        deferredPhases.push(phase.name);
        phaseResults.push({
          name: phase.name,
          tier: phase.tier,
          status: 'deferred',
          durationMs: 0,
        });
        addDecision(trace, {
          action: 'phase_deferred',
          reason: `${phase.name} deferred — ${Math.round(remaining / 1000)}s remaining, needs ${Math.round(phase.timeoutMs / 1000)}s`,
        });
        continue;
      }

      // Skip standard phases if no time left
      if (remaining < phase.timeoutMs && phase.tier === 'standard') {
        phaseResults.push({
          name: phase.name,
          tier: phase.tier,
          status: 'skipped',
          durationMs: 0,
        });
        addDecision(trace, {
          action: 'phase_skipped',
          reason: `${phase.name} skipped — insufficient time budget`,
        });
        continue;
      }

      const phaseStart = Date.now();

      try {
        const response = await fetch(
          `${baseUrl}/api/agents/supervisor/phases/${phase.name}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${cronSecret}`,
            },
            body: JSON.stringify({ cycleId, timestamp: now.toISOString() }),
            signal: AbortSignal.timeout(phase.timeoutMs),
          }
        );

        const phaseDurationMs = Date.now() - phaseStart;

        if (response.ok) {
          const body = await response.json() as Partial<PhaseResult>;
          const result: PhaseResult = {
            name: phase.name,
            tier: phase.tier,
            status: body.status ?? 'success',
            durationMs: body.durationMs ?? phaseDurationMs,
            decisions: body.decisions,
            errors: body.errors,
            outputs: body.outputs,
          };
          phaseResults.push(result);

          // Add decisions to trace
          for (const decision of result.decisions ?? []) {
            addDecision(trace, { action: phase.name, reason: decision });
          }

          addPhase(trace, { name: phase.name, durationMs: result.durationMs });

          if (result.errors && result.errors.length > 0) {
            for (const err of result.errors) {
              addError(trace, `${phase.name}: ${err}`);
            }
          }
        } else {
          const errorText = await response.text().catch(() => 'unknown');
          phaseResults.push({
            name: phase.name,
            tier: phase.tier,
            status: 'failure',
            durationMs: phaseDurationMs,
            errors: [`HTTP ${response.status}: ${errorText.slice(0, 200)}`],
          });
          addError(trace, `${phase.name} failed: HTTP ${response.status}`);
          addPhase(trace, { name: phase.name, durationMs: phaseDurationMs });
        }
      } catch (err) {
        const phaseDurationMs = Date.now() - phaseStart;
        const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
        phaseResults.push({
          name: phase.name,
          tier: phase.tier,
          status: isTimeout ? 'timeout' : 'failure',
          durationMs: phaseDurationMs,
          errors: [isTimeout ? `Timed out after ${phase.timeoutMs}ms` : (err instanceof Error ? err.message : String(err))],
        });
        addError(trace, `${phase.name} ${isTimeout ? 'timed out' : 'failed'}: ${err instanceof Error ? err.message : String(err)}`);
        addPhase(trace, { name: phase.name, durationMs: phaseDurationMs });
      }
    }

    // Build and persist execution log
    const executionLog: PhaseExecutionLog = {
      cycleId,
      startedAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      totalDurationMs: Date.now() - cycleStart,
      phases: phaseResults,
      deferredPhases,
    };

    try {
      await saveJson(EXECUTION_LOG_KEY, executionLog);
    } catch (logErr) {
      console.error('[supervisor] Failed to persist execution log:', logErr);
    }

    // Complete and persist trace
    completeTrace(trace, 'success');
    try {
      await persistTrace(trace);
      await cleanupOldTraces('supervisor', 7);
    } catch (tracingErr) {
      console.error('[supervisor] Tracing failed (non-fatal):', tracingErr);
    }

    // Update ATC state snapshot
    const queuedEntries = await listWorkItems({ status: "queued" });
    const readyEntries = await listWorkItems({ status: "ready" });
    await saveJson(ATC_STATE_KEY, {
      lastRunAt: now.toISOString(),
      activeExecutions: [],
      queuedItems: queuedEntries.length + readyEntries.length,
      recentEvents: phaseResults.slice(-20).map(p => ({
        type: p.status,
        timestamp: now.toISOString(),
        details: `Phase ${p.name}: ${p.status} (${p.durationMs}ms)`,
      })),
    });

    await recordAgentRun("supervisor");

    const succeeded = phaseResults.filter(p => p.status === 'success').length;
    const failed = phaseResults.filter(p => p.status === 'failure' || p.status === 'timeout').length;
    const deferred = deferredPhases.length;

    return NextResponse.json({
      success: true,
      cycleId,
      totalDurationMs: Date.now() - cycleStart,
      phases: {
        total: PHASE_MANIFEST.length,
        succeeded,
        failed,
        deferred,
        skipped: phaseResults.filter(p => p.status === 'skipped').length,
      },
      executionLog,
    });
  } catch (err) {
    // Persist partial trace on unexpected coordinator error
    addError(trace, `Coordinator error: ${err instanceof Error ? err.message : String(err)}`);
    completeTrace(trace, 'error');
    try {
      await persistTrace(trace);
    } catch { /* non-fatal */ }

    try {
      await saveJson(ATC_STATE_KEY, {
        lastRunAt: new Date().toISOString(),
        activeExecutions: [],
        queuedItems: -1,
        recentEvents: [{
          type: 'error',
          timestamp: new Date().toISOString(),
          details: `Coordinator error: ${err instanceof Error ? err.message : String(err)}`,
        }],
      });
      await recordAgentRun("supervisor");
    } catch (stateErr) {
      console.error('[supervisor] Failed to persist error state:', stateErr);
    }

    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    await releaseLock(SUPERVISOR_LOCK_KEY);
  }
}

export const GET = handleCron;
export const POST = handleCron;
