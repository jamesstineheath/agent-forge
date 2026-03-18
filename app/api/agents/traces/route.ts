import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listRecentTraces } from "@/lib/atc/tracing";
import type { AgentName } from "@/lib/atc/tracing";

const VALID_AGENTS = new Set<string>(['dispatcher', 'health-monitor', 'project-manager', 'supervisor']);

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const agentParam = searchParams.get("agent");
    const limitParam = searchParams.get("limit");
    const limit = Math.min(parseInt(limitParam ?? "20", 10) || 20, 100);

    if (agentParam && !VALID_AGENTS.has(agentParam)) {
      return NextResponse.json(
        { error: `Invalid agent name. Must be one of: ${[...VALID_AGENTS].join(', ')}` },
        { status: 400 }
      );
    }

    const traces = await listRecentTraces(
      (agentParam as AgentName) ?? undefined,
      limit
    );

    return NextResponse.json({ traces, count: traces.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
