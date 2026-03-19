import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { loadJson } from "@/lib/storage";
import { listWorkItemsFull } from "@/lib/work-items";
import { getATCEvents } from "@/lib/atc/events";
import type { WorkItem, ATCEvent, DriftSnapshot } from "@/lib/types";

// --- Response types ---

export interface FailureAttributionEntry {
  agent: string;
  count: number;
  percentage: number;
}

export interface CostTrendEntry {
  date: string;
  avgCostUsd: number;
  itemCount: number;
}

export interface ReasoningQualityMetrics {
  planQuality: number | null;
  stepEfficiency: number | null;
  toolCorrectness: number | null;
  dataSource: string;
}

export interface DriftAlert {
  id: string;
  severity: "low" | "medium" | "high";
  message: string;
  detectedAt: string;
}

export interface EvaluationMetricsResponse {
  failureAttribution: FailureAttributionEntry[];
  costTrend: CostTrendEntry[];
  reasoningQuality: ReasoningQualityMetrics;
  driftAlerts: DriftAlert[];
  lastUpdated: string;
}

// --- Helpers ---

async function computeFailureAttribution(): Promise<FailureAttributionEntry[]> {
  const items = await listWorkItemsFull({ status: "failed" });
  if (items.length === 0) return [];

  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.targetRepo || item.source?.type || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const total = items.length;
  return Object.entries(counts)
    .map(([agent, count]) => ({
      agent,
      count,
      percentage: Math.round((count / total) * 100),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function computeCostTrend(): Promise<CostTrendEntry[]> {
  const items = await listWorkItemsFull();
  const now = Date.now();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = now - fourteenDaysMs;

  const buckets: Record<string, { total: number; count: number }> = {};

  for (const item of items) {
    const cost = item.execution?.actualCost;
    if (cost == null || cost <= 0) continue;

    const ts = item.updatedAt
      ? new Date(item.updatedAt).getTime()
      : item.createdAt
        ? new Date(item.createdAt).getTime()
        : 0;
    if (ts < cutoff) continue;

    const dateStr = new Date(ts).toISOString().slice(0, 10);
    if (!buckets[dateStr]) buckets[dateStr] = { total: 0, count: 0 };
    buckets[dateStr].total += cost;
    buckets[dateStr].count += 1;
  }

  return Object.entries(buckets)
    .map(([date, { total, count }]) => ({
      date,
      avgCostUsd: count > 0 ? total / count : 0,
      itemCount: count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchReasoningQuality(): Promise<ReasoningQualityMetrics> {
  // Try known blob key patterns for reasoning quality data
  const data = await loadJson<{
    planQuality?: { overallScore?: number };
    stepEfficiency?: { efficiency?: number };
    toolCorrectness?: { accuracy?: number };
    overallScore?: number;
  }>("atc/reasoning-quality");

  if (data) {
    return {
      planQuality: data.planQuality?.overallScore ?? null,
      stepEfficiency: data.stepEfficiency?.efficiency ?? null,
      toolCorrectness: data.toolCorrectness?.accuracy ?? null,
      dataSource: "supervisor",
    };
  }

  // Check work items for reasoning metrics
  const items = await listWorkItemsFull();
  const withMetrics = items.filter(
    (i: WorkItem) => i.reasoningMetrics != null
  );
  if (withMetrics.length > 0) {
    const latest = withMetrics.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )[0];
    const m = latest.reasoningMetrics!;
    return {
      planQuality: m.planQuality?.completeness ?? null,
      stepEfficiency: m.stepEfficiency?.efficiency
        ? Math.round(m.stepEfficiency.efficiency * 100)
        : null,
      toolCorrectness: m.toolCorrectness?.accuracy
        ? Math.round(m.toolCorrectness.accuracy * 100)
        : null,
      dataSource: "work-item-metrics",
    };
  }

  return {
    planQuality: null,
    stepEfficiency: null,
    toolCorrectness: null,
    dataSource: "not yet computed",
  };
}

async function fetchDriftAlerts(): Promise<DriftAlert[]> {
  const alerts: DriftAlert[] = [];

  // Check drift index for recent degraded snapshots
  const driftIndex = await loadJson<string[]>("drift/index");
  if (driftIndex && driftIndex.length > 0) {
    const recentDates = driftIndex.slice(-20);
    for (const dateStr of recentDates) {
      const snapshot = await loadJson<DriftSnapshot>(`drift/${dateStr}`);
      if (snapshot && snapshot.degraded) {
        alerts.push({
          id: `drift-${dateStr}`,
          severity: snapshot.driftScore > 0.3 ? "high" : snapshot.driftScore > 0.2 ? "medium" : "low",
          message: `Outcome drift detected (score: ${snapshot.driftScore.toFixed(3)}, threshold: ${snapshot.threshold})`,
          detectedAt: snapshot.date,
        });
      }
    }
  }

  // Also scan ATC events for drift-related events
  if (alerts.length === 0) {
    const events = await getATCEvents(200);
    const driftEvents = events.filter(
      (e: ATCEvent) => e.details?.toLowerCase().includes("drift")
    );
    for (const evt of driftEvents.slice(-20)) {
      alerts.push({
        id: evt.id,
        severity: "medium",
        message: evt.details,
        detectedAt: evt.timestamp,
      });
    }
  }

  return alerts.sort(
    (a, b) =>
      new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  ).slice(0, 20);
}

// --- Route handler ---

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [failureAttribution, costTrend, reasoningQuality, driftAlerts] =
      await Promise.allSettled([
        computeFailureAttribution(),
        computeCostTrend(),
        fetchReasoningQuality(),
        fetchDriftAlerts(),
      ]);

    return NextResponse.json({
      failureAttribution:
        failureAttribution.status === "fulfilled"
          ? failureAttribution.value
          : [],
      costTrend:
        costTrend.status === "fulfilled" ? costTrend.value : [],
      reasoningQuality:
        reasoningQuality.status === "fulfilled"
          ? reasoningQuality.value
          : {
              planQuality: null,
              stepEfficiency: null,
              toolCorrectness: null,
              dataSource: "unavailable",
            },
      driftAlerts:
        driftAlerts.status === "fulfilled" ? driftAlerts.value : [],
      lastUpdated: new Date().toISOString(),
    } satisfies EvaluationMetricsResponse);
  } catch (err) {
    console.error("[evaluation-metrics] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to load evaluation metrics" },
      { status: 500 }
    );
  }
}
