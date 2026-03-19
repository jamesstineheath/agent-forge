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
    | "retrying"
    | "cancelled"
    | "escalated"
    | "superseded"
    | "verified"
    | "partial";
  type?: "feature" | "bugfix" | "refactor" | "test" | "docs" | "chore";
  dependencies: string[];
  handoff: {
    content: string;
    branch: string;
    budget: number;
    budgetSource?: "learned" | "partial" | "default" | "manual";
    budgetSampleSize?: number;
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
    /** Actual USD cost from Claude API execution (reported by pipeline after completion) */
    actualCost?: number;
  } | null;
  /** Max allowed code-CI retries (default 1). Used by health monitor for code failure retry logic. */
  retryBudget?: number;
  escalation?: {
    id: string;
    reason: string;
    blockedAt: string;
  };
  triggeredBy?: string;
  complexityHint?: ComplexityHint;
  failureCategory?: FailureCategory;
  attribution?: ComponentAttribution[];
  createdAt: string;
  updatedAt: string;
  reasoningMetrics?: ReasoningQualityAssessment;
}

export interface WorkItemIndexEntry {
  id: string;
  title: string;
  targetRepo: string;
  status: WorkItem["status"];
  priority: WorkItem["priority"];
  updatedAt: string;
  source: WorkItem["source"];
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
  type: z.enum(["feature", "bugfix", "refactor", "test", "docs", "chore"]).optional(),
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
      "retrying",
      "parked",
      "blocked",
      "cancelled",
      "escalated",
      "superseded",
      "verified",
      "partial",
    ])
    .optional(),
  dependencies: z.array(z.string()).optional(),
  handoff: z
    .object({
      content: z.string(),
      branch: z.string(),
      budget: z.number(),
      budgetSource: z.enum(["learned", "partial", "default", "manual"]).optional(),
      budgetSampleSize: z.number().optional(),
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
      actualCost: z.number().optional(),
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
  failureCategory: z.enum(["transient", "execution", "structural", "unknown"]).optional(),
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
  handoffDir: z.string().default("handoffs/awaiting_handoff/"),
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
  retry?: boolean;
  retryCount?: number;
  createdAt: string;
}

// --- ATC ---

export interface ATCEvent {
  id: string;
  timestamp: string;
  type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup" | "project_trigger" | "project_completion" | "work_item_reconciled" | "escalation" | "escalation_timeout" | "escalation_resolved" | "dependency_block" | "auto_cancel" | "project_retry" | "dep_resolved" | "ci_code_retry_triggered" | "ci_code_retry_exhausted";
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

// ---------------------------------------------------------------------------
// HLO (Handoff Lifecycle Orchestrator) Types
// ---------------------------------------------------------------------------

export interface HLOLifecycleState {
  branch: string;
  prNumber: number;
  currentState: 'spec-review' | 'executing' | 'ci-wait' | 'code-review' | 'approved' | 'merged' | 'failed';
  stateEnteredAt: string; // ISO timestamp
  retryCount: number;
  lastTransition: string;
}

export interface PRSLAConfig {
  alertThresholdMs: number;       // default 2h
  remediationThresholdMs: number; // default 4h
  hardCloseThresholdMs: number;   // default 24h
  rebaseCommitThreshold: number;  // default 5
}

export interface SupersededInfo {
  supersededBy: number;
  reason: string;
  closedAt: string;
}

export const DEFAULT_PR_SLA_CONFIG: PRSLAConfig = {
  alertThresholdMs: 2 * 60 * 60 * 1000,       // 2 hours
  remediationThresholdMs: 4 * 60 * 60 * 1000, // 4 hours
  hardCloseThresholdMs: 24 * 60 * 60 * 1000,  // 24 hours
  rebaseCommitThreshold: 5,
};

// --- Evaluation Metric Types ---

export interface PlanQualityMetric {
  /** Score from 0 to 1 representing how complete the plan is */
  completeness: number;
  /** Whether steps are in a logical order */
  logicalOrdering: boolean;
  /** Score from 0 to 1 representing accuracy of dependency declarations */
  dependencyAccuracy: number;
  /** Items that should have been included but were not */
  missingItems: string[];
  /** Items that were included but should not have been */
  unnecessaryItems: string[];
}

export interface StepEfficiencyMetric {
  /** Total number of steps in the plan */
  totalSteps: number;
  /** Number of steps deemed unnecessary */
  unnecessarySteps: number;
  /** Ratio from 0 to 1: (totalSteps - unnecessarySteps) / totalSteps */
  efficiency: number;
  /** IDs of steps identified as redundant */
  redundantStepIds: string[];
}

export interface ToolCorrectnessMetric {
  /** Number of tool selections that were correct */
  correctSelections: number;
  /** Number of tool selections that were incorrect */
  incorrectSelections: number;
  /** Ratio from 0 to 1: correctSelections / (correctSelections + incorrectSelections) */
  accuracy: number;
  /** Details of each incorrect tool selection */
  misselections: {
    expected: string;
    actual: string;
    stepId: string;
  }[];
}

export interface ReasoningQualityAssessment {
  planQuality: PlanQualityMetric;
  stepEfficiency: StepEfficiencyMetric;
  toolCorrectness: ToolCorrectnessMetric;
  /** Overall combined score from 0 to 1 */
  overallScore: number;
  /** ISO 8601 timestamp of when this assessment was made */
  assessedAt: string;
}

export type AgentComponent =
  | 'decomposer'
  | 'orchestrator'
  | 'spec-reviewer'
  | 'executor'
  | 'code-reviewer'
  | 'qa-agent'
  | 'ci';

export interface ComponentAttribution {
  /** The agent component attributed to this result */
  component: AgentComponent;
  /** Confidence score from 0 to 1 */
  confidence: number;
  /** Evidence supporting this attribution */
  evidence: string;
  /** Description of the failure mode, if applicable */
  failureMode: string;
}

export interface CostEntry {
  /** ID of the work item this cost is associated with */
  workItemId: string;
  /** Type of agent that incurred this cost */
  agentType: string;
  /** Target repository */
  repo: string;
  /** Number of input tokens consumed */
  inputTokens: number;
  /** Number of output tokens produced */
  outputTokens: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** ISO 8601 timestamp */
  timestamp: string;
}

// --- Cost Analytics (for /cost dashboard) ---

export interface CostAnalytics {
  summary: {
    todaySpend: number;
    weekSpend: number;
    monthSpend: number;
    allTimeSpend: number;
    dailyBurnRate: number;
    monthProjection: number;
    wastePct: number;
    wasteSpend: number;
    costPerMerge: number;
    itemsWithActualCost: number;
    totalExecutedItems: number;
  };
  dailySpend: Array<{
    date: string;
    total: number;
    byRepo: Record<string, number>;
    itemCount: number;
  }>;
  budgetAccuracy: {
    items: Array<{
      id: string;
      title: string;
      budget: number;
      actual: number;
      delta: number;
      deltaPct: number;
      outcome: string | null;
    }>;
    avgOverrunPct: number;
    overBudgetCount: number;
    underBudgetCount: number;
  };
  byRepo: Array<{
    repo: string;
    totalSpend: number;
    itemCount: number;
    mergedCount: number;
    failedCount: number;
    successRate: number;
    costPerMerge: number;
    wasteSpend: number;
  }>;
  byAgent: Record<string, number>;
  byComplexity: Array<{
    complexity: string;
    avgBudget: number;
    avgActual: number;
    itemCount: number;
    currentEstimate?: number;
    estimateSampleSize?: number;
    estimateConfidence?: "learned" | "partial" | "default";
  }>;
  recentItems: Array<{
    id: string;
    title: string;
    targetRepo: string;
    complexity: string;
    budget: number;
    actualCost: number | null;
    status: string;
    outcome: string | null;
    completedAt: string | null;
  }>;
}

export interface DriftSnapshot {
  date: string;                                    // ISO date string YYYY-MM-DD
  baselinePeriodDays: number;                      // e.g., 30 (days 30-60 ago)
  currentPeriodDays: number;                       // e.g., 30 (last 30 days)
  baselineDistribution: Record<string, number>;    // outcome -> percentage
  currentDistribution: Record<string, number>;     // outcome -> percentage
  driftScore: number;                              // Jensen-Shannon divergence [0, 1]
  degraded: boolean;                               // true if driftScore > threshold
  threshold: number;                               // threshold used
  baselineCount: number;                           // number of items in baseline period
  currentCount: number;                            // number of items in current period
}

// --- Sub-phase decomposition types ---

export interface SubPhase {
  id: string;
  parentProjectId: string;
  name: string;
  items: WorkItem[];
  dependencies: string[]; // cross-phase dependency IDs
  budget?: number; // optional proportional budget allocation
}

export interface DecomposerConfig {
  softLimit: number;
  hardLimit: number;
  maxRecursionDepth: number;
}

// --- Debate Stats ---

export interface DebateStats {
  totalSessions: number;
  avgRounds: number;
  avgTokens: number;
  verdictDistribution: Record<string, number>;
}

export type PhaseBreakdown = {
  phases: {
    id: string;
    name: string;
    itemCount: number;
    items: {
      title: string;
      priority: string;
    }[];
  }[];
  crossPhaseDeps: {
    from: string;
    to: string;
  }[];
};
