import useSWR from "swr";
import { useState } from "react";
import type { KeyedMutator } from "swr";
import type { WorkItem, RepoConfig, ATCState, ATCEvent, Project, TLMMemory, DebateStats, CostAnalytics, Episode, Bug, WaveProgressData, InngestFunctionStatus } from "@/lib/types";
import type { DebateSession } from "@/lib/debate/types";
import type { Escalation } from "@/lib/escalation";
import type { WebhookEvent } from "@/lib/event-bus-types";
import type { KillSwitchState } from "@/lib/atc/kill-switch";

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  }).then((data) => {
    // Some endpoints return { error: "..." } with 200 status
    if (data && typeof data === 'object' && 'error' in data && !Array.isArray(data)) {
      throw new Error(data.error);
    }
    return data;
  });

export interface WorkItemFilters {
  status?: WorkItem["status"];
  priority?: WorkItem["priority"];
  targetRepo?: string;
}

export function useWorkItems(filters?: WorkItemFilters & { full?: boolean }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.targetRepo) params.set("targetRepo", filters.targetRepo);
  // Default to full=true so dashboard components get handoff/execution data
  params.set("full", filters?.full === false ? "false" : "true");
  const query = params.toString();
  const url = `/api/work-items${query ? `?${query}` : ""}`;

  const { data, error, isLoading, mutate } = useSWR<WorkItem[]>(url, fetcher, {
    refreshInterval: 15000,
  });
  return { data, error, isLoading, mutate };
}

export function useWorkItem(id: string | null) {
  const { data, error, isLoading, mutate } = useSWR<WorkItem>(
    id ? `/api/work-items/${id}` : null,
    fetcher
  );
  return { data, error, isLoading, mutate };
}

export function useRepos() {
  const { data, error, isLoading, mutate } = useSWR<RepoConfig[]>(
    "/api/repos",
    fetcher
  );
  return { data, error, isLoading, mutate };
}

export interface PipelineStatus {
  dispatches: WorkItem[];
}

export function usePipelineStatus() {
  const { data, error, isLoading, mutate } = useSWR<PipelineStatus>(
    "/api/orchestrator/status",
    fetcher,
    { refreshInterval: 10000 }
  );
  return { data, error, isLoading, mutate };
}

export function useKillSwitch() {
  const { data, error, isLoading, mutate } = useSWR<KillSwitchState>(
    "/api/pipeline/kill-switch",
    fetcher,
    { refreshInterval: 10000 }
  );
  return { data, error, isLoading, mutate };
}

export function useATCState() {
  const { data, error, isLoading, mutate } = useSWR<ATCState & { recentEvents: ATCEvent[] }>(
    "/api/atc",
    fetcher,
    { refreshInterval: 10000 }
  );
  return { data, error, isLoading, mutate };
}

export function useProjects() {
  const { data, error, isLoading, mutate } = useSWR<Project[]>(
    "/api/projects",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export function useEscalations(statusFilter?: "pending" | "resolved" | "expired" | "all") {
  const queryString = statusFilter ? `?status=${statusFilter}` : "";
  const { data, error, isLoading, mutate } = useSWR<Escalation[]>(
    `/api/escalations${queryString}`,
    fetcher,
    { refreshInterval: 15000 }
  );
  return { data, error, isLoading, mutate };
}

export function useTLMMemory() {
  const { data, error, isLoading, mutate } = useSWR<TLMMemory>(
    "/api/agents/tlm-memory",
    fetcher,
    { refreshInterval: 60000 }
  );
  return { data, error, isLoading, mutate };
}

export function useATCMetrics() {
  const { data, error, isLoading, mutate } = useSWR<import("@/app/api/agents/atc-metrics/route").ATCMetrics>(
    "/api/agents/atc-metrics",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export function useATCStatePanel() {
  const { data, error, isLoading, mutate } = useSWR<ATCState & { recentEvents: ATCEvent[] }>(
    "/api/atc/state",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export function useFeedbackCompiler() {
  const { data, error, isLoading, mutate } = useSWR<import("@/app/api/agents/feedback-compiler/route").FeedbackCompilerData>(
    "/api/agents/feedback-compiler",
    fetcher,
    { refreshInterval: 60000 }
  );
  return { data, error, isLoading, mutate };
}

export function useWorkItemEvents(workItemId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<ATCEvent[]>(
    workItemId ? `/api/work-items/${workItemId}/events` : null,
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export function useATCEvents(limit = 50) {
  const { data, error, isLoading, mutate } = useSWR<ATCEvent[]>(
    `/api/atc/events?limit=${limit}`,
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export function useWebhookEvents(limit = 20) {
  const { data, error, isLoading, mutate } = useSWR<WebhookEvent[]>(
    `/api/events?limit=${limit}`,
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export interface QARunRecord {
  id: string;
  repo: string;
  timestamp: string;
  passed: boolean;
  durationMs: number;
  failureCategories?: string[];
  isFalseNegative?: boolean;
}

export interface QAResultsResponse {
  runs: QARunRecord[];
  summary: {
    totalRuns: number;
    passRate: number;
    avgDurationMs: number;
    failureCategories: Record<string, number>;
    byRepo: Array<{
      repo: string;
      runs: number;
      passRate: number;
    }>;
    graduation: {
      runsCompleted: number;
      runsRequired: number;
      falseNegativeRate: number;
    };
  };
}

export function useQAResults() {
  const { data, error, isLoading } = useSWR<QAResultsResponse>(
    "/api/qa-results",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, isLoading, error };
}

export function useDebateStats() {
  const { data, error, isLoading, mutate } = useSWR<DebateStats>(
    "/api/debates",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

export function useAgentDashboard() {
  const { data, error, isLoading, mutate } = useSWR<import("@/lib/agent-dashboard").AgentDashboardData>(
    "/api/agents/dashboard",
    fetcher,
    { refreshInterval: 60000 }
  );
  return { data, error, isLoading, mutate };
}

// === Agent Traces ===

export interface AgentTracePhase {
  name: string;
  durationMs: number;
  [key: string]: unknown;
}

export interface AgentTraceDecision {
  workItemId?: string;
  action: string;
  reason: string;
  [key: string]: unknown;
}

export interface AgentTraceRecord {
  agent: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status?: "success" | "error";
  phases: AgentTracePhase[];
  decisions: AgentTraceDecision[];
  errors: string[];
  summary?: string;
}

export function useAgentTraces() {
  const { data, error, isLoading, mutate } = useSWR<{ traces: AgentTraceRecord[] }>(
    "/api/agents/traces?limit=50",
    fetcher,
    { refreshInterval: 30_000 }
  );
  return {
    traces: data?.traces ?? [],
    isLoading,
    error,
    refresh: mutate,
  };
}

export function useDebateSessions(repo?: string, pr?: number) {
  const key = repo && pr ? `/api/debates?repo=${encodeURIComponent(repo)}&pr=${pr}` : null;
  const { data, error, isLoading, mutate } = useSWR<DebateSession[]>(key, fetcher);
  return { data, error, isLoading, mutate };
}

// === TLM Agents (GitHub Actions) ===

export interface TlmWorkflowStatus {
  name: string;
  workflowFile: string;
  lastRunAt: string | null;
  lastConclusion: string | null;
  totalRuns: number;
  successRate: number | null;
}

export interface TlmAgentsData {
  workflows: TlmWorkflowStatus[];
  fetchedAt: string;
}

export function useTlmAgents() {
  const { data, error, isLoading } = useSWR<TlmAgentsData>(
    "/api/agents/tlm-agents",
    fetcher,
    { refreshInterval: 60000 }
  );
  return { data, error, isLoading };
}

// === Evaluation Metrics ===

export function useEvaluationMetrics() {
  const { data, error, isLoading } = useSWR<import("@/app/api/agents/evaluation-metrics/route").EvaluationMetricsResponse>(
    "/api/agents/evaluation-metrics",
    fetcher,
    { refreshInterval: 60000 }
  );
  return { metrics: data, error, isLoading };
}

// === Cost Analytics ===

export function useCostAnalytics(period: string = "30d") {
  const { data, error, isLoading, mutate } = useSWR<CostAnalytics>(
    `/api/costs/analytics?period=${period}`,
    fetcher,
    { refreshInterval: 60000 }
  );
  return { data, error, isLoading, mutate };
}

// ── Bug Tracking ────────────────────────────────────────────────────────────

export function useBugs() {
  const { data, error, isLoading } = useSWR<{ bugs: Bug[] }>(
    "/api/bugs",
    fetcher,
    { refreshInterval: 30000 }
  );
  return {
    bugs: data?.bugs ?? [],
    isLoading,
    error,
  };
}

// ── Intent Criteria ──────────────────────────────────────────────────────────

import type { IntentCriteria, IntentCriteriaIndexEntry } from "@/lib/types";

export function useIntentCriteriaList() {
  const { data, error, isLoading, mutate } = useSWR<{ total: number; criteria: IntentCriteriaIndexEntry[] }>(
    "/api/intent-criteria",
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data: data?.criteria, total: data?.total, error, isLoading, mutate };
}

export function useIntentCriteria(prdId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<IntentCriteria>(
    prdId ? `/api/intent-criteria/${prdId}` : null,
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}

// ── Episodes ─────────────────────────────────────────────────────────────────

export function useEpisode(id: string | null) {
  const { data, error, isLoading, mutate } = useSWR<Episode>(
    id ? `/api/episodes/${id}` : null,
    fetcher,
  );
  return { data, error, isLoading, mutate };
}

// ── Cost Baseline ────────────────────────────────────────────────────────────

export function useCostBaseline() {
  const { data, error, isLoading, mutate } = useSWR<import("@/app/api/analytics/cost-baseline/route").CostComparison>(
    "/api/analytics/cost-baseline",
    fetcher,
    { refreshInterval: 60000 }
  );
  return {
    comparison: data ?? null,
    isLoading,
    error,
    refresh: mutate,
  };
}

// ── Wave Progress ────────────────────────────────────────────────────────────

export function useWaveProgress(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<WaveProgressData>(
    projectId ? `/api/work-items?projectId=${projectId}&groupByWave=true` : null,
    fetcher,
    { refreshInterval: 15000 }
  );
  return { data, error, isLoading, mutate };
}

// ── Model Routing Analytics ──────────────────────────────────────────────────

export interface ModelRoutingParams {
  days?: number;
  taskType?: string;
}

export interface ModelCostStats {
  totalCost: number;
  callCount: number;
  avgCostPerStep: number;
}

export interface DailySpendEntry {
  date: string;
  model: string;
  cost: number;
}

export interface QualityScoreEntry {
  taskType: string;
  model: string;
  successRate: number;
  totalCalls: number;
}

export interface EscalationRateEntry {
  taskType: string;
  escalationCount: number;
  totalCalls: number;
  rate: number;
}

export interface ModelRoutingAnalytics {
  perModelCosts: Record<string, ModelCostStats>;
  dailySpend: DailySpendEntry[];
  qualityScores: QualityScoreEntry[];
  escalationRates: EscalationRateEntry[];
}

export function useModelRoutingAnalytics(params?: ModelRoutingParams) {
  const searchParams = new URLSearchParams();
  if (params?.days) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - params.days);
    searchParams.set("startDate", start.toISOString());
    searchParams.set("endDate", end.toISOString());
  }
  if (params?.taskType) searchParams.set("taskType", params.taskType);
  const query = searchParams.toString();
  const url = `/api/analytics/model-routing${query ? `?${query}` : ""}`;

  const { data, error, isLoading } = useSWR<ModelRoutingAnalytics>(url, fetcher);
  return { data, error, isLoading };
}

// ── Inngest Status ────────────────────────────────────────────────────────────

export function useInngestStatus(): {
  statuses: InngestFunctionStatus[];
  isLoading: boolean;
  error: any;
  mutate: KeyedMutator<InngestFunctionStatus[]>;
} {
  const { data, error, isLoading, mutate } = useSWR<InngestFunctionStatus[]>(
    "/api/agents/inngest-status",
    fetcher,
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
    }
  );

  return {
    statuses: data ?? [],
    isLoading,
    error,
    mutate,
  };
}

// ── Inngest Trigger ───────────────────────────────────────────────────────────

export function useTriggerInngestFunction(): {
  trigger: (functionId: string) => Promise<void>;
  triggeringId: string | null;
} {
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const { mutate } = useInngestStatus();

  const trigger = async (functionId: string): Promise<void> => {
    setTriggeringId(functionId);
    try {
      await fetch("/api/agents/inngest-trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functionId }),
      });
      // Immediate revalidation
      await mutate();
      // Delayed revalidation to pick up 'running' status
      setTimeout(async () => {
        await mutate();
      }, 3000);
    } finally {
      setTriggeringId(null);
    }
  };

  return { trigger, triggeringId };
}
