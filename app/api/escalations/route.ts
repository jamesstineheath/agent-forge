import { NextResponse, NextRequest } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listEscalations, escalate } from "@/lib/escalation";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "ESCALATION_SECRET");
  if (authError) return authError;

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
  const authError = await validateAuth(req, "ESCALATION_SECRET");
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
