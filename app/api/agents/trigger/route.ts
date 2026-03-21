import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Cron routes are now thin Inngest event triggers, so this is fast
export const maxDuration = 30;

const AGENT_ROUTES: Record<string, string> = {
  dispatcher: "/api/agents/dispatcher/cron",
  "health-monitor": "/api/agents/health-monitor/cron",
  "project-manager": "/api/agents/project-manager/cron",
  supervisor: "/api/agents/supervisor/cron",
  digest: "/api/agents/digest/cron",
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { agent?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { agent } = body;
  if (!agent || !AGENT_ROUTES[agent]) {
    return NextResponse.json(
      {
        error: `Unknown agent. Valid agents: ${Object.keys(AGENT_ROUTES).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }

  const cronRoute = AGENT_ROUTES[agent];
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const url = `${baseUrl}${cronRoute}`;

  const start = Date.now();
  let responseStatus = 0;
  let responseBody = "";
  let success = false;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
    });

    responseStatus = response.status;
    const text = await response.text();
    responseBody = text.slice(0, 2048);
    success = response.ok;
  } catch (err) {
    responseBody = err instanceof Error ? err.message : "Unknown fetch error";
    success = false;
  }

  const duration = Math.round((Date.now() - start) / 1000);

  return NextResponse.json({
    success,
    duration,
    status: responseStatus,
    body: responseBody,
  });
}
