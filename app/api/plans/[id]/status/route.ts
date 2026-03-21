import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { updatePlanStatus } from "@/lib/plans";
import type { PlanStatus } from "@/lib/types";

/**
 * POST /api/plans/[id]/status — Status update from execute-handoff workflow.
 *
 * Body: { status, startedAt?, completedAt?, actualCost?, prNumber?, prUrl?, errorLog?, workflowRunId? }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { id } = await params;
  const body = await req.json();

  if (!body.status) {
    return NextResponse.json({ error: "status is required" }, { status: 400 });
  }

  const plan = await updatePlanStatus(id, body.status as PlanStatus, {
    actualCost: body.actualCost,
    errorLog: body.errorLog,
    prNumber: body.prNumber,
    prUrl: body.prUrl,
    workflowRunId: body.workflowRunId,
    startedAt: body.startedAt,
    completedAt: body.completedAt,
  });

  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, plan });
}
