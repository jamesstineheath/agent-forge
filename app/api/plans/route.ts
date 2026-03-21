import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listPlans } from "@/lib/plans";
import type { PlanStatus } from "@/lib/types";

/**
 * GET /api/plans — List plans with optional filters.
 */
export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") as PlanStatus | null;
  const targetRepo = searchParams.get("target_repo");
  const prdId = searchParams.get("prd_id");

  const plans = await listPlans({
    status: status ?? undefined,
    targetRepo: targetRepo ?? undefined,
    prdId: prdId ?? undefined,
  });

  return NextResponse.json({ plans });
}
