import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const body = await req.json();
    const { itemIds } = body as { itemIds?: string[] };

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json(
        { error: "itemIds must be a non-empty array of work item IDs" },
        { status: 400 }
      );
    }

    const results: { id: string; status: string }[] = [];

    for (const id of itemIds) {
      const item = await getWorkItem(id);
      if (!item) {
        results.push({ id, status: "not_found" });
        continue;
      }
      if (item.status === "cancelled") {
        results.push({ id, status: "already_cancelled" });
        continue;
      }

      await updateWorkItem(id, { status: "cancelled" });
      results.push({ id, status: "cancelled" });
    }

    const cancelledCount = results.filter((r) => r.status === "cancelled").length;
    return NextResponse.json({
      message: `Cancelled ${cancelledCount} of ${itemIds.length} items`,
      results,
    });
  } catch (err) {
    console.error("[api/admin/cleanup-orphans] POST error:", err);
    return NextResponse.json(
      { error: "Failed to cancel work items" },
      { status: 500 }
    );
  }
}
