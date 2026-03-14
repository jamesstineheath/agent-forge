import useSWR from "swr";
import type { WorkItem, RepoConfig, ATCState, ATCEvent } from "@/lib/types";

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

export function useWorkItems(filters?: WorkItemFilters) {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.priority) params.set("priority", filters.priority);
  if (filters?.targetRepo) params.set("targetRepo", filters.targetRepo);
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

export function useATCEvents(limit = 50) {
  const { data, error, isLoading, mutate } = useSWR<ATCEvent[]>(
    `/api/atc/events?limit=${limit}`,
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}
