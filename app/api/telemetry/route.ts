/**
 * Unified Telemetry Query API — PRD-48: Pipeline Observability Foundation.
 *
 * Aggregates events, agent traces, cost data, and pipeline metrics into a
 * single queryable endpoint. Serves as the foundation for dashboards and
 * MCP tools that need a holistic pipeline health view.
 *
 * GET /api/telemetry?hours=24&include=events,traces,costs,metrics
 */

import { NextRequest, NextResponse } from "next/server";
import { loadJson } from "@/lib/storage";
import type { ATCEvent } from "@/lib/types";
import { listRecentTraces } from "@/lib/atc/tracing";
import type { AgentName } from "@/lib/atc/tracing";
import { computePipelineMetrics } from "@/lib/pipeline-metrics";
import { getCostsForPeriod, aggregateCosts } from "@/lib/cost-tracking";

const ATC_EVENTS_KEY = "atc/events";
const AGENTS: AgentName[] = [
  "dispatcher",
  "health-monitor",
  "project-manager",
  "supervisor",
];

export async function GET(req: NextRequest) {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.AGENT_FORGE_API_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hours = Math.min(
    parseInt(req.nextUrl.searchParams.get("hours") ?? "24", 10),
    168, // max 7 days
  );
  const includeParam = req.nextUrl.searchParams.get("include") ?? "events,traces,costs,metrics";
  const sections = new Set(includeParam.split(",").map((s) => s.trim()));

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const result: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    windowHours: hours,
  };

  // Events
  if (sections.has("events")) {
    try {
      const allEvents = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
      const recentEvents = allEvents.filter((e) => e.timestamp >= cutoff);

      // Compute event breakdown by type
      const breakdown: Record<string, number> = {};
      for (const e of recentEvents) {
        breakdown[e.type] = (breakdown[e.type] ?? 0) + 1;
      }

      result.events = {
        total: recentEvents.length,
        breakdown,
        errors: recentEvents.filter((e) => e.type === "error" || e.type === "timeout").length,
        recent: recentEvents.slice(-20),
      };
    } catch (err) {
      result.events = { error: (err as Error).message };
    }
  }

  // Traces
  if (sections.has("traces")) {
    try {
      const agentSummaries: Record<
        string,
        { runs: number; errors: number; avgDurationMs: number; lastRun: string | null }
      > = {};

      for (const agent of AGENTS) {
        const traces = await listRecentTraces(agent, 10);
        const recentTraces = traces.filter(
          (t) => t.startedAt >= cutoff,
        );
        const errorCount = recentTraces.filter((t) => t.status === "error").length;
        const durations = recentTraces
          .map((t) => t.durationMs)
          .filter((d): d is number => d != null);
        const avgDuration =
          durations.length > 0
            ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
            : 0;

        agentSummaries[agent] = {
          runs: recentTraces.length,
          errors: errorCount,
          avgDurationMs: avgDuration,
          lastRun: recentTraces[0]?.startedAt ?? null,
        };
      }

      result.traces = {
        agents: agentSummaries,
        totalRuns: Object.values(agentSummaries).reduce((s, a) => s + a.runs, 0),
        totalErrors: Object.values(agentSummaries).reduce((s, a) => s + a.errors, 0),
      };
    } catch (err) {
      result.traces = { error: (err as Error).message };
    }
  }

  // Costs
  if (sections.has("costs")) {
    try {
      const days = Math.max(1, Math.ceil(hours / 24));
      const endDate = new Date().toISOString().slice(0, 10);
      const startDateObj = new Date();
      startDateObj.setUTCDate(startDateObj.getUTCDate() - days);
      const startDate = startDateObj.toISOString().slice(0, 10);
      const entries = await getCostsForPeriod(startDate, endDate);
      const agg = aggregateCosts(entries);
      result.costs = {
        periodDays: days,
        totalEntries: entries.length,
        totalCostUsd: agg.totalCostUsd,
        totalInputTokens: agg.totalInputTokens,
        totalOutputTokens: agg.totalOutputTokens,
        byAgent: agg.byAgent,
      };
    } catch (err) {
      result.costs = { error: (err as Error).message };
    }
  }

  // Pipeline metrics
  if (sections.has("metrics")) {
    try {
      const days = Math.max(1, Math.ceil(hours / 24));
      const metrics = await computePipelineMetrics(days);
      result.metrics = metrics;
    } catch (err) {
      result.metrics = { error: (err as Error).message };
    }
  }

  return NextResponse.json(result);
}
