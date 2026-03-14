import { NextRequest, NextResponse } from "next/server";
import { runATCCycle } from "@/lib/atc";

async function handleCron(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const state = await runATCCycle();
    const dispatchEvents = state.recentEvents.filter(e => e.type === "auto_dispatch");
    return NextResponse.json({
      success: true,
      state: {
        lastRunAt: state.lastRunAt,
        activeExecutions: state.activeExecutions.length,
        queuedItems: state.queuedItems,
        eventsThisCycle: state.recentEvents.length,
        dispatchedThisCycle: dispatchEvents.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// Vercel cron jobs send GET requests
export const GET = handleCron;
// Keep POST for manual triggers
export const POST = handleCron;
