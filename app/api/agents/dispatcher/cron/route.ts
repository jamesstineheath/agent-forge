import { NextRequest, NextResponse } from "next/server";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { persistEvents } from "@/lib/atc/events";
import { runDispatcher } from "@/lib/atc/dispatcher";
import { withTimeout, recordAgentRun } from "@/lib/atc/utils";
import { CYCLE_TIMEOUT_MS, ATC_STATE_KEY, CycleTimeoutError } from "@/lib/atc/types";
import type { CycleContext } from "@/lib/atc/types";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { startTrace, addPhase, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";

export const maxDuration = 300;

const DISPATCHER_LOCK_KEY = "atc/dispatcher-lock";

async function handleCron(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await isPipelineKilled()) {
    return NextResponse.json({ success: true, skipped: true, reason: "kill-switch" });
  }

  const locked = await acquireLock(DISPATCHER_LOCK_KEY);
  if (!locked) {
    return NextResponse.json({ success: true, skipped: true, reason: "lock held" });
  }

  const trace = startTrace('dispatcher');

  try {
    const ctx: CycleContext = { now: new Date(), events: [] };
    const activeExecutions = await withTimeout(runDispatcher(ctx), CYCLE_TIMEOUT_MS);

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

    const dispatchEvents = ctx.events.filter((e) => e.type === "auto_dispatch");

    addPhase(trace, { name: 'dispatch-cycle', durationMs: Date.now() - trace._startMs });
    completeTrace(trace, 'success', `Dispatched ${dispatchEvents.length} items, ${ctx.events.length} events`);

    await recordAgentRun("dispatcher");

    return NextResponse.json({
      success: true,
      state: {
        lastRunAt: ctx.now.toISOString(),
        activeExecutions: activeExecutions.length,
        queuedItems: queuedEntries.length + readyEntries.length,
        eventsThisCycle: ctx.events.length,
        dispatchedThisCycle: dispatchEvents.length,
      },
    });
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      console.error(`[dispatcher] Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout.`);
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
      await cleanupOldTraces('dispatcher', 7);
    } catch { /* non-fatal */ }
    await releaseLock(DISPATCHER_LOCK_KEY);
  }
}

export const GET = handleCron;
export const POST = handleCron;
