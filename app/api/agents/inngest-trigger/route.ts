import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/lib/inngest/client";
import { validateAuth } from "@/lib/api-auth";

// Registry mapping functionId -> Inngest event name.
// Event names must match the trigger.event in each Inngest function definition.
// pm-sweep and housekeeping are cron-only (no event trigger) and cannot be triggered via this route.
// Note: plan-pipeline and pipeline-oversight share the same event trigger;
// sending "agent/supervisor.requested" will invoke both functions.
const INNGEST_FUNCTION_REGISTRY: Record<string, { eventName: string; label: string }> = {
  "dispatcher-cycle": {
    eventName: "agent/dispatcher.requested",
    label: "Dispatcher Cycle",
  },
  "health-monitor-cycle": {
    eventName: "agent/health-monitor.requested",
    label: "Health Monitor Cycle",
  },
  "pm-cycle": {
    eventName: "agent/project-manager.requested",
    label: "PM Cycle",
  },
  "plan-pipeline": {
    eventName: "agent/supervisor.requested",
    label: "Plan Pipeline",
  },
  "pipeline-oversight": {
    eventName: "agent/supervisor.requested",
    label: "Pipeline Oversight",
  },
};

export async function POST(request: NextRequest) {
  const authError = await validateAuth(request, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  let body: { functionId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { functionId } = body;

  if (!functionId || typeof functionId !== "string") {
    return NextResponse.json({ error: "Missing functionId" }, { status: 400 });
  }

  const entry = INNGEST_FUNCTION_REGISTRY[functionId];
  if (!entry) {
    return NextResponse.json(
      { error: "Unknown functionId" },
      { status: 400 }
    );
  }

  await inngest.send({
    name: entry.eventName,
    data: {},
  });

  return NextResponse.json({ triggered: true, functionId }, { status: 200 });
}
