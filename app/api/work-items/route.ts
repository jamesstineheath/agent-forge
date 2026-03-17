import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import {
  listWorkItems,
  getWorkItem,
  createWorkItem,
  type WorkItemFilters,
} from "@/lib/work-items";
import { createWorkItemSchema } from "@/lib/types";
import type { WorkItem } from "@/lib/types";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  const { searchParams } = req.nextUrl;
  const filters: WorkItemFilters = {};
  const status = searchParams.get("status");
  const targetRepo = searchParams.get("targetRepo");
  const priority = searchParams.get("priority");

  if (status) filters.status = status as WorkItem["status"];
  if (targetRepo) filters.targetRepo = targetRepo;
  if (priority) filters.priority = priority as WorkItem["priority"];

  try {
    const index = await listWorkItems(filters);
    // Hydrate index entries into full WorkItem objects so clients get
    // source, execution, handoff, etc.
    const items = (
      await Promise.all(index.map((entry) => getWorkItem(entry.id)))
    ).filter((item): item is WorkItem => item !== null);
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
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
