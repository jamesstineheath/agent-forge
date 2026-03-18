import { listRecentTraces, type AgentTrace, type AgentName } from "./atc/tracing";
import { queryEvents } from "./event-bus";
import { getATCState } from "./atc/events";
import type { WebhookEvent } from "./event-bus-types";
import type { WorkItem, ATCState } from "./types";
import { loadJson } from "./storage";

// === Types ===

export type HealthStatus = "healthy" | "stale" | "error";

export interface AgentHealthInfo {
  name: string;
  displayName: string;
  cadence: string;
  lastRunAt: string | null;
  lastRunStatus: "success" | "error" | null;
  health: HealthStatus;
  runHistory: Array<{
    startedAt: string;
    status: "success" | "error";
    durationMs: number | null;
  }>;
  metrics: Record<string, number>;
}

export interface EventBusStats {
  eventsLastHour: number;
  eventsLast24h: number;
  breakdownByType: Record<string, number>;
}

export interface PipelineThroughput {
  completedToday: number;
  completedThisWeek: number;
}

export interface ActiveExecution {
  workItemId: string;
  branch: string;
  targetRepo: string;
}

export interface AgentDashboardData {
  agents: AgentHealthInfo[];
  eventBusStats: EventBusStats;
  pipelineThroughput: PipelineThroughput;
  activeExecutions: ActiveExecution[];
  generatedAt: string;
}

// === Health threshold config ===

interface AgentConfig {
  name: AgentName | "feedback-compiler";
  displayName: string;
  cadence: string;
  healthyThresholdMs: number;
  staleThresholdMs: number;
}

const AGENT_CONFIGS: AgentConfig[] = [
  {
    name: "dispatcher",
    displayName: "Dispatcher",
    cadence: "5-min cron",
    healthyThresholdMs: 10 * 60 * 1000,
    staleThresholdMs: 30 * 60 * 1000,
  },
  {
    name: "health-monitor",
    displayName: "Health Monitor",
    cadence: "5-min cron",
    healthyThresholdMs: 10 * 60 * 1000,
    staleThresholdMs: 30 * 60 * 1000,
  },
  {
    name: "project-manager",
    displayName: "Project Manager",
    cadence: "15-min cron",
    healthyThresholdMs: 30 * 60 * 1000,
    staleThresholdMs: 60 * 60 * 1000,
  },
  {
    name: "supervisor",
    displayName: "Supervisor",
    cadence: "10-min cron",
    healthyThresholdMs: 20 * 60 * 1000,
    staleThresholdMs: 60 * 60 * 1000,
  },
  {
    name: "feedback-compiler",
    displayName: "Feedback Compiler",
    cadence: "weekly cron",
    healthyThresholdMs: 8 * 24 * 60 * 60 * 1000,
    staleThresholdMs: 14 * 24 * 60 * 60 * 1000,
  },
];

// === Logic ===

function computeHealth(
  config: AgentConfig,
  lastRunAt: string | null,
  lastRunStatus: "success" | "error" | null
): HealthStatus {
  if (lastRunStatus === "error") return "error";
  if (!lastRunAt) return "stale";

  const elapsed = Date.now() - new Date(lastRunAt).getTime();
  if (elapsed <= config.healthyThresholdMs) return "healthy";
  if (elapsed <= config.staleThresholdMs) return "stale";
  return "error";
}

function buildAgentHealth(
  config: AgentConfig,
  traces: AgentTrace[]
): AgentHealthInfo {
  const sorted = [...traces].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const last10 = sorted.slice(0, 10);
  const latest = last10[0] ?? null;

  const lastRunAt = latest?.completedAt ?? latest?.startedAt ?? null;
  const lastRunStatus = latest?.status ?? null;

  const metrics: Record<string, number> = {
    totalRuns: sorted.length,
    successCount: sorted.filter((t) => t.status === "success").length,
    errorCount: sorted.filter((t) => t.status === "error").length,
    avgDurationMs: sorted.length > 0
      ? Math.round(
          sorted
            .filter((t) => t.durationMs != null)
            .reduce((sum, t) => sum + (t.durationMs ?? 0), 0) /
            Math.max(sorted.filter((t) => t.durationMs != null).length, 1)
        )
      : 0,
  };

  return {
    name: config.name,
    displayName: config.displayName,
    cadence: config.cadence,
    lastRunAt,
    lastRunStatus,
    health: computeHealth(config, lastRunAt, lastRunStatus),
    runHistory: last10.map((t) => ({
      startedAt: t.startedAt,
      status: t.status ?? "error",
      durationMs: t.durationMs ?? null,
    })),
    metrics,
  };
}

function buildEventBusStats(
  eventsLastHour: WebhookEvent[],
  eventsLast24h: WebhookEvent[]
): EventBusStats {
  const breakdownByType: Record<string, number> = {};
  for (const event of eventsLast24h) {
    breakdownByType[event.type] = (breakdownByType[event.type] ?? 0) + 1;
  }
  return {
    eventsLastHour: eventsLastHour.length,
    eventsLast24h: eventsLast24h.length,
    breakdownByType,
  };
}

function buildPipelineThroughput(workItems: WorkItem[]): PipelineThroughput {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const dayOfWeek = now.getUTCDay();
  const startOfWeek = new Date(now);
  startOfWeek.setUTCDate(now.getUTCDate() - dayOfWeek);
  startOfWeek.setUTCHours(0, 0, 0, 0);

  let completedToday = 0;
  let completedThisWeek = 0;

  for (const item of workItems) {
    if (item.status !== "merged" || !item.execution?.completedAt) continue;
    const completedAt = new Date(item.execution.completedAt).getTime();
    if (completedAt >= startOfDay.getTime()) completedToday++;
    if (completedAt >= startOfWeek.getTime()) completedThisWeek++;
  }

  return { completedToday, completedThisWeek };
}

function buildActiveExecutions(state: ATCState): ActiveExecution[] {
  return state.activeExecutions.map((exec) => ({
    workItemId: exec.workItemId,
    branch: exec.branch,
    targetRepo: exec.targetRepo,
  }));
}

export async function getAgentDashboardData(): Promise<AgentDashboardData> {
  // Fetch all data in parallel
  const [
    allTraces,
    eventsLastHour,
    eventsLast24h,
    atcState,
    workItemIndex,
  ] = await Promise.all([
    listRecentTraces(undefined, 100),
    queryEvents({
      since: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      limit: 500,
    }),
    queryEvents({
      since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      limit: 500,
    }),
    getATCState(),
    loadJson<Array<{ id: string }>>( "work-items-index"),
  ]);

  // Load work items for throughput (just need status + completedAt)
  const workItems: WorkItem[] = [];
  if (workItemIndex && workItemIndex.length > 0) {
    const results = await Promise.all(
      workItemIndex.map((entry) =>
        loadJson<WorkItem>(`work-items/${entry.id}`)
      )
    );
    for (const item of results) {
      if (item) workItems.push(item);
    }
  }

  // Group traces by agent
  const tracesByAgent = new Map<string, AgentTrace[]>();
  for (const trace of allTraces) {
    const existing = tracesByAgent.get(trace.agent) ?? [];
    existing.push(trace);
    tracesByAgent.set(trace.agent, existing);
  }

  // Build per-agent health info
  const agents = AGENT_CONFIGS.map((config) => {
    const agentTraces = tracesByAgent.get(config.name) ?? [];
    return buildAgentHealth(config, agentTraces);
  });

  return {
    agents,
    eventBusStats: buildEventBusStats(eventsLastHour, eventsLast24h),
    pipelineThroughput: buildPipelineThroughput(workItems),
    activeExecutions: buildActiveExecutions(atcState),
    generatedAt: new Date().toISOString(),
  };
}
