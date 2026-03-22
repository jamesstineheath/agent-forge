import { randomUUID } from "crypto";
import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { plans } from "./db/schema";
import type { Plan, PlanStatus, PlanProgress, CreatePlanInput } from "./types";

/**
 * Convert a database row to a Plan object.
 */
function rowToPlan(row: typeof plans.$inferSelect): Plan {
  return {
    id: row.id,
    prdId: row.prdId,
    prdTitle: row.prdTitle,
    targetRepo: row.targetRepo,
    branchName: row.branchName,
    status: row.status as PlanStatus,
    acceptanceCriteria: row.acceptanceCriteria,
    kgContext: (row.kgContext ?? null) as Plan["kgContext"],
    affectedFiles: (row.affectedFiles ?? null) as string[] | null,
    estimatedBudget: row.estimatedBudget,
    actualCost: row.actualCost,
    maxDurationMinutes: row.maxDurationMinutes ?? 60,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    errorLog: row.errorLog,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    workflowRunId: row.workflowRunId,
    retryCount: row.retryCount ?? 0,
    prdRank: row.prdRank ?? null,
    progress: (row.progress ?? null) as PlanProgress | null,
    reviewFeedback: row.reviewFeedback ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Normalize targetRepo to full "owner/repo" format.
 */
function normalizeTargetRepo(repo: string): string {
  if (repo.includes("/")) return repo;
  return `jamesstineheath/${repo}`;
}

/**
 * Generate a branch name from PRD number and title.
 * Convention: prd-{number}/{slugified-title}
 */
export function generateBranchName(prdId: string, title: string): string {
  const number = prdId.replace("PRD-", "");
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `prd-${number}/${slug}`;
}

export async function createPlan(input: CreatePlanInput): Promise<Plan> {
  const now = new Date();
  const id = `plan-${randomUUID().slice(0, 8)}`;

  const rows = await db
    .insert(plans)
    .values({
      id,
      prdId: input.prdId,
      prdTitle: input.prdTitle,
      targetRepo: normalizeTargetRepo(input.targetRepo),
      branchName: input.branchName,
      status: input.status ?? "ready",
      acceptanceCriteria: input.acceptanceCriteria,
      kgContext: input.kgContext ?? null,
      affectedFiles: input.affectedFiles ?? null,
      estimatedBudget: input.estimatedBudget ?? null,
      maxDurationMinutes: input.maxDurationMinutes ?? 60,
      prdRank: input.prdRank ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return rowToPlan(rows[0]);
}

export async function getPlan(planId: string): Promise<Plan | null> {
  const rows = await db
    .select()
    .from(plans)
    .where(eq(plans.id, planId))
    .limit(1);
  if (rows.length === 0) return null;
  return rowToPlan(rows[0]);
}

export async function listPlans(filters?: {
  status?: PlanStatus;
  targetRepo?: string;
  prdId?: string;
}): Promise<Plan[]> {
  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(plans.status, filters.status));
  }
  if (filters?.targetRepo) {
    const repo = filters.targetRepo;
    const shortRepo = repo.includes("/") ? repo.split("/")[1] : repo;
    conditions.push(
      sql`(${plans.targetRepo} = ${repo} OR ${plans.targetRepo} LIKE ${"%" + shortRepo})`
    );
  }
  if (filters?.prdId) {
    conditions.push(eq(plans.prdId, filters.prdId));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select().from(plans).where(where);
  return rows.map(rowToPlan);
}

export async function updatePlanStatus(
  planId: string,
  status: PlanStatus,
  fields?: Partial<{
    actualCost: number;
    errorLog: string;
    prNumber: number;
    prUrl: string;
    workflowRunId: string;
    startedAt: string;
    completedAt: string;
    retryCount: number;
    reviewFeedback: string;
  }>
): Promise<Plan | null> {
  const setCols: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };

  if (fields?.actualCost !== undefined) setCols.actualCost = fields.actualCost;
  if (fields?.errorLog !== undefined) setCols.errorLog = fields.errorLog;
  if (fields?.prNumber !== undefined) setCols.prNumber = fields.prNumber;
  if (fields?.prUrl !== undefined) setCols.prUrl = fields.prUrl;
  if (fields?.workflowRunId !== undefined) setCols.workflowRunId = fields.workflowRunId;
  if (fields?.startedAt !== undefined) setCols.startedAt = new Date(fields.startedAt);
  if (fields?.completedAt !== undefined) setCols.completedAt = new Date(fields.completedAt);
  if (fields?.retryCount !== undefined) setCols.retryCount = fields.retryCount;
  if (fields?.reviewFeedback !== undefined) setCols.reviewFeedback = fields.reviewFeedback;

  const rows = await db
    .update(plans)
    .set(setCols)
    .where(eq(plans.id, planId))
    .returning();

  if (rows.length === 0) return null;
  return rowToPlan(rows[0]);
}

/**
 * Get all plans that are actively executing or dispatching for a given repo.
 * Used for concurrency control.
 */
export async function getActivePlansForRepo(repo: string): Promise<Plan[]> {
  const normalizedRepo = normalizeTargetRepo(repo);
  const shortRepo = normalizedRepo.includes("/")
    ? normalizedRepo.split("/")[1]
    : normalizedRepo;

  const rows = await db
    .select()
    .from(plans)
    .where(
      and(
        inArray(plans.status, ["executing", "dispatching"]),
        sql`(${plans.targetRepo} = ${normalizedRepo} OR ${plans.targetRepo} LIKE ${"%" + shortRepo})`
      )
    );

  return rows.map(rowToPlan);
}

/**
 * Find a plan by its branch name.
 */
export async function findPlanByBranch(branchName: string): Promise<Plan | null> {
  const rows = await db
    .select()
    .from(plans)
    .where(eq(plans.branchName, branchName))
    .limit(1);
  if (rows.length === 0) return null;
  return rowToPlan(rows[0]);
}

/**
 * Find a plan by its PR number and repo.
 */
export async function findPlanByPR(repo: string, prNumber: number): Promise<Plan | null> {
  const normalizedRepo = normalizeTargetRepo(repo);
  const shortRepo = normalizedRepo.includes("/")
    ? normalizedRepo.split("/")[1]
    : normalizedRepo;

  const rows = await db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.prNumber, prNumber),
        sql`(${plans.targetRepo} = ${normalizedRepo} OR ${plans.targetRepo} LIKE ${"%" + shortRepo})`
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  return rowToPlan(rows[0]);
}

/**
 * Update the progress snapshot on a plan record.
 */
export async function updatePlanProgress(
  planId: string,
  progress: PlanProgress
): Promise<Plan | null> {
  const rows = await db
    .update(plans)
    .set({ progress, updatedAt: new Date() })
    .where(eq(plans.id, planId))
    .returning();

  if (rows.length === 0) return null;
  return rowToPlan(rows[0]);
}
