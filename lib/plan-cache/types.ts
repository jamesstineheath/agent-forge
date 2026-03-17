// lib/plan-cache/types.ts

/**
 * A single parameterized step in a plan template.
 * Maps to a work item shape but with project-agnostic placeholders
 * (no concrete repo names, branch names, or PR numbers).
 */
export interface CachedStep {
  /** Stable ID for this step within the template */
  id: string;
  /** Human-readable title, may contain {{placeholder}} tokens */
  title: string;
  /** Detailed description of what this step accomplishes */
  description: string;
  /** Glob patterns for files typically created or modified in this step */
  filePatterns: string[];
  /** Estimated complexity: low | medium | high */
  complexity: 'low' | 'medium' | 'high';
  /** Testable acceptance criteria for this step */
  acceptanceCriteria: string[];
  /** Step IDs within this template that this step depends on */
  dependencyRefs: string[];
}

/**
 * Performance statistics for a plan template based on historical executions.
 */
export interface PlanTemplatePerformanceStats {
  /** Average execution time in milliseconds across all uses */
  avgExecutionTime: number;
  /** Fraction of uses that resulted in a merged PR (0.0–1.0) */
  successRate: number;
}

/**
 * A project-agnostic plan template derived from a successfully executed project.
 * Concrete identifiers (repo names, branch names, PR numbers) are stripped.
 */
export interface PlanTemplate {
  /** Unique identifier for this template (e.g., UUID or slug) */
  id: string;
  /** The Notion project ID this template was derived from */
  sourceProjectId: string;
  /** Lightweight references to the original work items (IDs only, for traceability) */
  sourceWorkItems: string[];
  /** The parameterized steps forming the plan, with dependency DAG via dependencyRefs */
  templateSteps: CachedStep[];
  /** Domain tags for similarity matching (e.g., ["auth", "nextjs", "api"]) */
  domainTags: string[];
  /** Overall complexity of this plan template */
  complexity: 'low' | 'medium' | 'high';
  /** Aggregate file patterns across all steps, for quick index-level matching */
  filePatterns: string[];
  /** ISO 8601 timestamp when this template was created */
  createdAt: string;
  /** ISO 8601 timestamp when this template was last used */
  lastUsedAt: string;
  /** Number of times this template has been used */
  usageCount: number;
  /** Aggregated performance data from historical uses */
  performanceStats: PlanTemplatePerformanceStats;
}

/**
 * Result of matching an incoming project description against a plan template.
 */
export interface PlanMatch {
  /** ID of the matched template */
  templateId: string;
  /** Similarity score between 0.0 and 1.0 */
  similarityScore: number;
  /** Human-readable feature names that contributed to the match */
  matchedFeatures: string[];
}

/**
 * A lightweight index entry for a plan template.
 * Stored in the index blob for fast lookup without loading full template blobs.
 */
export interface PlanCacheIndexEntry {
  id: string;
  domainTags: string[];
  complexity: 'low' | 'medium' | 'high';
  filePatterns: string[];
  stepCount: number;
  usageCount: number;
  successRate: number;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * The full plan cache index: an array of lightweight entries.
 * Stored at af-data/plan-cache/index.json.
 */
export type PlanCacheIndex = PlanCacheIndexEntry[];
