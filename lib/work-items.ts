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
 * Terminal statuses that should not be transitioned back to non-terminal states.
 * Prevents the lost-update bug where ATC health monitor overwrites MCP status changes.
 * See ADR: work item store race condition fix.
 */
const TERMINAL_STATUSES = new Set<string>(['cancelled', 'merged', 'obsolete']);

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

/**
 * Load full WorkItem objects for all items matching filters.
 * More expensive than listWorkItems (reads each blob), so use sparingly.
 */
export async function listWorkItemsFull(
  filters?: WorkItemFilters
): Promise<WorkItem[]> {
  const index = await listWorkItems(filters);
  const items = await Promise.all(index.map((e) => getWorkItem(e.id)));
  return items.filter((i): i is WorkItem => i !== null);
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
    source: item.source,
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

  // Guard: don't allow transitioning OUT of terminal states.
  // This prevents ATC health monitor from overwriting MCP-driven status changes
  // (e.g., an item marked 'cancelled' via MCP being reverted to 'failed' by
  // the reconciliation loop reading stale index data).
  if (
    TERMINAL_STATUSES.has(existing.status) &&
    patch.status &&
    !TERMINAL_STATUSES.has(patch.status)
  ) {
    console.warn('[work-items] blocked transition from terminal status', {
      id,
      currentStatus: existing.status,
      attemptedStatus: patch.status,
    });
    return existing; // return existing item without modification
  }

  const updated: WorkItem = {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  // Write the individual item blob first (source of truth)
  await saveJson(itemKey(id), updated);

  // Update the index blob — upsert to handle both existing and missing entries
  const indexEntry: WorkItemIndexEntry = {
    id: updated.id,
    title: updated.title,
    targetRepo: updated.targetRepo,
    status: updated.status,
    priority: updated.priority,
    updatedAt: updated.updatedAt,
    source: updated.source,
  };
  try {
    const index = await loadIndex();
    const idx = index.findIndex((e) => e.id === id);
    if (idx !== -1) {
      index[idx] = indexEntry;
    } else {
      // Item missing from index — add it rather than silently skipping
      console.warn('[work-items] item missing from index during update, adding', { id });
      index.push(indexEntry);
    }
    await saveIndex(index);
  } catch (err) {
    console.warn('[work-items] index write failed for item', {
      id: updated.id,
      newStatus: updated.status,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return updated;
}

const PRIORITY_ORDER: Record<WorkItem["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export async function getNextDispatchable(targetRepo: string): Promise<WorkItem | null> {
  // Only 'ready' items are considered — escalated, blocked, parked, etc. are implicitly excluded
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
    // Check all dependencies are resolved (merged or cancelled)
    // Cancelled deps are treated as resolved: the work was either completed under
    // a different item ID or is no longer needed — either way, the dependent item can proceed.
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allResolved = depItems.every((dep) => dep !== null && (dep.status === "merged" || dep.status === "cancelled"));
    if (allResolved) {
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
    const allResolved = depItems.every((dep) => dep !== null && (dep.status === "merged" || dep.status === "cancelled"));
    if (allResolved) {
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
    const allResolved = depItems.every((dep) => dep !== null && (dep.status === "merged" || dep.status === "cancelled"));
    if (!allResolved) {
      blocked.push(item);
    }
  }
  return blocked;
}

/**
 * Find a work item by its handoff branch name.
 * Scans active items (executing, reviewing, merged) to bridge the gap between
 * the execute-handoff workflow (which knows branch) and the work item store.
 */
export async function findWorkItemByBranch(branch: string): Promise<WorkItem | null> {
  const activeStatuses: WorkItem["status"][] = ["executing", "reviewing", "retrying", "merged"];
  const index = await loadIndex();
  const candidates = index.filter((e) => activeStatuses.includes(e.status));

  for (const entry of candidates) {
    const item = await getWorkItem(entry.id);
    if (item?.handoff?.branch === branch) return item;
  }
  return null;
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
 * Reconciles the work item index against individual item blobs.
 * Reads the individual blob for each item and repairs the index entry
 * if the status differs. Checks ALL items (including terminal states)
 * because MCP updates can change terminal status while the index is stale.
 * Returns a summary of repaired items.
 */
export async function reconcileWorkItemIndex(): Promise<{
  checked: number;
  repaired: number;
  repairedItems: Array<{ id: string; indexStatus: string; blobStatus: string }>;
}> {
  const index = await loadIndex();
  const repairedItems: Array<{ id: string; indexStatus: string; blobStatus: string }> = [];
  let needsSave = false;

  for (let i = 0; i < index.length; i++) {
    const entry = index[i];

    try {
      const blobItem = await getWorkItem(entry.id);
      if (blobItem && blobItem.status !== entry.status) {
        console.warn('[work-items] index/blob drift detected', {
          id: entry.id,
          indexStatus: entry.status,
          blobStatus: blobItem.status,
        });
        // Update the index entry to match the blob (source of truth)
        index[i] = {
          id: blobItem.id,
          title: blobItem.title,
          targetRepo: blobItem.targetRepo,
          status: blobItem.status,
          priority: blobItem.priority,
          updatedAt: blobItem.updatedAt,
          source: blobItem.source,
        };
        repairedItems.push({
          id: entry.id,
          indexStatus: entry.status,
          blobStatus: blobItem.status,
        });
        needsSave = true;
      }
    } catch (err) {
      console.error('[work-items] reconcile error for item', entry.id, err);
    }
  }

  if (needsSave) {
    await saveIndex(index);
  }

  return { checked: index.length, repaired: repairedItems.length, repairedItems };
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
          source: item.source,
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
