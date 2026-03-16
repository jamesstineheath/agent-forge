import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getATCEvents, getATCState } from "@/lib/atc";
import type { ATCEvent } from "@/lib/types";

export interface ATCMetrics {
  totalDispatches: number;
  successfulDispatches: number;
  failedDispatches: number;
  dispatchSuccessRate: number | null;
  conflictsDetected: number;
  timeoutsDetected: number;
  retriesTriggered: number;
  itemsParked: number;
  escalationsTimedOut: number;
  escalationsResolved: number;
  projectsDecomposed: number;
  projectsFailed: number;
  branchesCleanedUp: number;
  dependencyBlocks: number;
  autoCancellations: number;
  totalEvents: number;
  lastRunAt: string | null;
  activeExecutionCount: number;
  queueDepth: number;
  recentEvents: ATCEvent[];
  eventBreakdown: Record<string, number>;
}

function computeMetrics(events: ATCEvent[], state: Awaited<ReturnType<typeof getATCState>>): ATCMetrics {
  const eventBreakdown: Record<string, number> = {};
  let totalDispatches = 0;
  let failedDispatches = 0;
  let conflictsDetected = 0;
  let timeoutsDetected = 0;
  let retriesTriggered = 0;
  let itemsParked = 0;
  let escalationsTimedOut = 0;
  let escalationsResolved = 0;
  let projectsDecomposed = 0;
  let projectsFailed = 0;
  let branchesCleanedUp = 0;
  let dependencyBlocks = 0;
  let autoCancellations = 0;

  for (const event of events) {
    eventBreakdown[event.type] = (eventBreakdown[event.type] ?? 0) + 1;

    switch (event.type) {
      case "auto_dispatch":
        totalDispatches++;
        break;
      case "error":
        if (event.details.includes("Auto-dispatch failed")) {
          totalDispatches++;
          failedDispatches++;
        }
        if (event.details.includes("Decomposition failed") || event.details.includes("Decomposition produced 0")) {
          projectsFailed++;
        }
        break;
      case "conflict":
        conflictsDetected++;
        break;
      case "timeout":
        timeoutsDetected++;
        break;
      case "retry":
        retriesTriggered++;
        break;
      case "parked":
        itemsParked++;
        break;
      case "escalation_timeout":
        escalationsTimedOut++;
        break;
      case "escalation_resolved":
        if (event.details.includes("auto-resolved")) {
          escalationsResolved++;
        }
        break;
      case "project_trigger":
        if (event.details.includes("decomposed into")) {
          projectsDecomposed++;
        }
        if (event.newStatus === "Failed") {
          projectsFailed++;
        }
        break;
      case "cleanup":
        const branchMatch = event.details.match(/deleted (\d+)/);
        if (branchMatch) {
          branchesCleanedUp += parseInt(branchMatch[1], 10);
        }
        break;
      case "dependency_block":
        dependencyBlocks++;
        break;
      case "auto_cancel":
        autoCancellations++;
        break;
    }
  }

  const successfulDispatches = totalDispatches - failedDispatches;
  const dispatchSuccessRate = totalDispatches > 0
    ? (successfulDispatches / totalDispatches) * 100
    : null;

  return {
    totalDispatches,
    successfulDispatches,
    failedDispatches,
    dispatchSuccessRate,
    conflictsDetected,
    timeoutsDetected,
    retriesTriggered,
    itemsParked,
    escalationsTimedOut,
    escalationsResolved,
    projectsDecomposed,
    projectsFailed,
    branchesCleanedUp,
    dependencyBlocks,
    autoCancellations,
    totalEvents: events.length,
    lastRunAt: state.lastRunAt !== new Date(0).toISOString() ? state.lastRunAt : null,
    activeExecutionCount: state.activeExecutions.length,
    queueDepth: state.queuedItems,
    recentEvents: events.slice(-10),
    eventBreakdown,
  };
}

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const [events, state] = await Promise.all([
      getATCEvents(200),
      getATCState(),
    ]);
    const metrics = computeMetrics(events, state);
    return NextResponse.json(metrics);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
