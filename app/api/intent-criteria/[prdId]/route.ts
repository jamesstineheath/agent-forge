import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getCriteria, updateCriterionStatus, importCriteriaFromNotion } from "@/lib/intent-criteria";
import type { CriterionStatus } from "@/lib/types";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ prdId: string }> }
) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { prdId } = await params;
  const criteria = await getCriteria(prdId);
  if (!criteria) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(criteria);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ prdId: string }> }
) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { prdId } = await params;
  const body = await req.json();
  const { criterionId, status, evidence } = body as {
    criterionId?: string;
    status?: CriterionStatus;
    evidence?: string;
  };

  if (!criterionId || !status) {
    return NextResponse.json(
      { error: "criterionId and status are required" },
      { status: 400 }
    );
  }

  const validStatuses: CriterionStatus[] = ["pending", "passed", "failed", "skipped"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
      { status: 400 }
    );
  }

  const result = await updateCriterionStatus(prdId, criterionId, status, evidence);
  if (!result) {
    return NextResponse.json({ error: "Criteria or criterion not found" }, { status: 404 });
  }

  return NextResponse.json({
    updated: true,
    criterionId,
    status,
    passedCount: result.passedCount,
    failedCount: result.failedCount,
  });
}

// Refresh from Notion
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prdId: string }> }
) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const { prdId } = await params;

  try {
    // Re-format prdId to UUID format for Notion API
    const pageId = prdId.length === 32
      ? prdId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")
      : prdId;

    const result = await importCriteriaFromNotion(pageId);
    return NextResponse.json({
      refreshed: true,
      prdId: result.prdId,
      criteriaCount: result.criteria.length,
      notionSyncedAt: result.notionSyncedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Refresh failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
