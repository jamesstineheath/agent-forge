import { NextRequest, NextResponse } from "next/server";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { persistEvents } from "@/lib/atc/events";
import { runHealthMonitor } from "@/lib/atc/health-monitor";
import { withTimeout, recordAgentRun } from "@/lib/atc/utils";
import { CYCLE_TIMEOUT_MS, ATC_STATE_KEY, CycleTimeoutError } from "@/lib/atc/types";
import type { CycleContext } from "@/lib/atc/types";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { startTrace, addPhase, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";

export const maxDuration = 300;

const HEALTH_MONITOR_LOCK_KEY = "atc/health-monitor-lock";

async function handleCron(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await isPipelineKilled()) {
    return NextResponse.json({ success: true, skipped: true, reason: "kill-switch" });
  }

  const locked = await acquireLock(HEALTH_MONITOR_LOCK_KEY);
  if (!locked) {
    return NextResponse.json({ success: true, skipped: true, reason: "lock held" });
  }

  const trace = startTrace('health-monitor');

  try {
    const ctx: CycleContext = { now: new Date(), events: [] };
    const activeExecutions = await withTimeout(runHealthMonitor(ctx), CYCLE_TIMEOUT_MS);

    // Persist events
    await persistEvents(ctx.events);

    // Update state snapshot
    const queuedEntries = await listWorkItems({ status: "queued" });
    const readyEntries = await listWorkItems({ status: "ready" });
    await saveJson(ATC_STATE_KEY, {
      lastRunAt: ctx.now.toISOString(),
      activeExecutions,
      queuedItems: queuedEntries.length + readyEntries.length,
      recentEvents: ctx.events.slice(-20),
    });

    addPhase(trace, { name: 'health-check-cycle', durationMs: Date.now() - trace._startMs });
    completeTrace(trace, 'success', `Health monitor cycle complete, ${ctx.events.length} events`);

    await recordAgentRun("health-monitor");

    return NextResponse.json({
      success: true,
      state: {
        lastRunAt: ctx.now.toISOString(),
        activeExecutions: activeExecutions.length,
        queuedItems: queuedEntries.length + readyEntries.length,
        eventsThisCycle: ctx.events.length,
      },
    });
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      console.error(`[health-monitor] Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout.`);
      addError(trace, `Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout`);
      completeTrace(trace, 'error');
      return NextResponse.json({ success: true, timedOut: true });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    addError(trace, message);
    completeTrace(trace, 'error');
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    try {
      await persistTrace(trace);
      await cleanupOldTraces('health-monitor', 7);
    } catch { /* non-fatal */ }
    await releaseLock(HEALTH_MONITOR_LOCK_KEY);
  }
}

export const GET = handleCron;
export const POST = handleCron;
