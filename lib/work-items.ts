import { randomUUID } from "crypto";
import { loadJson, saveJson, deleteJson } from "./storage";
import type {
  WorkItem,
  WorkItemIndexEntry,
  CreateWorkItemInput,
  UpdateWorkItemInput,
} from "./types";

const INDEX_KEY = "work-items/index";

function itemKey(id: string): string {
  return `work-items/${id}`;
}

async function loadIndex(): Promise<WorkItemIndexEntry[]> {
  return (await loadJson<WorkItemIndexEntry[]>(INDEX_KEY)) ?? [];
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

export async function deleteWorkItem(id: string): Promise<boolean> {
  const existing = await getWorkItem(id);
  if (!existing) return false;

  await deleteJson(itemKey(id));

  const index = await loadIndex();
  const filtered = index.filter((e) => e.id !== id);
  await saveIndex(filtered);

  return true;
}
