import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getPlan, updatePlanStatus } from "@/lib/plans";

const RETRIGGERABLE_STATUSES = new Set(["failed", "timed_out", "budget_exceeded", "reviewing"]);

/**
 * POST /api/plans/[id]/retrigger — Reset a plan to ready for re-dispatch.
 *
 * Accepts optional reviewFeedback in body, which is appended to the plan
 * prompt on the next execution as retry context.
 *
 * Body: { reviewFeedback?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { id } = await params;
  const plan = await getPlan(id);
  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  if (!RETRIGGERABLE_STATUSES.has(plan.status)) {
    return NextResponse.json(
      { error: `Plan is in ${plan.status} status, not retriggerable. Must be: ${[...RETRIGGERABLE_STATUSES].join(", ")}` },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const reviewFeedback = body.reviewFeedback as string | undefined;

  const updated = await updatePlanStatus(id, "ready", {
    retryCount: plan.retryCount + 1,
    reviewFeedback: reviewFeedback ?? undefined,
  });

  return NextResponse.json({ success: true, plan: updated });
}
