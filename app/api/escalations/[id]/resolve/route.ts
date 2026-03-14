import { NextResponse, NextRequest } from "next/server";
import { resolveEscalation, getEscalation } from "@/lib/escalation";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: escalationId } = await params;
    const body = await req.json();
    const { resolution } = body;

    if (!resolution) {
      return NextResponse.json(
        { error: "resolution is required" },
        { status: 400 }
      );
    }

    // Get the escalation to find the work item
    const escalation = await getEscalation(escalationId);
    if (!escalation) {
      return NextResponse.json({ error: "Escalation not found" }, { status: 404 });
    }

    // Resolve the escalation
    const resolved = await resolveEscalation(escalationId, resolution);

    // Transition work item back to "queued" and clear escalation field
    const workItem = await getWorkItem(escalation.workItemId);
    if (workItem) {
      await updateWorkItem(escalation.workItemId, {
        status: "queued",
        escalation: undefined,
      });
    }

    return NextResponse.json(resolved);
  } catch (err) {
    console.error("[api/escalations/[id]/resolve] POST error:", err);
    return NextResponse.json({ error: "Failed to resolve escalation" }, { status: 500 });
  }
}
