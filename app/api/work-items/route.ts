import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import {
  listWorkItems,
  listWorkItemsFull,
  createWorkItem,
  type WorkItemFilters,
} from "@/lib/work-items";
import { createWorkItemSchema } from "@/lib/types";
import type { WorkItem } from "@/lib/types";
import { dispatchSortComparator } from "@/lib/atc/utils";
import { writeBugRecord } from "@/lib/bugs";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  const { searchParams } = req.nextUrl;
  const filters: WorkItemFilters = {};
  const status = searchParams.get("status");
  const targetRepo = searchParams.get("targetRepo");
  const priority = searchParams.get("priority");

  const full = searchParams.get("full") === "true";

  if (status) filters.status = status as WorkItem["status"];
  if (targetRepo) filters.targetRepo = targetRepo;
  if (priority) filters.priority = priority as WorkItem["priority"];

  try {
    if (full) {
      const items = await listWorkItemsFull(filters);
      const sorted = items.slice().sort(dispatchSortComparator);
      return NextResponse.json(sorted);
    }
    const items = await listWorkItems(filters);
    return NextResponse.json(items);
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createWorkItemSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const item = await createWorkItem(parsed.data);

    // Fire-and-forget write-through to Notion Bugs DB for bugfix items
    if (item.type === "bugfix") {
      writeBugRecord(item).catch(() => {
        // already logged inside writeBugRecord
      });
    }

    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
