import {
  pgTable,
  text,
  boolean,
  integer,
  real,
  timestamp,
  jsonb,
  json,
  index,
} from "drizzle-orm/pg-core";
import type { SpikeMetadata } from "../types";

/**
 * Work items table — replaces the Vercel Blob two-layer store.
 * JSONB columns for nested objects keep the schema flexible without
 * needing to normalize every field.
 */
export const workItems = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    targetRepo: text("target_repo").notNull(),
    status: text("status").notNull().default("filed"),
    priority: text("priority").notNull().default("medium"),
    riskLevel: text("risk_level").notNull().default("medium"),
    complexity: text("complexity").notNull().default("moderate"),
    type: text("type"),
    source: jsonb("source").notNull().$type<{
      type: "pa-improvement" | "github-issue" | "manual" | "project" | "direct" | "pm-agent" | "bug";
      sourceId?: string;
      sourceUrl?: string;
    }>(),
    dependencies: jsonb("dependencies").notNull().default([]).$type<string[]>(),
    triggeredBy: text("triggered_by"),
    complexityHint: text("complexity_hint"),
    expedite: boolean("expedite").default(false),
    triagePriority: text("triage_priority"),
    rank: integer("rank"),
    handoff: jsonb("handoff").$type<{
      content: string;
      branch: string;
      budget: number;
      budgetSource?: "learned" | "partial" | "default" | "manual";
      budgetSampleSize?: number;
      generatedAt: string;
    } | null>(),
    execution: jsonb("execution").$type<{
      workflowRunId?: number;
      prNumber?: number;
      prUrl?: string;
      startedAt?: string;
      completedAt?: string;
      outcome?: "merged" | "failed" | "parked" | "reverted";
      retryCount?: number;
      filesModified?: string[];
      actualCost?: number;
    } | null>(),
    retryBudget: integer("retry_budget"),
    blockedReason: text("blocked_reason"),
    escalation: jsonb("escalation").$type<{
      id: string;
      reason: string;
      blockedAt: string;
    } | null>(),
    failureCategory: text("failure_category"),
    attribution: jsonb("attribution").$type<Array<{
      component: string;
      confidence: number;
      evidence: string;
      failureMode: string;
    }> | null>(),
    reasoningMetrics: jsonb("reasoning_metrics").$type<{
      planQuality: { completeness: number; logicalOrdering: boolean; dependencyAccuracy: number; missingItems: string[]; unnecessaryItems: string[] };
      stepEfficiency: { totalSteps: number; unnecessarySteps: number; efficiency: number; redundantStepIds: string[] };
      toolCorrectness: { correctSelections: number; incorrectSelections: number; accuracy: number; misselections: { expected: string; actual: string; stepId: string }[] };
      overallScore: number;
      assessedAt: string;
    } | null>(),
    spikeMetadata: json("spike_metadata").$type<SpikeMetadata>(),
    waveNumber: integer("wave_number"),
    prdId: text("prd_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_work_items_status").on(table.status),
    index("idx_work_items_target_repo").on(table.targetRepo),
    index("idx_work_items_status_target_repo").on(table.status, table.targetRepo),
    index("idx_work_items_status_priority").on(table.status, table.priority),
  ]
);

export type WorkItemRow = typeof workItems.$inferSelect;
export type WorkItemInsert = typeof workItems.$inferInsert;

/**
 * Plans table — Pipeline v2: 1 PRD = 1 plan = 1 branch = 1 PR.
 * Replaces work item decomposition with direct PRD execution.
 */
export const plans = pgTable(
  "plans",
  {
    id: text("id").primaryKey(),
    prdId: text("prd_id").notNull(),
    prdTitle: text("prd_title").notNull(),
    targetRepo: text("target_repo").notNull(),
    branchName: text("branch_name").notNull(),
    status: text("status").notNull().default("ready"),
    // Statuses: ready, dispatching, executing, reviewing,
    // complete, failed, timed_out, budget_exceeded, needs_review
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    kgContext: jsonb("kg_context").$type<{
      affectedFiles: string[];
      systemMapSections: string;
      relevantADRs: Array<{ title: string; status: string; decision: string }>;
      entityCount: number;
    } | null>(),
    affectedFiles: jsonb("affected_files").$type<string[] | null>(),
    estimatedBudget: real("estimated_budget"),
    actualCost: real("actual_cost"),
    maxDurationMinutes: integer("max_duration_minutes").default(60),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorLog: text("error_log"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    workflowRunId: text("workflow_run_id"),
    retryCount: integer("retry_count").default(0),
    prdRank: integer("prd_rank"),
    progress: jsonb("progress").$type<{
      criteriaComplete: number;
      criteriaTotal: number;
      currentState: string;
      issues: string[];
      decisions: string[];
      commits: Array<{ sha: string; message: string; timestamp: string }>;
      lastUpdated: string;
    } | null>(),
    reviewFeedback: text("review_feedback"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_plans_status").on(table.status),
    index("idx_plans_target_repo").on(table.targetRepo),
    index("idx_plans_prd_id").on(table.prdId),
    index("idx_plans_status_target_repo").on(table.status, table.targetRepo),
  ]
);

export type PlanRow = typeof plans.$inferSelect;
export type PlanInsert = typeof plans.$inferInsert;
