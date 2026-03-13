import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listWorkItems } from "@/lib/work-items";
import type { WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
  "merged",
  "failed",
];

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Fetch items for each active status and merge
    const results = await Promise.all(
      ACTIVE_STATUSES.map((status) => listWorkItems({ status }))
    );

    const all = results.flat();

    // Deduplicate by id (shouldn't be needed but safety first)
    const seen = new Set<string>();
    const unique = all.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    // Sort by updatedAt descending, take last 10
    const sorted = unique
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 10);

    return NextResponse.json({ dispatches: sorted });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
