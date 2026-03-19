import { NextResponse, NextRequest } from "next/server";
import { resolveEscalation, getEscalation } from "@/lib/escalation";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

/**
 * POST /api/escalations/[id]/dismiss
 *
 * UI-facing dismiss endpoint. Resolves the escalation with a "dismissed" resolution
 * and transitions the work item back to "queued". Unlike the resolve endpoint,
 * this doesn't require Bearer token auth since it's protected by the app's
 * Google OAuth middleware.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: escalationId } = await params;

    const escalation = await getEscalation(escalationId);
    if (!escalation) {
      return NextResponse.json(
        { error: "Escalation not found" },
        { status: 404 }
      );
    }

    // Resolve the escalation as dismissed
    const resolved = await resolveEscalation(
      escalationId,
      "Dismissed from dashboard UI"
    );

    // Clear the escalation field on the work item (resolveEscalation already unblocks to "ready")
    if (escalation.workItemId) {
      const workItem = await getWorkItem(escalation.workItemId);
      if (workItem) {
        await updateWorkItem(escalation.workItemId, {
          escalation: undefined,
        });
      }
    }

    return NextResponse.json(resolved);
  } catch (err) {
    console.error("[api/escalations/[id]/dismiss] POST error:", err);
    return NextResponse.json(
      { error: "Failed to dismiss escalation" },
      { status: 500 }
    );
  }
}
