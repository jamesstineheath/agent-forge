import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getPlan, updatePlanStatus } from "@/lib/plans";
import type { PlanStatus } from "@/lib/types";

/**
 * GET /api/plans/[id] — Get a single plan.
 */
export async function GET(
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
  return NextResponse.json(plan);
}

/**
 * PATCH /api/plans/[id] — Update plan fields.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { id } = await params;
  const body = await req.json();

  const plan = await updatePlanStatus(id, body.status as PlanStatus, {
    actualCost: body.actualCost,
    errorLog: body.errorLog,
    prNumber: body.prNumber,
    prUrl: body.prUrl,
    workflowRunId: body.workflowRunId,
    startedAt: body.startedAt,
    completedAt: body.completedAt,
    retryCount: body.retryCount,
  });

  if (!plan) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }
  return NextResponse.json(plan);
}
