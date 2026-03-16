import { z } from "zod";

// --- Fast-lane types & constants ---

export type ComplexityHint = 'simple' | 'moderate';

export const FAST_LANE_BUDGET_SIMPLE = 2;
export const FAST_LANE_BUDGET_MODERATE = 4;

// --- WorkItem ---

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  targetRepo: string;
  source: {
    type: "pa-improvement" | "github-issue" | "manual" | "project" | "direct";
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
  } | null;
  escalation?: {
    id: string;
    reason: string;
    blockedAt: string;
  };
  triggeredBy?: string;
  complexityHint?: ComplexityHint;
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
    type: z.enum(["pa-improvement", "github-issue", "manual", "project", "direct"]),
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
      type: z.enum(["pa-improvement", "github-issue", "manual", "project", "direct"]),
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

/** An individual work item entry within a backlog review, with a triage recommendation. */
export interface BacklogReviewItem {
  /** The ID of the work item being reviewed. */
  workItemId: string;
  /** The target repository for this work item (e.g., "owner/repo"). */
  repo: string;
  /** Human-readable title of the work item. */
  title: string;
  /** Priority level of the work item. */
  priority: string;
  /** Triage recommendation: dispatch now, defer, or remove from backlog. */
  recommendation: 'dispatch' | 'defer' | 'kill';
  /** Rationale explaining the recommendation. */
  rationale: string;
}

/** Result of a full backlog review operation across queued work items. */
export interface BacklogReview {
  /** Unique identifier for this review run. */
  id: string;
  /** ISO 8601 timestamp of when the review was performed. */
  timestamp: string;
  /** Individual item assessments produced during the review. */
  items: BacklogReviewItem[];
  /** Human-readable summary of the overall review findings. */
  summary: string;
  /** Notion page ID if the review was written to a Notion page. */
  notionPageId?: string;
}

/** Health assessment for a single project at a point in time. */
export interface ProjectHealth {
  /** The ID of the project being assessed. */
  projectId: string;
  /** Human-readable name of the project. */
  projectName: string;
  /** Overall health status of the project. */
  status: 'healthy' | 'at-risk' | 'stalled' | 'blocked';
  /** Fraction of work items completed, from 0 (none) to 1 (all). */
  completionRate: number;
  /** Number of active or recent escalations for this project. */
  escalationCount: number;
  /** Average time work items spend in the queue, in hours. */
  avgTimeInQueue: number;
  /** IDs of work items currently in a blocked state. */
  blockedItems: string[];
  /** Specific issues or anomalies detected during the assessment. */
  flags: string[];
  /** ISO 8601 timestamp of when this assessment was performed. */
  assessedAt: string;
}

/** Aggregated health report covering all assessed projects. */
export interface ProjectHealthReport {
  /** Individual health assessments keyed by project ID. */
  projects: ProjectHealth[];
  /** ISO 8601 timestamp of when the report was generated. */
  generatedAt: string;
  /** Human-readable overall summary across all projects. */
  overallSummary: string;
}

/** An individual issue found during plan validation. */
export interface PlanValidationIssue {
  /** The section or field of the plan where the issue was found. */
  section: string;
  /** Severity of the issue: errors block dispatch, warnings are advisory. */
  severity: 'error' | 'warning';
  /** Human-readable description of the issue. */
  message: string;
}

/** Result of validating a project plan against PM Agent rules. */
export interface PlanValidation {
  /** The ID of the project whose plan was validated. */
  projectId: string;
  /** Whether the plan passed validation (no errors; warnings are allowed). */
  valid: boolean;
  /** List of issues found during validation. */
  issues: PlanValidationIssue[];
  /** ISO 8601 timestamp of when validation was performed. */
  checkedAt: string;
}

/** Configuration controlling PM Agent behaviour and scheduling. */
export interface PMAgentConfig {
  /** Whether PM Agent operations are active. */
  enabled: boolean;
  /** Cron expression defining how often the PM Agent sweep runs (e.g., "0 9 * * *" for daily at 9am). */
  sweepSchedule: string;
  /** Email address that receives digest and alert emails from the PM Agent. */
  digestRecipient: string;
  /** Whether the PM Agent automatically reviews and re-prioritises the backlog each sweep. */
  autoReview: boolean;
}

/** Options controlling the content and scope of a progress digest. */
export interface DigestOptions {
  /** Time period the digest covers. */
  period: 'daily' | 'weekly';
  /** Whether to include project health assessments in the digest. */
  includeHealth: boolean;
  /** Whether to include backlog review results in the digest. */
  includeBacklog: boolean;
  /** Whether to include triage recommendations in the digest. */
  includeRecommendations: boolean;
}
