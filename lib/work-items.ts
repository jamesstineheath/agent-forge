import { randomUUID } from "crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { workItems } from "./db/schema";
import type {
  WorkItem,
  WorkItemIndexEntry,
  CreateWorkItemInput,
  UpdateWorkItemInput,
} from "./types";
import { FAST_LANE_BUDGET_SIMPLE, FAST_LANE_BUDGET_MODERATE } from "./types";

/**
 * Terminal statuses that should not be transitioned back to non-terminal states.
 * Prevents the lost-update bug where ATC health monitor overwrites MCP status changes.
 */
const TERMINAL_STATUSES = new Set<string>(["cancelled", "merged", "obsolete"]);

/**
 * Return the default budget for a given complexityHint.
 * Used during handoff generation when no explicit budget is provided.
 */
export function getDefaultBudgetForHint(
  hint?: "simple" | "moderate"
): number | undefined {
  if (hint === "simple") return FAST_LANE_BUDGET_SIMPLE;
  if (hint === "moderate") return FAST_LANE_BUDGET_MODERATE;
  return undefined;
}

/**
 * Normalize targetRepo to full "owner/repo" format.
 * Handles both short ("personal-assistant") and full ("jamesstineheath/personal-assistant").
 */
function normalizeTargetRepo(repo: string): string {
  if (repo.includes("/")) return repo;
  return `jamesstineheath/${repo}`;
}

/** Convert a database row to a WorkItem (maps snake_case columns to camelCase). */
export function rowToWorkItem(row: typeof workItems.$inferSelect): WorkItem {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    targetRepo: row.targetRepo,
    status: row.status as WorkItem["status"],
    priority: row.priority as WorkItem["priority"],
    riskLevel: row.riskLevel as WorkItem["riskLevel"],
    complexity: row.complexity as WorkItem["complexity"],
    type: row.type as WorkItem["type"],
    source: row.source as WorkItem["source"],
    dependencies: (row.dependencies ?? []) as string[],
    triggeredBy: row.triggeredBy ?? undefined,
    complexityHint: row.complexityHint as WorkItem["complexityHint"],
    expedite: row.expedite ?? undefined,
    triagePriority: row.triagePriority as WorkItem["triagePriority"],
    rank: row.rank ?? undefined,
    handoff: (row.handoff ?? null) as WorkItem["handoff"],
    execution: (row.execution ?? null) as WorkItem["execution"],
    retryBudget: row.retryBudget ?? undefined,
    blockedReason: row.blockedReason as WorkItem["blockedReason"],
    escalation: (row.escalation ?? undefined) as WorkItem["escalation"],
    failureCategory: row.failureCategory as WorkItem["failureCategory"],
    attribution: (row.attribution ?? undefined) as WorkItem["attribution"],
    spikeMetadata: (row.spikeMetadata ?? undefined) as WorkItem["spikeMetadata"],
    reasoningMetrics: (row.reasoningMetrics ??
      undefined) as WorkItem["reasoningMetrics"],
    waveNumber: row.waveNumber ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Convert a database row to a WorkItemIndexEntry. */
function rowToIndexEntry(
  row: typeof workItems.$inferSelect
): WorkItemIndexEntry {
  return {
    id: row.id,
    title: row.title,
    targetRepo: row.targetRepo,
    status: row.status as WorkItem["status"],
    priority: row.priority as WorkItem["priority"],
    updatedAt: row.updatedAt.toISOString(),
    source: row.source as WorkItem["source"],
  };
}

export interface WorkItemFilters {
  status?: WorkItem["status"];
  targetRepo?: string;
  priority?: WorkItem["priority"];
}

/**
 * Build WHERE conditions from filters.
 * targetRepo matching: supports both short ("personal-assistant") and
 * full ("jamesstineheath/personal-assistant") formats by matching on the
 * short name portion.
 */
function buildWhereConditions(filters?: WorkItemFilters) {
  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(workItems.status, filters.status));
  }
  if (filters?.targetRepo) {
    const filterRepo = filters.targetRepo;
    const filterShort = filterRepo.includes("/")
      ? filterRepo.split("/")[1]
      : filterRepo;
    // Match full repo name OR short name suffix
    conditions.push(
      sql`(${workItems.targetRepo} = ${filterRepo} OR ${workItems.targetRepo} LIKE ${"%" + filterShort})`
    );
  }
  if (filters?.priority) {
    conditions.push(eq(workItems.priority, filters.priority));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function listWorkItems(
  filters?: WorkItemFilters
): Promise<WorkItemIndexEntry[]> {
  const where = buildWhereConditions(filters);
  const rows = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      targetRepo: workItems.targetRepo,
      status: workItems.status,
      priority: workItems.priority,
      updatedAt: workItems.updatedAt,
      source: workItems.source,
    })
    .from(workItems)
    .where(where);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    targetRepo: row.targetRepo,
    status: row.status as WorkItem["status"],
    priority: row.priority as WorkItem["priority"],
    updatedAt: row.updatedAt.toISOString(),
    source: row.source as WorkItem["source"],
  }));
}

/**
 * Load full WorkItem objects for all items matching filters.
 * Single query — much faster than the old N+1 blob loading.
 */
export async function listWorkItemsFull(
  filters?: WorkItemFilters
): Promise<WorkItem[]> {
  const where = buildWhereConditions(filters);
  const rows = await db.select().from(workItems).where(where);
  return rows.map(rowToWorkItem);
}

export async function getWorkItem(id: string): Promise<WorkItem | null> {
  const rows = await db
    .select()
    .from(workItems)
    .where(eq(workItems.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  return rowToWorkItem(rows[0]);
}

export async function createWorkItem(
  data: CreateWorkItemInput
): Promise<WorkItem> {
  // Spike-specific validation
  if (data.type === "spike") {
    if (!data.spikeMetadata) {
      throw new Error("Spike work items must include spikeMetadata");
    }
    if (!data.spikeMetadata.parentPrdId) {
      throw new Error("Spike work items must have spikeMetadata.parentPrdId");
    }
    if (!data.spikeMetadata.technicalQuestion) {
      throw new Error("Spike work items must have spikeMetadata.technicalQuestion");
    }
  }

  const now = new Date();
  const id = randomUUID();

  const rows = await db
    .insert(workItems)
    .values({
      id,
      title: data.title,
      description: data.description,
      targetRepo: normalizeTargetRepo(data.targetRepo),
      source: data.source,
      priority: data.priority,
      riskLevel: data.riskLevel,
      complexity: data.complexity,
      type: data.type ?? null,
      status: "filed",
      dependencies: data.dependencies,
      triggeredBy: data.triggeredBy,
      complexityHint: data.complexityHint,
      expedite: data.expedite,
      triagePriority: data.triagePriority,
      rank: data.rank,
      spikeMetadata: data.spikeMetadata ?? null,
      handoff: null,
      execution: null,
      prdId:
        data.source.type === "project" &&
        data.source.sourceId?.startsWith("PRD-")
          ? data.source.sourceId
          : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return rowToWorkItem(rows[0]);
}

export async function updateWorkItem(
  id: string,
  patch: UpdateWorkItemInput
): Promise<WorkItem | null> {
  const existing = await getWorkItem(id);
  if (!existing) return null;

  // Guard: don't allow transitioning OUT of terminal states.
  // Exception: cancelled → ready is allowed for recovering wrongly-cancelled items.
  const isRecoveryTransition =
    existing.status === "cancelled" && patch.status === "ready";
  if (
    TERMINAL_STATUSES.has(existing.status) &&
    patch.status &&
    !TERMINAL_STATUSES.has(patch.status) &&
    !isRecoveryTransition
  ) {
    console.warn("[work-items] blocked transition from terminal status", {
      id,
      currentStatus: existing.status,
      attemptedStatus: patch.status,
    });
    return existing;
  }

  // Build the SET clause from the patch
  const setCols: Record<string, unknown> = {
    updatedAt: new Date(),
  };
  if (patch.title !== undefined) setCols.title = patch.title;
  if (patch.description !== undefined) setCols.description = patch.description;
  if (patch.targetRepo !== undefined)
    setCols.targetRepo = normalizeTargetRepo(patch.targetRepo);
  if (patch.source !== undefined) setCols.source = patch.source;
  if (patch.priority !== undefined) setCols.priority = patch.priority;
  if (patch.riskLevel !== undefined) setCols.riskLevel = patch.riskLevel;
  if (patch.complexity !== undefined) setCols.complexity = patch.complexity;
  if (patch.type !== undefined) setCols.type = patch.type;
  if (patch.status !== undefined) setCols.status = patch.status;
  if (patch.dependencies !== undefined)
    setCols.dependencies = patch.dependencies;
  if (patch.handoff !== undefined) setCols.handoff = patch.handoff;
  if (patch.execution !== undefined) setCols.execution = patch.execution;
  if (patch.escalation !== undefined) setCols.escalation = patch.escalation;
  if (patch.blockedReason !== undefined)
    setCols.blockedReason = patch.blockedReason;
  if (patch.failureCategory !== undefined)
    setCols.failureCategory = patch.failureCategory;
  if (patch.expedite !== undefined) setCols.expedite = patch.expedite;
  if (patch.waveNumber !== undefined) setCols.waveNumber = patch.waveNumber;

  const rows = await db
    .update(workItems)
    .set(setCols)
    .where(eq(workItems.id, id))
    .returning();

  if (rows.length === 0) return null;
  return rowToWorkItem(rows[0]);
}

const PRIORITY_ORDER: Record<WorkItem["priority"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Check whether all dependencies of an item are resolved (merged or cancelled).
 */
async function areDependenciesResolved(item: WorkItem): Promise<boolean> {
  if (item.source.type === "direct") return true;
  if (item.dependencies.length === 0) return true;

  const depRows = await db
    .select({ id: workItems.id, status: workItems.status })
    .from(workItems)
    .where(inArray(workItems.id, item.dependencies));

  // Every dependency must exist and be in a resolved state
  if (depRows.length !== item.dependencies.length) return false;
  return depRows.every(
    (dep) => dep.status === "merged" || dep.status === "cancelled"
  );
}

export async function getNextDispatchable(
  targetRepo: string
): Promise<WorkItem | null> {
  const items = await listWorkItemsFull({ status: "ready", targetRepo });
  if (items.length === 0) return null;

  const dispatchable: WorkItem[] = [];
  for (const item of items) {
    if (await areDependenciesResolved(item)) {
      dispatchable.push(item);
    }
  }

  if (dispatchable.length === 0) return null;

  dispatchable.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return (
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  });

  return dispatchable[0] ?? null;
}

export async function getAllDispatchable(
  targetRepo: string
): Promise<WorkItem[]> {
  const items = await listWorkItemsFull({ status: "ready", targetRepo });
  if (items.length === 0) return [];

  const dispatchable: WorkItem[] = [];
  for (const item of items) {
    if (await areDependenciesResolved(item)) {
      dispatchable.push(item);
    }
  }

  dispatchable.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return (
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  });

  return dispatchable;
}

export async function getBlockedByDependencies(
  targetRepo: string
): Promise<WorkItem[]> {
  const items = await listWorkItemsFull({ status: "ready", targetRepo });
  const blocked: WorkItem[] = [];
  for (const item of items) {
    if (item.dependencies.length === 0) continue;
    if (!(await areDependenciesResolved(item))) {
      blocked.push(item);
    }
  }
  return blocked;
}

/**
 * Find a work item by its handoff branch name.
 * Uses JSONB query — single indexed scan instead of N+1 blob loads.
 */
export async function findWorkItemByBranch(
  branch: string
): Promise<WorkItem | null> {
  const activeStatuses = [
    "executing",
    "reviewing",
    "retrying",
    "merged",
    "blocked",
  ];
  const rows = await db
    .select()
    .from(workItems)
    .where(
      and(
        inArray(workItems.status, activeStatuses),
        sql`${workItems.handoff}->>'branch' = ${branch}`
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  return rowToWorkItem(rows[0]);
}

/**
 * Find a work item by its PR number and repo.
 * Uses JSONB query — single scan instead of N+1 blob loads.
 */
export async function findWorkItemByPR(
  repo: string,
  prNumber: number
): Promise<WorkItem | null> {
  const relevantStatuses = [
    "executing",
    "reviewing",
    "retrying",
    "merged",
    "failed",
    "blocked",
  ];
  const normalizedRepo = normalizeTargetRepo(repo);
  const shortRepo = normalizedRepo.includes("/")
    ? normalizedRepo.split("/")[1]
    : normalizedRepo;

  const rows = await db
    .select()
    .from(workItems)
    .where(
      and(
        inArray(workItems.status, relevantStatuses),
        sql`(${workItems.execution}->>'prNumber')::int = ${prNumber}`,
        sql`(${workItems.targetRepo} = ${normalizedRepo} OR ${workItems.targetRepo} LIKE ${"%" + shortRepo})`
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  return rowToWorkItem(rows[0]);
}

export async function deleteWorkItem(id: string): Promise<boolean> {
  const result = await db
    .delete(workItems)
    .where(eq(workItems.id, id))
    .returning({ id: workItems.id });
  return result.length > 0;
}

/**
 * No-op: reconciliation is not needed with Postgres (single source of truth).
 * Kept for API compatibility with callers (dispatcher, admin routes).
 */
export async function reconcileWorkItemIndex(): Promise<{
  checked: number;
  repaired: number;
  repairedItems: Array<{ id: string; indexStatus: string; blobStatus: string }>;
}> {
  // With Postgres, there's no index/blob drift to reconcile.
  // Count items for the "checked" field so callers see a reasonable value.
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(workItems);
  const count = Number(result[0]?.count ?? 0);
  return { checked: count, repaired: 0, repairedItems: [] };
}

/**
 * No-op: no separate index to rebuild with Postgres.
 * Kept for API compatibility with the rebuild-index admin route.
 */
export async function rebuildIndex(): Promise<{
  recovered: number;
  errors: number;
}> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(workItems);
  const count = Number(result[0]?.count ?? 0);
  return { recovered: count, errors: 0 };
}
