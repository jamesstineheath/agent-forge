import { NextRequest, NextResponse } from "next/server";
import { saveJson } from "@/lib/storage";
import { listWorkItems } from "@/lib/work-items";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { persistEvents } from "@/lib/atc/events";
import { runSupervisor } from "@/lib/atc/supervisor";
import { withTimeout, recordAgentRun } from "@/lib/atc/utils";
import { CYCLE_TIMEOUT_MS, ATC_STATE_KEY, CycleTimeoutError } from "@/lib/atc/types";
import type { CycleContext } from "@/lib/atc/types";
import { isPipelineKilled } from "@/lib/atc/kill-switch";

export const maxDuration = 300;

const SUPERVISOR_LOCK_KEY = "atc/supervisor-lock";

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

  try {
    const ctx: CycleContext = { now: new Date(), events: [] };
    await withTimeout(runSupervisor(ctx), CYCLE_TIMEOUT_MS);

    // Persist events
    await persistEvents(ctx.events);

    // Update state snapshot
    const queuedEntries = await listWorkItems({ status: "queued" });
    const readyEntries = await listWorkItems({ status: "ready" });
    await saveJson(ATC_STATE_KEY, {
      lastRunAt: ctx.now.toISOString(),
      activeExecutions: [],
      queuedItems: queuedEntries.length + readyEntries.length,
      recentEvents: ctx.events.slice(-20),
    });

    await recordAgentRun("supervisor");

    return NextResponse.json({
      success: true,
      state: {
        lastRunAt: ctx.now.toISOString(),
        eventsThisCycle: ctx.events.length,
      },
    });
  } catch (err) {
    if (err instanceof CycleTimeoutError) {
      console.error(`[supervisor] Cycle aborted after ${CYCLE_TIMEOUT_MS / 1000}s timeout.`);
      // Still update lastRunAt so the UI knows the cron is firing
      try {
        await saveJson(ATC_STATE_KEY, {
          lastRunAt: new Date().toISOString(),
          activeExecutions: [],
          queuedItems: -1,
          recentEvents: [{ type: 'timeout', timestamp: new Date().toISOString(), details: `Cycle timed out after ${CYCLE_TIMEOUT_MS / 1000}s` }],
        });
        await recordAgentRun("supervisor");
      } catch (stateErr) {
        console.error('[supervisor] Failed to persist timeout state:', stateErr);
      }
      return NextResponse.json({ success: true, timedOut: true });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    await releaseLock(SUPERVISOR_LOCK_KEY);
  }
}

export const GET = handleCron;
export const POST = handleCron;
