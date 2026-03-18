import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { queryEvents } from "@/lib/event-bus";
import type { GitHubEventType } from "@/lib/event-bus-types";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const params = req.nextUrl.searchParams;

    const since = params.get("since") ?? undefined;
    const repo = params.get("repo") ?? undefined;
    const limit = Math.min(parseInt(params.get("limit") ?? "50", 10), 200);
    const typesParam = params.get("types");
    const types = typesParam
      ? (typesParam.split(",").filter(Boolean) as GitHubEventType[])
      : undefined;

    const events = await queryEvents({ since, types, repo, limit });
    return NextResponse.json(events);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
