import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

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
