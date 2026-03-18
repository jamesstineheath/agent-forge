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
    const debug = searchParams.get("debug") === "true";
    const limit = Math.min(parseInt(limitParam ?? "20", 10) || 20, 100);

    if (agentParam && !VALID_AGENTS.has(agentParam)) {
      return NextResponse.json(
        { error: `Invalid agent name. Must be one of: ${[...VALID_AGENTS].join(', ')}` },
        { status: 400 }
      );
    }

    // Debug mode: show raw blob listing to diagnose trace persistence issues
    if (debug && process.env.BLOB_READ_WRITE_TOKEN) {
      const { list } = await import("@vercel/blob");
      const prefix = agentParam
        ? `af-data/agent-traces/${agentParam}/`
        : `af-data/agent-traces/`;
      const { blobs } = await list({ prefix, token: process.env.BLOB_READ_WRITE_TOKEN });
      return NextResponse.json({
        debug: true,
        prefix,
        blobCount: blobs.length,
        blobs: blobs.slice(0, 20).map(b => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt })),
        hasBlobToken: !!process.env.BLOB_READ_WRITE_TOKEN,
      });
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
