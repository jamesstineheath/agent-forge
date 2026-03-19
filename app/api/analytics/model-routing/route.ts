import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  queryModelCallEvents,
  queryModelEscalationEvents,
} from "@/lib/atc/events";
import type { TaskType } from "@/lib/atc/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelCostStats {
  totalCost: number;
  callCount: number;
  avgCostPerStep: number;
}

interface DailySpendEntry {
  date: string; // YYYY-MM-DD
  model: string;
  cost: number;
}

interface QualityScoreEntry {
  taskType: string;
  model: string;
  successRate: number;
  totalCalls: number;
}

interface EscalationRateEntry {
  taskType: string;
  escalationCount: number;
  totalCalls: number;
  rate: number;
}

interface ModelRoutingAnalytics {
  perModelCosts: Record<string, ModelCostStats>;
  dailySpend: DailySpendEntry[];
  qualityScores: QualityScoreEntry[];
  escalationRates: EscalationRateEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough per-token cost estimates (USD) by model family. */
function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Default conservative estimate; real pricing would come from config
  const isOpus = model.toLowerCase().includes("opus");
  const inputRate = isOpus ? 15 / 1_000_000 : 3 / 1_000_000;
  const outputRate = isOpus ? 75 / 1_000_000 : 15 / 1_000_000;
  return inputTokens * inputRate + outputTokens * outputRate;
}

function emptyAnalytics(): ModelRoutingAnalytics {
  return {
    perModelCosts: {},
    dailySpend: [],
    qualityScores: [],
    escalationRates: [],
  };
}

const VALID_TASK_TYPES: Set<string> = new Set([
  "decomposition",
  "dispatch",
  "health_monitor",
  "project_manager",
  "supervisor",
  "spec_review",
  "code_review",
  "execution",
]);

// ---------------------------------------------------------------------------
// GET /api/analytics/model-routing
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = req.nextUrl;
  const taskTypeParam = searchParams.get("taskType") ?? undefined;
  const taskTypeFilter: TaskType | undefined =
    taskTypeParam && VALID_TASK_TYPES.has(taskTypeParam)
      ? (taskTypeParam as TaskType)
      : undefined;

  // Default to last 7 days
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 7);

  const startDateParam = searchParams.get("startDate");
  const endDateParam = searchParams.get("endDate");

  const startDate = startDateParam ? new Date(startDateParam) : defaultStart;
  const endDate = endDateParam ? new Date(endDateParam) : now;

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return NextResponse.json(
      { error: "Invalid startDate or endDate" },
      { status: 400 }
    );
  }

  // Convert to ISO strings for the event query API
  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  try {
    const [callEvents, escalationEvents] = await Promise.all([
      queryModelCallEvents({
        startDate: startISO,
        endDate: endISO,
        taskType: taskTypeFilter,
      }),
      queryModelEscalationEvents({
        startDate: startISO,
        endDate: endISO,
        taskType: taskTypeFilter,
      }),
    ]);

    if (callEvents.length === 0 && escalationEvents.length === 0) {
      return NextResponse.json(emptyAnalytics());
    }

    // --- perModelCosts & dailySpend ---
    const perModelCosts: Record<
      string,
      { totalCost: number; callCount: number }
    > = {};
    const dailySpendMap = new Map<string, number>(); // "YYYY-MM-DD|model" -> cost

    for (const event of callEvents) {
      const model = event.model;
      const cost = estimateCost(
        model,
        event.inputTokens ?? 0,
        event.outputTokens ?? 0
      );

      // perModelCosts
      if (!perModelCosts[model]) {
        perModelCosts[model] = { totalCost: 0, callCount: 0 };
      }
      perModelCosts[model].totalCost += cost;
      perModelCosts[model].callCount += 1;

      // dailySpend
      const dateKey = event.timestamp.slice(0, 10);
      const spendKey = `${dateKey}|${model}`;
      dailySpendMap.set(spendKey, (dailySpendMap.get(spendKey) ?? 0) + cost);
    }

    const perModelCostsFinal: Record<string, ModelCostStats> = {};
    for (const [model, stats] of Object.entries(perModelCosts)) {
      perModelCostsFinal[model] = {
        totalCost: stats.totalCost,
        callCount: stats.callCount,
        avgCostPerStep:
          stats.callCount > 0 ? stats.totalCost / stats.callCount : 0,
      };
    }

    const dailySpend: DailySpendEntry[] = [];
    for (const [key, cost] of dailySpendMap.entries()) {
      const [date, model] = key.split("|");
      dailySpend.push({ date, model, cost });
    }
    dailySpend.sort((a, b) => a.date.localeCompare(b.date));

    // --- qualityScores ---
    const qualityMap = new Map<
      string,
      { successCount: number; totalCalls: number }
    >();

    for (const event of callEvents) {
      const key = `${event.taskType}|${event.model}`;
      if (!qualityMap.has(key)) {
        qualityMap.set(key, { successCount: 0, totalCalls: 0 });
      }
      const entry = qualityMap.get(key)!;
      entry.totalCalls += 1;
      if (event.success) entry.successCount += 1;
    }

    const qualityScores: QualityScoreEntry[] = [];
    for (const [key, stats] of qualityMap.entries()) {
      const [taskType, model] = key.split("|");
      qualityScores.push({
        taskType,
        model,
        successRate:
          stats.totalCalls > 0 ? stats.successCount / stats.totalCalls : 0,
        totalCalls: stats.totalCalls,
      });
    }

    // --- escalationRates ---
    const escalationMap = new Map<
      string,
      { escalationCount: number; totalCalls: number }
    >();

    for (const event of callEvents) {
      const tt = event.taskType;
      if (!escalationMap.has(tt)) {
        escalationMap.set(tt, { escalationCount: 0, totalCalls: 0 });
      }
      escalationMap.get(tt)!.totalCalls += 1;
    }

    for (const event of escalationEvents) {
      const tt = event.taskType;
      if (!escalationMap.has(tt)) {
        escalationMap.set(tt, { escalationCount: 0, totalCalls: 0 });
      }
      escalationMap.get(tt)!.escalationCount += 1;
    }

    const escalationRates: EscalationRateEntry[] = [];
    for (const [taskType, stats] of escalationMap.entries()) {
      escalationRates.push({
        taskType,
        escalationCount: stats.escalationCount,
        totalCalls: stats.totalCalls,
        rate:
          stats.totalCalls > 0
            ? stats.escalationCount / stats.totalCalls
            : 0,
      });
    }

    const analytics: ModelRoutingAnalytics = {
      perModelCosts: perModelCostsFinal,
      dailySpend,
      qualityScores,
      escalationRates,
    };

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("[model-routing analytics] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
