import { listWorkItemsFull } from "./work-items";
import type { WorkItem } from "./types";
import { FAST_LANE_BUDGET_SIMPLE, FAST_LANE_BUDGET_MODERATE } from "./types";

// --- Types ---

export interface EstimationInput {
  complexity: "simple" | "moderate" | "complex";
  targetRepo: string;
  type?: string;
  riskLevel?: "low" | "medium" | "high";
}

export interface EstimationResult {
  estimatedBudget: number;
  confidence: "learned" | "partial" | "default";
  sampleSize: number;
  breakdown: string;
}

// --- Static defaults (fallback when no data) ---

const STATIC_DEFAULTS: Record<string, number> = {
  simple: FAST_LANE_BUDGET_SIMPLE,
  moderate: FAST_LANE_BUDGET_MODERATE,
  complex: 8,
};

const MIN_BUDGET = 1;
const MAX_BUDGET = 15;

// --- Cache ---

let cachedItems: WorkItem[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function getCompletedItems(): Promise<WorkItem[]> {
  const now = Date.now();
  if (cachedItems && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedItems;
  }
  const all = await listWorkItemsFull();
  cachedItems = all.filter(
    (item) => item.execution?.actualCost != null && item.handoff != null
  );
  cacheTimestamp = now;
  return cachedItems;
}

// --- Helpers ---

/** Extract type from handoff markdown (e.g., "- **Type:** feature" or "<!-- type: bugfix -->") */
export function parseHandoffType(content: string): string | undefined {
  // Pattern 1: markdown metadata
  const mdMatch = content.match(/\*\*Type:\*\*\s*(\w+)/i);
  if (mdMatch) return mdMatch[1].toLowerCase();
  // Pattern 2: HTML comment
  const commentMatch = content.match(/<!--\s*type:\s*(\w+)\s*-->/i);
  if (commentMatch) return commentMatch[1].toLowerCase();
  return undefined;
}

/** Count implementation steps in handoff content */
export function parseStepCount(content: string): number {
  const stepMatches = content.match(/^###?\s*Step\s+\d+/gim);
  return stepMatches?.length ?? 0;
}

/** Compute trimmed mean (drop top and bottom 10%) */
function trimmedMean(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length <= 4) {
    // Too few to trim — use regular mean
    return values.reduce((s, v) => s + v, 0) / values.length;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.1));
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  return trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
}

function getItemType(item: WorkItem): string | undefined {
  if (item.type) return item.type;
  if (item.handoff?.content) return parseHandoffType(item.handoff.content);
  return undefined;
}

function repoShortName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

// --- Core estimation ---

export async function estimateBudget(input: EstimationInput): Promise<EstimationResult> {
  const items = await getCompletedItems();
  const { complexity, targetRepo, type } = input;

  // Level 1: (complexity, repo, type) — most specific, need ≥5 items
  if (type) {
    const matched = items.filter(
      (i) =>
        i.complexity === complexity &&
        i.targetRepo === targetRepo &&
        getItemType(i) === type
    );
    if (matched.length >= 5) {
      const costs = matched.map((i) => i.execution!.actualCost!);
      const estimate = trimmedMean(costs);
      return {
        estimatedBudget: clampBudget(estimate),
        confidence: "learned",
        sampleSize: matched.length,
        breakdown: `${complexity} + ${repoShortName(targetRepo)} + ${type}: avg $${estimate.toFixed(2)} from ${matched.length} items`,
      };
    }
  }

  // Level 2: (complexity, repo) — need ≥3 items
  const repoMatched = items.filter(
    (i) => i.complexity === complexity && i.targetRepo === targetRepo
  );
  if (repoMatched.length >= 3) {
    const costs = repoMatched.map((i) => i.execution!.actualCost!);
    const estimate = trimmedMean(costs);
    return {
      estimatedBudget: clampBudget(estimate),
      confidence: "learned",
      sampleSize: repoMatched.length,
      breakdown: `${complexity} + ${repoShortName(targetRepo)}: avg $${estimate.toFixed(2)} from ${repoMatched.length} items`,
    };
  }

  // Level 3: (complexity) global — need ≥3 items
  const globalMatched = items.filter((i) => i.complexity === complexity);
  if (globalMatched.length >= 3) {
    const costs = globalMatched.map((i) => i.execution!.actualCost!);
    const estimate = trimmedMean(costs);
    return {
      estimatedBudget: clampBudget(estimate),
      confidence: "partial",
      sampleSize: globalMatched.length,
      breakdown: `${complexity} global: avg $${estimate.toFixed(2)} from ${globalMatched.length} items`,
    };
  }

  // Level 4: static defaults
  const fallback = STATIC_DEFAULTS[complexity] ?? FAST_LANE_BUDGET_MODERATE;
  return {
    estimatedBudget: fallback,
    confidence: "default",
    sampleSize: 0,
    breakdown: `static default for ${complexity}: $${fallback}`,
  };
}

function clampBudget(value: number): number {
  // Round to 2 decimal places, clamp to sane range
  return Math.round(Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, value)) * 100) / 100;
}

/** Invalidate cache (e.g., after a new cost is recorded) */
export function invalidateEstimatorCache(): void {
  cachedItems = null;
  cacheTimestamp = 0;
}
