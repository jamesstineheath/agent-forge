import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listAllCriteria, importAllApprovedCriteria, importCriteriaFromNotion } from "@/lib/intent-criteria";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const criteria = await listAllCriteria();
  return NextResponse.json({ total: criteria.length, criteria });
}

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const body = await req.json().catch(() => ({}));
  const { prdId } = body as { prdId?: string };

  if (prdId) {
    // Import a specific PRD
    try {
      const result = await importCriteriaFromNotion(prdId);
      return NextResponse.json({
        imported: true,
        prdId: result.prdId,
        prdTitle: result.prdTitle,
        criteriaCount: result.criteria.length,
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Import failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      );
    }
  }

  // Import all approved (force=true skips staleness check for manual imports)
  const result = await importAllApprovedCriteria(true);
  return NextResponse.json(result);
}
