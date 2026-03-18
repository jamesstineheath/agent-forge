import { NextRequest, NextResponse } from "next/server";
import { runProjectManager } from "@/lib/atc/project-manager";
import type { CycleContext } from "@/lib/atc/utils";

export const maxDuration = 300;

async function handleCron(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Feature flag: only run when agent split is enabled
  if (process.env.AGENT_SPLIT_ENABLED !== "true") {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "AGENT_SPLIT_ENABLED is not true — running via unified ATC cron",
    });
  }

  try {
    const ctx: CycleContext = { now: new Date(), events: [] };
    await runProjectManager(ctx);

    return NextResponse.json({
      success: true,
      eventsThisCycle: ctx.events.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export const GET = handleCron;
export const POST = handleCron;
