import { z } from "zod";

// --- WorkItem ---

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  targetRepo: string;
  source: {
    type: "pa-improvement" | "github-issue" | "manual";
    sourceId?: string;
    sourceUrl?: string;
  };
  priority: "high" | "medium" | "low";
  riskLevel: "low" | "medium" | "high";
  complexity: "simple" | "moderate" | "complex";
  status:
    | "filed"
    | "ready"
    | "queued"
    | "generating"
    | "executing"
    | "reviewing"
    | "merged"
    | "failed"
    | "parked";
  dependencies: string[];
  handoff: {
    content: string;
    branch: string;
    budget: number;
    generatedAt: string;
  } | null;
  execution: {
    workflowRunId?: number;
    prNumber?: number;
    prUrl?: string;
    startedAt?: string;
    completedAt?: string;
    outcome?: "merged" | "failed" | "parked" | "reverted";
    retryCount?: number;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemIndexEntry {
  id: string;
  title: string;
  targetRepo: string;
  status: WorkItem["status"];
  priority: WorkItem["priority"];
  updatedAt: string;
}

export const createWorkItemSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  targetRepo: z.string().min(1),
  source: z.object({
    type: z.enum(["pa-improvement", "github-issue", "manual"]),
    sourceId: z.string().optional(),
    sourceUrl: z.string().url().optional(),
  }),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
  complexity: z.enum(["simple", "moderate", "complex"]).default("moderate"),
  dependencies: z.array(z.string()).default([]),
});

export const updateWorkItemSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  targetRepo: z.string().min(1).optional(),
  source: z
    .object({
      type: z.enum(["pa-improvement", "github-issue", "manual"]),
      sourceId: z.string().optional(),
      sourceUrl: z.string().url().optional(),
    })
    .optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  riskLevel: z.enum(["low", "medium", "high"]).optional(),
  complexity: z.enum(["simple", "moderate", "complex"]).optional(),
  status: z
    .enum([
      "filed",
      "ready",
      "queued",
      "generating",
      "executing",
      "reviewing",
      "merged",
      "failed",
      "parked",
    ])
    .optional(),
  dependencies: z.array(z.string()).optional(),
  handoff: z
    .object({
      content: z.string(),
      branch: z.string(),
      budget: z.number(),
      generatedAt: z.string(),
    })
    .nullable()
    .optional(),
  execution: z
    .object({
      workflowRunId: z.number().optional(),
      prNumber: z.number().optional(),
      prUrl: z.string().url().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      outcome: z.enum(["merged", "failed", "parked", "reverted"]).optional(),
      retryCount: z.number().optional(),
    })
    .nullable()
    .optional(),
});

export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;

// --- RepoConfig ---

export interface RepoConfig {
  id: string;
  fullName: string;
  shortName: string;
  claudeMdPath: string;
  systemMapPath?: string;
  adrPath?: string;
  handoffDir: string;
  executeWorkflow: string;
  concurrencyLimit: number;
  defaultBudget: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepoIndexEntry {
  id: string;
  fullName: string;
  shortName: string;
  updatedAt: string;
}

export const createRepoSchema = z.object({
  fullName: z.string().min(1),
  shortName: z.string().min(1),
  claudeMdPath: z.string().default("CLAUDE.md"),
  systemMapPath: z.string().optional(),
  adrPath: z.string().optional(),
  handoffDir: z.string().default("handoffs/"),
  executeWorkflow: z.string().default("execute-handoff.yml"),
  concurrencyLimit: z.number().int().min(1).default(1),
  defaultBudget: z.number().positive().default(8),
});

export const updateRepoSchema = z.object({
  fullName: z.string().min(1).optional(),
  shortName: z.string().min(1).optional(),
  claudeMdPath: z.string().optional(),
  systemMapPath: z.string().optional(),
  adrPath: z.string().optional(),
  handoffDir: z.string().optional(),
  executeWorkflow: z.string().optional(),
  concurrencyLimit: z.number().int().min(1).optional(),
  defaultBudget: z.number().positive().optional(),
});

export type CreateRepoInput = z.infer<typeof createRepoSchema>;
export type UpdateRepoInput = z.infer<typeof updateRepoSchema>;

// --- ATC ---

export interface ATCEvent {
  id: string;
  timestamp: string;
  type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup";
  workItemId: string;
  details: string;
  previousStatus?: string;
  newStatus?: string;
}

export interface ATCState {
  lastRunAt: string;
  activeExecutions: {
    workItemId: string;
    targetRepo: string;
    branch: string;
    status: string;
    startedAt: string;
    elapsedMinutes: number;
    filesBeingModified: string[];
  }[];
  queuedItems: number;
  recentEvents: ATCEvent[];
}
