import { randomUUID } from "crypto";
import { loadJson, saveJson, deleteJson } from "./storage";
import type {
  WorkItem,
  WorkItemIndexEntry,
  CreateWorkItemInput,
  UpdateWorkItemInput,
} from "./types";
import { FAST_LANE_BUDGET_SIMPLE, FAST_LANE_BUDGET_MODERATE } from "./types";

const INDEX_KEY = "work-items/index";

/**
 * Return the default budget for a given complexityHint.
 * Used during handoff generation when no explicit budget is provided.
 */
export function getDefaultBudgetForHint(hint?: 'simple' | 'moderate'): number | undefined {
  if (hint === 'simple') return FAST_LANE_BUDGET_SIMPLE;
  if (hint === 'moderate') return FAST_LANE_BUDGET_MODERATE;
  return undefined;
}

function itemKey(id: string): string {
  return `work-items/${id}`;
}

async function loadIndex(): Promise<WorkItemIndexEntry[]> {
  try {
    const index = await loadJson<WorkItemIndexEntry[]>(INDEX_KEY, { required: true });
    if (!index) {
      console.log(`[work-items] Index returned null for key "${INDEX_KEY}" — treating as empty (valid for new deploys).`);
      return [];
    }
    return index;
  } catch (err) {
    // Distinguish "file doesn't exist" from "load failed" — only treat missing as empty
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Not Found") || msg.includes("404")) {
      console.log(`[work-items] Index file not found — treating as empty (new deploy or deleted).`);
      return [];
    }
    // For actual errors (network, corruption), rethrow so callers know the index is unreliable
    console.error(`[work-items] Index load FAILED (not missing, actual error):`, err);
    throw err;
  }
}

async function saveIndex(index: WorkItemIndexEntry[]): Promise<void> {
  await saveJson(INDEX_KEY, index);
}

export interface WorkItemFilters {
  status?: WorkItem["status"];
  targetRepo?: string;
  priority?: WorkItem["priority"];
}

export async function listWorkItems(
  filters?: WorkItemFilters
): Promise<WorkItemIndexEntry[]> {
  let index = await loadIndex();
  if (filters?.status) {
    index = index.filter((e) => e.status === filters.status);
  }
  if (filters?.targetRepo) {
    index = index.filter((e) => e.targetRepo === filters.targetRepo);
  }
  if (filters?.priority) {
    index = index.filter((e) => e.priority === filters.priority);
  }
  return index;
}

export async function getWorkItem(id: string): Promise<WorkItem | null> {
  return loadJson<WorkItem>(itemKey(id));
}

export async function createWorkItem(data: CreateWorkItemInput): Promise<WorkItem> {
  const now = new Date().toISOString();

  const item: WorkItem = {
    id: randomUUID(),
    title: data.title,
    description: data.description,
    targetRepo: data.targetRepo,
    source: data.source,
    priority: data.priority,
    riskLevel: data.riskLevel,
    complexity: data.complexity,
    status: "filed",
    dependencies: data.dependencies,
    triggeredBy: data.triggeredBy,
    complexityHint: data.complexityHint,
    handoff: null,
    execution: null,
    createdAt: now,
    updatedAt: now,
  };

  await saveJson(itemKey(item.id), item);

  const index = await loadIndex();
  index.push({
    id: item.id,
    title: item.title,
    targetRepo: item.targetRepo,
    status: item.status,
    priority: item.priority,
    updatedAt: item.updatedAt,
  });
  await saveIndex(index);

  return item;
}

export async function updateWorkItem(
  id: string,
  patch: UpdateWorkItemInput
): Promise<WorkItem | null> {
  const existing = await getWorkItem(id);
  if (!existing) return null;

  const updated: WorkItem = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  await saveJson(itemKey(id), updated);

  const index = await loadIndex();
  const idx = index.findIndex((e) => e.id === id);
  if (idx !== -1) {
    index[idx] = {
      id: updated.id,
      title: updated.title,
      targetRepo: updated.targetRepo,
      status: updated.status,
      priority: updated.priority,
      updatedAt: updated.updatedAt,
    };
    await saveIndex(index);
  }

  return updated;
}

const PRIORITY_ORDER: Record<WorkItem["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export async function getNextDispatchable(targetRepo: string): Promise<WorkItem | null> {
  const entries = await listWorkItems({ status: "ready", targetRepo });
  if (entries.length === 0) return null;

  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  const valid = items.filter((i): i is WorkItem => i !== null);

  // Filter out items with unmet dependencies
  const dispatchable: WorkItem[] = [];
  for (const item of valid) {
    // Direct items have no project and no dependencies — always dispatchable
    if (item.source.type === 'direct') {
      dispatchable.push(item);
      continue;
    }
    if (item.dependencies.length === 0) {
      dispatchable.push(item);
      continue;
    }
    // Check all dependencies are merged
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allMerged = depItems.every((dep) => dep !== null && dep.status === "merged");
    if (allMerged) {
      dispatchable.push(item);
    }
  }

  if (dispatchable.length === 0) return null;

  dispatchable.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return dispatchable[0] ?? null;
}

export async function getAllDispatchable(targetRepo: string): Promise<WorkItem[]> {
  const entries = await listWorkItems({ status: "ready", targetRepo });
  if (entries.length === 0) return [];

  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  const valid = items.filter((i): i is WorkItem => i !== null);

  const dispatchable: WorkItem[] = [];
  for (const item of valid) {
    // Direct items have no project and no dependencies — always dispatchable
    if (item.source.type === 'direct') {
      dispatchable.push(item);
      continue;
    }
    if (item.dependencies.length === 0) {
      dispatchable.push(item);
      continue;
    }
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allMerged = depItems.every((dep) => dep !== null && dep.status === "merged");
    if (allMerged) {
      dispatchable.push(item);
    }
  }

  // Sort by priority then creation time
  dispatchable.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return dispatchable;
}

export async function getBlockedByDependencies(targetRepo: string): Promise<WorkItem[]> {
  const entries = await listWorkItems({ status: "ready", targetRepo });
  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  const valid = items.filter((i): i is WorkItem => i !== null);

  const blocked: WorkItem[] = [];
  for (const item of valid) {
    if (item.dependencies.length === 0) continue;
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allMerged = depItems.every((dep) => dep !== null && dep.status === "merged");
    if (!allMerged) {
      blocked.push(item);
    }
  }
  return blocked;
}

export async function deleteWorkItem(id: string): Promise<boolean> {
  const existing = await getWorkItem(id);
  if (!existing) return false;

  await deleteJson(itemKey(id));

  const index = await loadIndex();
  const filtered = index.filter((e) => e.id !== id);
  await saveIndex(filtered);

  return true;
}

/**
 * Rebuild the work items index by scanning all blobs in Vercel Blob storage.
 * Use this to recover from index deletion/corruption.
 */
export async function rebuildIndex(): Promise<{ recovered: number; errors: number }> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("rebuildIndex requires BLOB_READ_WRITE_TOKEN (production only)");
  }

  const { list } = await import("@vercel/blob");
  const { blobs } = await list({ prefix: "af-data/work-items/", mode: "folded" });

  const recoveredEntries: WorkItemIndexEntry[] = [];
  let errors = 0;

  for (const blob of blobs) {
    const id = blob.pathname.replace("af-data/work-items/", "").replace(".json", "");
    if (!id || id === "index") continue;

    try {
      const item = await loadJson<WorkItem>(itemKey(id), { required: true });
      if (item) {
        recoveredEntries.push({
          id: item.id,
          title: item.title,
          targetRepo: item.targetRepo,
          status: item.status,
          priority: item.priority,
          updatedAt: item.updatedAt,
        });
      }
    } catch {
      console.error(`[work-items] rebuildIndex: failed to load blob for id "${id}"`);
      errors++;
    }
  }

  await saveIndex(recoveredEntries);
  console.log(`[work-items] rebuildIndex: recovered ${recoveredEntries.length} items, ${errors} errors`);

  return { recovered: recoveredEntries.length, errors };
}
