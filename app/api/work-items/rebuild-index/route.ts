import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { rebuildIndex } from "@/lib/work-items";

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  try {
    const result = await rebuildIndex();
    return NextResponse.json({
      message: `Index rebuilt: ${result.recovered} work items recovered, ${result.errors} errors`,
      ...result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Rebuild failed: ${msg}` }, { status: 500 });
  }
}
