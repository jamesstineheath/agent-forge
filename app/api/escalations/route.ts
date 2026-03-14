import { NextResponse, NextRequest } from "next/server";
import { listEscalations, escalate } from "@/lib/escalation";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

/**
 * Validate Bearer token for pipeline agent authentication.
 * Returns null if valid, or an error Response if invalid.
 */
function validateBearerToken(req: NextRequest): NextResponse | null {
  const authHeader = req.headers.get("Authorization");
  const escalationSecret = process.env.ESCALATION_SECRET;

  if (!escalationSecret) {
    console.error("[api/escalations] ESCALATION_SECRET not configured");
    return NextResponse.json(
      { error: "Server misconfiguration: escalation auth not set up" },
      { status: 500 }
    );
  }

  if (!authHeader || authHeader !== `Bearer ${escalationSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

export async function GET(req: NextRequest) {
  // GET is unauthenticated — dashboard reads this endpoint.
  // The dashboard is already behind Google OAuth, so this is low risk.
  try {
    const { searchParams } = new URL(req.url);
    const status = (searchParams.get("status") ?? "all") as
      | "pending"
      | "resolved"
      | "expired"
      | "all";

    const escalations = await listEscalations(status);
    return NextResponse.json(escalations);
  } catch (err) {
    console.error("[api/escalations] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch escalations" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authError = validateBearerToken(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { workItemId, reason, confidenceScore, contextSnapshot } = body;

    // Validate required fields
    if (!workItemId || !reason) {
      return NextResponse.json(
        { error: "workItemId and reason are required" },
        { status: 400 }
      );
    }

    // Create the escalation
    const escalation = await escalate(
      workItemId,
      reason,
      confidenceScore ?? 0.7,
      contextSnapshot ?? {}
    );

    // Transition work item to "blocked"
    const workItem = await getWorkItem(workItemId);
    if (workItem) {
      await updateWorkItem(workItemId, {
        status: "blocked",
        escalation: {
          id: escalation.id,
          reason: escalation.reason,
          blockedAt: escalation.createdAt,
        },
      });
    }

    return NextResponse.json(escalation, { status: 201 });
  } catch (err) {
    console.error("[api/escalations] POST error:", err);
    return NextResponse.json({ error: "Failed to create escalation" }, { status: 500 });
  }
}
