import { z } from "zod";

// --- Fast-lane types & constants ---

export type ComplexityHint = 'simple' | 'moderate';

export const FAST_LANE_BUDGET_SIMPLE = 2;
export const FAST_LANE_BUDGET_MODERATE = 4;

// --- Failure categorization ---

export type FailureCategory = 'transient' | 'execution' | 'structural' | 'unknown';

// --- WorkItem ---

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  targetRepo: string;
  source: {
    type: "pa-improvement" | "github-issue" | "manual" | "project" | "direct" | "pm-agent";
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
    | "parked"
    | "blocked"
    | "cancelled"
    | "escalated";
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
    /** Actual files modified by the PR (populated once PR exists, more accurate than estimated files) */
    filesModified?: string[];
  } | null;
  escalation?: {
    id: string;
    reason: string;
    blockedAt: string;
  };
  triggeredBy?: string;
  complexityHint?: ComplexityHint;
  failureCategory?: FailureCategory;
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
    type: z.enum(["pa-improvement", "github-issue", "manual", "project", "direct", "pm-agent"]),
    sourceId: z.string().optional(),
    sourceUrl: z.string().url().optional(),
  }),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
  riskLevel: z.enum(["low", "medium", "high"]).default("medium"),
  complexity: z.enum(["simple", "moderate", "complex"]).default("moderate"),
  dependencies: z.array(z.string()).default([]),
  triggeredBy: z.string().optional(),
  complexityHint: z.enum(["simple", "moderate"]).optional(),
});

export const updateWorkItemSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  targetRepo: z.string().min(1).optional(),
  source: z
    .object({
      type: z.enum(["pa-improvement", "github-issue", "manual", "project", "direct", "pm-agent"]),
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
      "blocked",
      "cancelled",
      "escalated",
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
      filesModified: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
  escalation: z
    .object({
      id: z.string(),
      reason: z.string(),
      blockedAt: z.string(),
    })
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

// --- TLM Memory ---

export interface TLMMemoryStats {
  totalAssessed: number;
  correct: number;
  reversed: number;
  causedIssues: number;
  missed: number;
  lastAssessment: string;
}

export interface TLMHotPattern {
  date: string;
  pattern: string;
}

export interface TLMOutcome {
  date: string;
  action: string;
  entity: string;
  outcome: string;
  notes: string;
}

export interface TLMLesson {
  date: string;
  lesson: string;
}

export interface TLMMemory {
  stats: TLMMemoryStats;
  hotPatterns: TLMHotPattern[];
  recentOutcomes: TLMOutcome[];
  lessonsLearned: TLMLesson[];
}

// --- Project (Notion) ---

export type ProjectStatus = "Draft" | "Ready" | "Execute" | "Executing" | "Complete" | "Failed";
export type ProjectPriority = "P0" | "P1" | "P2";
export type ProjectComplexity = "Simple" | "Moderate" | "Complex";
export type ProjectRiskLevel = "Low" | "Medium" | "High";
export type ProjectTargetRepo = "personal-assistant" | "rez-sniper" | "agent-forge";

export interface Project {
  id: string;
  projectId: string; // e.g. "PRJ-1"
  title: string;
  planUrl: string | null;
  targetRepo: ProjectTargetRepo | null;
  status: ProjectStatus;
  priority: ProjectPriority | null;
  complexity: ProjectComplexity | null;
  riskLevel: ProjectRiskLevel | null;
  createdAt: string;
}

// --- ATC ---

export interface ATCEvent {
  id: string;
  timestamp: string;
  type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup" | "project_trigger" | "project_completion" | "work_item_reconciled" | "escalation" | "escalation_timeout" | "escalation_resolved" | "dependency_block" | "auto_cancel";
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

// Repo Bootstrapper types

export type PipelineLevel = 'execute-only' | 'full-tlm';

export interface BootstrapOptions {
  repoName: string;
  description?: string;
  pipelineLevel: PipelineLevel;
  isPrivate?: boolean;
  createVercelProject?: boolean;
  vercelFramework?: string;
}

export interface BootstrapStep {
  name: string;
  status: 'success' | 'failed' | 'skipped';
  detail?: string;
}

export interface BootstrapResult {
  repoUrl: string;
  repoId: number;
  registrationId: string;
  vercelProjectUrl?: string;
  steps: BootstrapStep[];
}

// ---------------------------------------------------------------------------
// PM Agent Types
// ---------------------------------------------------------------------------

export interface BacklogReview {
  id: string;
  timestamp: string;
  repos: string[];
  totalItemsReviewed: number;
  recommendations: BacklogRecommendation[];
  summary: string;
  notionPageId?: string;
}

export interface BacklogRecommendation {
  workItemId: string;
  action: 'dispatch' | 'defer' | 'kill' | 'escalate';
  priority: 'high' | 'medium' | 'low';
  rationale: string;
}

export interface ProjectHealth {
  projectId: string;
  projectName: string;
  status: 'healthy' | 'at-risk' | 'stalling' | 'blocked';
  completionRate: number;
  escalationCount: number;
  avgTimeInQueue: number;
  blockedItems: number;
  totalItems: number;
  mergedItems: number;
  failedItems: number;
  issues: string[];
}

export interface PlanValidation {
  projectId: string;
  valid: boolean;
  issues: PlanValidationIssue[];
  checkedAt: string;
}

export interface PlanValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  section?: string;
}

export interface PMAgentConfig {
  enabled: boolean;
  dailySweepHour: number;
  repos: string[];
  maxRecommendations: number;
}

export interface DigestOptions {
  includeHealth: boolean;
  includeBacklog: boolean;
  includeRecommendations: boolean;
  recipientEmail?: string;
}

// ---------------------------------------------------------------------------
// PM Agent Types (legacy — used by pm-agent.ts and pm-prompts.ts)
// ---------------------------------------------------------------------------

export interface BacklogReviewItem {
  workItemId: string;
  repo: string;
  title: string;
  priority: string;
  recommendation: 'dispatch' | 'defer' | 'kill';
  rationale: string;
}

export interface ProjectHealthReport {
  projects: ProjectHealth[];
  generatedAt: string;
  overallSummary: string;
}
