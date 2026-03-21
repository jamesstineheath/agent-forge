/**
 * In-memory mock for @/lib/work-items.
 *
 * Replicates key business logic (terminal status guards, dispatch ordering,
 * dependency resolution) without requiring a database connection.
 * Used by tests that were written for the pre-Postgres blob store.
 */

import { randomUUID } from "crypto";
import type { WorkItem, WorkItemIndexEntry, CreateWorkItemInput, UpdateWorkItemInput } from "@/lib/types";
import { FAST_LANE_BUDGET_SIMPLE, FAST_LANE_BUDGET_MODERATE } from "@/lib/types";

const TERMINAL_STATUSES = new Set<string>(["cancelled", "merged", "obsolete"]);

let store: Map<string, WorkItem>;

export function resetStore() {
  store = new Map();
}

// Auto-init on import
resetStore();

function normalizeTargetRepo(repo: string): string {
  if (repo.includes("/")) return repo;
  return `jamesstineheath/${repo}`;
}

export function getDefaultBudgetForHint(hint?: "simple" | "moderate"): number | undefined {
  if (hint === "simple") return FAST_LANE_BUDGET_SIMPLE;
  if (hint === "moderate") return FAST_LANE_BUDGET_MODERATE;
  return undefined;
}

export async function createWorkItem(data: CreateWorkItemInput): Promise<WorkItem> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const item: WorkItem = {
    id,
    title: data.title,
    description: data.description,
    targetRepo: normalizeTargetRepo(data.targetRepo),
    source: data.source,
    priority: data.priority ?? "medium",
    riskLevel: data.riskLevel ?? "medium",
    complexity: data.complexity ?? "moderate",
    type: undefined,
    status: "filed",
    dependencies: data.dependencies ?? [],
    triggeredBy: data.triggeredBy,
    complexityHint: data.complexityHint,
    expedite: data.expedite,
    triagePriority: data.triagePriority,
    rank: data.rank,
    handoff: null,
    execution: null,
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, item);
  return item;
}

export async function getWorkItem(id: string): Promise<WorkItem | null> {
  return store.get(id) ?? null;
}

export async function updateWorkItem(id: string, patch: UpdateWorkItemInput): Promise<WorkItem | null> {
  const existing = store.get(id);
  if (!existing) return null;

  // Terminal status guard
  const isRecoveryTransition = existing.status === "cancelled" && patch.status === "ready";
  if (
    TERMINAL_STATUSES.has(existing.status) &&
    patch.status &&
    !TERMINAL_STATUSES.has(patch.status) &&
    !isRecoveryTransition
  ) {
    return existing;
  }

  const updated: WorkItem = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  } as WorkItem;
  store.set(id, updated);
  return updated;
}

export async function deleteWorkItem(id: string): Promise<boolean> {
  return store.delete(id);
}

export async function listWorkItems(filters?: {
  status?: string;
  targetRepo?: string;
  priority?: string;
}): Promise<WorkItemIndexEntry[]> {
  let items = Array.from(store.values());
  if (filters?.status) items = items.filter((i) => i.status === filters.status);
  if (filters?.targetRepo) {
    const short = filters.targetRepo.includes("/")
      ? filters.targetRepo.split("/")[1]
      : filters.targetRepo;
    items = items.filter(
      (i) => i.targetRepo === filters.targetRepo || i.targetRepo.endsWith(short!)
    );
  }
  if (filters?.priority) items = items.filter((i) => i.priority === filters.priority);
  return items.map((i) => ({
    id: i.id,
    title: i.title,
    targetRepo: i.targetRepo,
    status: i.status,
    priority: i.priority,
    updatedAt: i.updatedAt,
    source: i.source,
  }));
}

export async function listWorkItemsFull(filters?: {
  status?: string;
  targetRepo?: string;
  priority?: string;
}): Promise<WorkItem[]> {
  let items = Array.from(store.values());
  if (filters?.status) items = items.filter((i) => i.status === filters.status);
  if (filters?.targetRepo) {
    const short = filters.targetRepo.includes("/")
      ? filters.targetRepo.split("/")[1]
      : filters.targetRepo;
    items = items.filter(
      (i) => i.targetRepo === filters.targetRepo || i.targetRepo.endsWith(short!)
    );
  }
  if (filters?.priority) items = items.filter((i) => i.priority === filters.priority);
  return items;
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

async function areDependenciesResolved(item: WorkItem): Promise<boolean> {
  if (item.source.type === "direct") return true;
  if (item.dependencies.length === 0) return true;
  for (const depId of item.dependencies) {
    const dep = store.get(depId);
    if (!dep || (dep.status !== "merged" && dep.status !== "cancelled")) return false;
  }
  return true;
}

export async function getNextDispatchable(targetRepo: string): Promise<WorkItem | null> {
  const items = await listWorkItemsFull({ status: "ready", targetRepo });
  const dispatchable: WorkItem[] = [];
  for (const item of items) {
    if (await areDependenciesResolved(item)) dispatchable.push(item);
  }
  if (dispatchable.length === 0) return null;
  dispatchable.sort((a, b) => {
    const pd = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return dispatchable[0] ?? null;
}

export async function getAllDispatchable(targetRepo: string): Promise<WorkItem[]> {
  const items = await listWorkItemsFull({ status: "ready", targetRepo });
  const dispatchable: WorkItem[] = [];
  for (const item of items) {
    if (await areDependenciesResolved(item)) dispatchable.push(item);
  }
  dispatchable.sort((a, b) => {
    const pd = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  return dispatchable;
}

export async function getBlockedByDependencies(targetRepo: string): Promise<WorkItem[]> {
  const items = await listWorkItemsFull({ status: "ready", targetRepo });
  const blocked: WorkItem[] = [];
  for (const item of items) {
    if (item.dependencies.length > 0 && !(await areDependenciesResolved(item))) {
      blocked.push(item);
    }
  }
  return blocked;
}

export async function findWorkItemByBranch(branch: string): Promise<WorkItem | null> {
  for (const item of store.values()) {
    if (item.handoff && (item.handoff as { branch?: string }).branch === branch) return item;
  }
  return null;
}

export async function findWorkItemByPR(repo: string, prNumber: number): Promise<WorkItem | null> {
  for (const item of store.values()) {
    if (
      item.execution &&
      (item.execution as { prNumber?: number }).prNumber === prNumber &&
      item.targetRepo.includes(repo.includes("/") ? repo.split("/")[1] : repo)
    ) {
      return item;
    }
  }
  return null;
}

export async function reconcileWorkItemIndex() {
  return { checked: store.size, repaired: 0, repairedItems: [] };
}

export async function rebuildIndex() {
  return { recovered: store.size, errors: 0 };
}
