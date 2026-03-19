import { NextRequest, NextResponse } from "next/server";
import { getArchitecturePlan } from "@/lib/architecture-planner";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ prdId: string }> },
) {
  const { prdId } = await params;

  try {
    const plan = await getArchitecturePlan(prdId);
    if (!plan) {
      return NextResponse.json(null, { status: 404 });
    }
    return NextResponse.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
