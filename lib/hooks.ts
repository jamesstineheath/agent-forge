import useSWR from "swr";
import type { WorkItem, RepoConfig, ATCState, ATCEvent, Project, TLMMemory, DebateStats } from "@/lib/types";
import type { DebateSession } from "@/lib/debate/types";
import type { Escalation } from "@/lib/escalation";
import type { WebhookEvent } from "@/lib/event-bus-types";

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Request failed");
    return res.json();
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

  const { data, error, isLoading, mutate } = useSWR<WorkItem[]>(url, fetcher);
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
