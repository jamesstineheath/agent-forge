import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";

export const maxDuration = 10;

async function handleCron(req: NextRequest) {
  const authHeader = req.headers.get("Authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await inngest.send({ name: "agent/project-manager.requested" });
  return NextResponse.json({ triggered: true, via: "inngest" });
}

export const GET = handleCron;
export const POST = handleCron;
