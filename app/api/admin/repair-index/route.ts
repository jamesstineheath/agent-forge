import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { reconcileWorkItemIndex } from "@/lib/work-items";

function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  return (
    token === process.env.AGENT_FORGE_API_SECRET ||
    token === process.env.ESCALATION_SECRET
  );
}

export async function POST(request: NextRequest) {
  // Support both session auth and Bearer token auth
  const session = await auth();
  if (!session && !isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await reconcileWorkItemIndex();
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error("[admin/repair-index] reconciliation failed", err);
    return NextResponse.json(
      { error: "Reconciliation failed", details: String(err) },
      { status: 500 }
    );
  }
}
