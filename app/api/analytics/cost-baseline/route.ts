import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { queryModelCallEvents } from "@/lib/atc/events";
import { loadJson, saveJson } from "@/lib/storage";
import type { ModelCallEvent } from "@/lib/atc/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostBaseline {
  baselineCostPerSuccess: number;
  recordedAt: string;
  totalItems: number;
  totalCost: number;
  successRate: number;
  periodStart: string;
  periodEnd: string;
}

export interface CostComparison {
  baseline: CostBaseline | null;
  baselineCostPerSuccess: number | null;
  currentCostPerSuccess: number | null;
  costReductionPct: number | null;
  baselineSuccessRate: number | null;
  currentSuccessRate: number | null;
  currentTotalCost: number;
  currentTotalItems: number;
  periodStart: string;
  periodEnd: string;
}

const BASELINE_STORAGE_KEY = "config/cost-baseline";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough per-token cost estimates (USD) by model family — matches model-routing route. */
function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const isOpus = model.toLowerCase().includes("opus");
  const inputRate = isOpus ? 15 / 1_000_000 : 3 / 1_000_000;
  const outputRate = isOpus ? 75 / 1_000_000 : 15 / 1_000_000;
  return inputTokens * inputRate + outputTokens * outputRate;
}

function computeStats(events: ModelCallEvent[]) {
  let totalCost = 0;
  let successCount = 0;
  let earliest = Infinity;
  let latest = -Infinity;

  for (const e of events) {
    const cost = estimateCost(e.model, e.inputTokens ?? 0, e.outputTokens ?? 0);
    totalCost += cost;
    if (e.success) successCount += 1;
    const ts = new Date(e.timestamp).getTime();
    if (ts < earliest) earliest = ts;
    if (ts > latest) latest = ts;
  }

  const totalItems = successCount;
  const successRate = events.length > 0 ? successCount / events.length : 0;
  const now = new Date();
  const periodStart =
    events.length > 0
      ? new Date(earliest).toISOString()
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const periodEnd = now.toISOString();

  return { totalCost, totalItems, successRate, periodStart, periodEnd };
}

async function getLast30DaysEvents(): Promise<ModelCallEvent[]> {
  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 30);
  return queryModelCallEvents({
    startDate: startDate.toISOString(),
    endDate: now.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// POST /api/analytics/cost-baseline — record baseline
// ---------------------------------------------------------------------------

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const events = await getLast30DaysEvents();
    const stats = computeStats(events);

    const baseline: CostBaseline = {
      baselineCostPerSuccess:
        stats.totalItems > 0 ? stats.totalCost / stats.totalItems : 0,
      recordedAt: new Date().toISOString(),
      totalItems: stats.totalItems,
      totalCost: stats.totalCost,
      successRate: stats.successRate,
      periodStart: stats.periodStart,
      periodEnd: stats.periodEnd,
    };

    await saveJson(BASELINE_STORAGE_KEY, baseline);
    return NextResponse.json(baseline);
  } catch (error) {
    console.error("[cost-baseline] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/analytics/cost-baseline — return comparison
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const baseline = await loadJson<CostBaseline>(BASELINE_STORAGE_KEY);
    const events = await getLast30DaysEvents();
    const stats = computeStats(events);

    const currentCostPerSuccess =
      stats.totalItems > 0 ? stats.totalCost / stats.totalItems : 0;

    let costReductionPct: number | null = null;
    if (baseline && baseline.baselineCostPerSuccess > 0) {
      costReductionPct =
        ((baseline.baselineCostPerSuccess - currentCostPerSuccess) /
          baseline.baselineCostPerSuccess) *
        100;
    }

    const comparison: CostComparison = {
      baseline,
      baselineCostPerSuccess: baseline?.baselineCostPerSuccess ?? null,
      currentCostPerSuccess,
      costReductionPct,
      baselineSuccessRate: baseline?.successRate ?? null,
      currentSuccessRate: stats.successRate,
      currentTotalCost: stats.totalCost,
      currentTotalItems: stats.totalItems,
      periodStart: stats.periodStart,
      periodEnd: stats.periodEnd,
    };

    return NextResponse.json(comparison);
  } catch (error) {
    console.error("[cost-baseline] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
