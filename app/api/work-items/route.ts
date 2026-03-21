import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import {
  listWorkItems,
  listWorkItemsFull,
  createWorkItem,
  rowToWorkItem,
  type WorkItemFilters,
} from "@/lib/work-items";
import { createWorkItemSchema } from "@/lib/types";
import type { WorkItem, WaveStatus, WaveGroup, WaveProgressData } from "@/lib/types";
import { dispatchSortComparator } from "@/lib/atc/utils";
import { db } from "@/lib/db";
import { workItems } from "@/lib/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  const { searchParams } = req.nextUrl;

  // --- Wave grouping mode ---
  const groupByWave = searchParams.get("groupByWave") === "true";
  if (groupByWave) {
    const projectIdParam = searchParams.get("projectId");
    if (!projectIdParam) {
      return NextResponse.json(
        { error: "projectId required when groupByWave=true" },
        { status: 400 }
      );
    }

    try {
      const rows = await db
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.prdId, projectIdParam),
            isNotNull(workItems.waveNumber)
          )
        )
        .orderBy(workItems.waveNumber, workItems.createdAt);

      const items = rows.map(rowToWorkItem);

      // Group by waveNumber
      const waveMap = new Map<number, WorkItem[]>();
      for (const item of items) {
        // waveNumber is guaranteed non-null by the query filter
        const row = rows.find((r) => r.id === item.id);
        const wn = row!.waveNumber as number;
        if (!waveMap.has(wn)) waveMap.set(wn, []);
        waveMap.get(wn)!.push(item);
      }

      const TERMINAL_STATES = new Set(["merged", "verified", "partial"]);
      const ACTIVE_STATES = new Set([
        "queued",
        "generating",
        "executing",
        "reviewing",
        "retrying",
      ]);
      const FAILED_STATES = new Set(["failed", "parked"]);

      const computeWaveStatus = (waveItems: WorkItem[]): WaveStatus => {
        const statuses = waveItems.map((i) => i.status);
        if (statuses.every((s) => TERMINAL_STATES.has(s))) return "complete";
        if (statuses.some((s) => ACTIVE_STATES.has(s))) return "active";
        if (
          statuses.some((s) => FAILED_STATES.has(s)) &&
          !statuses.some((s) => ACTIVE_STATES.has(s))
        )
          return "failed";
        return "pending";
      };

      const sortedWaveNumbers = [...waveMap.keys()].sort((a, b) => a - b);

      const waves: WaveGroup[] = sortedWaveNumbers.map((wn) => {
        const waveItems = waveMap.get(wn)!;
        const completedItems = waveItems.filter((i) =>
          TERMINAL_STATES.has(i.status)
        ).length;
        const status = computeWaveStatus(waveItems);
        return {
          waveNumber: wn,
          status,
          items: waveItems,
          totalItems: waveItems.length,
          completedItems,
          progressPercent:
            waveItems.length > 0
              ? Math.round((completedItems / waveItems.length) * 100)
              : 0,
        };
      });

      const activeWave = waves.find((w) => w.status === "active");
      const currentWave = activeWave?.waveNumber ?? null;

      const response: WaveProgressData = {
        projectId: projectIdParam,
        waves,
        currentWave,
        totalWaves: waves.length,
      };

      return NextResponse.json(response);
    } catch {
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }
  }

  // --- Standard list mode ---
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
    return NextResponse.json(item, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
