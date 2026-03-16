import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import {
  reviewBacklog,
  assessProjectHealth,
  suggestNextBatch,
  composeDigest,
} from "@/lib/pm-agent";
import { loadJson } from "@/lib/storage";
import type { BacklogReview, ProjectHealthReport, DigestOptions } from "@/lib/types";

// ── POST /api/pm-agent ───────────────────────────────────────────────────────
// Body: { action: 'review' | 'health' | 'suggest' | 'digest', options?: object }

export async function POST(req: NextRequest) {
  const primaryAuth = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (primaryAuth) {
    const fallbackAuth = await validateAuth(req, "WORK_ITEMS_API_KEY");
    if (fallbackAuth) return fallbackAuth;
  }

  let body: { action?: string; options?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, options } = body;

  if (!action) {
    return NextResponse.json(
      { error: "Missing required field: action" },
      { status: 400 },
    );
  }

  try {
    switch (action) {
      case "review": {
        const result = await reviewBacklog(options);
        return NextResponse.json(result);
      }
      case "health": {
        const projectId = options?.projectId as string | undefined;
        const result = await assessProjectHealth(projectId);
        return NextResponse.json(result);
      }
      case "suggest": {
        const result = await suggestNextBatch();
        return NextResponse.json(result);
      }
      case "digest": {
        const result = await composeDigest(options as unknown as DigestOptions);
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid actions: review, health, suggest, digest` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error(`[pm-agent] POST action=${action} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

// ── GET /api/pm-agent ────────────────────────────────────────────────────────
// Query: ?type=review|health (default: 'review')
// Returns the most recent stored result for the given type

export async function GET(req: NextRequest) {
  const primaryAuth = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (primaryAuth) {
    const fallbackAuth = await validateAuth(req, "WORK_ITEMS_API_KEY");
    if (fallbackAuth) return fallbackAuth;
  }

  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") ?? "review";

  if (type !== "review" && type !== "health") {
    return NextResponse.json(
      { error: `Unknown type: ${type}. Valid types: review, health` },
      { status: 400 },
    );
  }

  const storageKey =
    type === "review" ? "pm-agent/latest-review" : "pm-agent/latest-health";

  try {
    const data =
      type === "review"
        ? await loadJson<BacklogReview>(storageKey)
        : await loadJson<ProjectHealthReport>(storageKey);

    if (!data) {
      return NextResponse.json(
        { error: `No ${type} results found` },
        { status: 404 },
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error(`[pm-agent] GET type=${type} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
