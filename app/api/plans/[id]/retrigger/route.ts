import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getPlan, updatePlanStatus } from "@/lib/plans";

const RETRIGGERABLE_STATUSES = new Set(["failed", "timed_out", "budget_exceeded"]);

/**
 * POST /api/plans/[id]/retrigger — Reset a failed plan to ready for re-dispatch.
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

  const updated = await updatePlanStatus(id, "ready", {
    retryCount: plan.retryCount + 1,
  });

  return NextResponse.json({ success: true, plan: updated });
}
