/**
 * lib/reasoning-metrics.ts
 *
 * Deterministic/heuristic functions for assessing reasoning quality
 * of AI-generated work items and handoff files.
 * No LLM calls — pure rule-based parsing.
 */

import { WorkItem } from "./types";

// ─── Return Types ────────────────────────────────────────────────────────────

export interface PlanQualityResult {
  /** Ratio of plan sections covered by work items (0–1). 1.0 if no plan provided. */
  completeness: number;
  /** True if dependency DAG has no cycles (topologically sound). */
  logicalOrdering: boolean;
  /** Ratio of declared dependencies that have actual file overlaps (0–1). 1.0 if no deps. */
  dependencyAccuracy: number;
}

export interface StepEfficiencyResult {
  /** Total numbered steps parsed from handoff markdown. */
  totalSteps: number;
  /** Steps identified as pure validation-only duplicates or no-ops. */
  redundantSteps: number;
  /** 1 - (redundantSteps / totalSteps), or 1.0 if totalSteps === 0. */
  efficiencyRatio: number;
}

export interface ToolCorrectnessResult {
  /** File/tool references declared in the handoff. */
  declaredTools: string[];
  /** File/tool references found in the execution log. */
  usedTools: string[];
  /** Declared tools that do not appear in the execution log. */
  misselectedTools: string[];
  /** (usedTools ∩ declaredTools).length / declaredTools.length, or 1.0 if none declared. */
  correctnessRatio: number;
}

export interface ReasoningQualityResult {
  /** Weighted overall score: plan*0.4 + efficiency*0.3 + tools*0.3 */
  overallScore: number;
  /** Breakdown of individual metric scores and their weights. */
  breakdown: {
    planQuality: { score: number; weight: 0.4 };
    stepEfficiency: { score: number; weight: 0.3 };
    toolCorrectness: { score: number; weight: 0.3 };
  };
  /** Human-readable assessment: "excellent" | "good" | "fair" | "poor" */
  assessment: "excellent" | "good" | "fair" | "poor";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract section headings from a markdown plan string.
 * Returns lowercase keywords from ## and ### headings.
 */
function extractPlanSections(plan: string): string[] {
  const headingRegex = /^#{1,3}\s+(.+)$/gm;
  const sections: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(plan)) !== null) {
    sections.push(match[1].toLowerCase().trim());
  }
  return sections;
}

/**
 * Check if a work item's title or description contains any keyword from the section.
 */
function workItemCoversSection(items: WorkItem[], sectionKeyword: string): boolean {
  const words = sectionKeyword.split(/\s+/).filter((w) => w.length > 3);
  return items.some((item) => {
    const text = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
    return words.some((word) => text.includes(word));
  });
}

/**
 * Detect cycles in a dependency DAG using DFS.
 * Returns true if the DAG is cycle-free (topologically valid).
 */
function isTopologicallySound(workItems: WorkItem[]): boolean {
  const deps: Map<string, string[]> = new Map();
  for (const item of workItems) {
    deps.set(item.id, item.dependencies ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(id: string): boolean {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    for (const depId of deps.get(id) ?? []) {
      if (hasCycle(depId)) return true;
    }
    inStack.delete(id);
    return false;
  }

  for (const item of workItems) {
    if (hasCycle(item.id)) return false;
  }
  return true;
}

/**
 * Extract file paths referenced in text (backtick-wrapped paths containing `/` or `.`).
 */
function extractFilePaths(text: string): string[] {
  const backtickPaths = /`([^`]*[./][^`]*)`/g;
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = backtickPaths.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (candidate.length > 0) paths.add(candidate);
  }
  return Array.from(paths);
}

/**
 * Normalize a file path for comparison (lowercase, trim leading ./ and /).
 */
function normalizePath(p: string): string {
  return p.toLowerCase().replace(/^\.\//, "").replace(/^\//, "").trim();
}

/**
 * Identify redundant steps in parsed step list.
 * A step is considered redundant/no-op if:
 * - Its title (lowercased) matches known validation-only patterns
 * - It is a duplicate of a preceding step title
 */
const REDUNDANT_PATTERNS: RegExp[] = [
  /^(verify|confirm|check that|ensure|validate)\b/i,
  /\bno[- ]?op\b/i,
  /^(re-?verify|re-?check|re-?validate)\b/i,
];

function isRedundantStep(title: string, seen: Set<string>): boolean {
  const normalized = title.toLowerCase().trim();
  if (seen.has(normalized)) return true;
  return REDUNDANT_PATTERNS.some((re) => re.test(normalized));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate how well a set of work items covers a project plan.
 *
 * @param workItems - The work items decomposed from the project.
 * @param projectPlan - Optional raw markdown of the project plan.
 */
export function assessPlanQuality(
  workItems: WorkItem[],
  projectPlan?: string
): PlanQualityResult {
  // Completeness
  let completeness = 1.0;
  if (projectPlan && projectPlan.trim().length > 0) {
    const sections = extractPlanSections(projectPlan);
    if (sections.length > 0) {
      const covered = sections.filter((s) => workItemCoversSection(workItems, s)).length;
      completeness = covered / sections.length;
    }
  }

  // Logical ordering (no cycles in dependency DAG)
  const logicalOrdering = isTopologicallySound(workItems);

  // Dependency accuracy: for each declared dependency, check file overlaps
  let dependencyAccuracy = 1.0;
  const itemsWithDeps = workItems.filter(
    (item) => Array.isArray(item.dependencies) && item.dependencies.length > 0
  );
  if (itemsWithDeps.length > 0) {
    let accurate = 0;
    let total = 0;
    const idToItem = new Map(workItems.map((i) => [i.id, i]));
    for (const item of itemsWithDeps) {
      const itemFiles = extractFilePaths(
        `${item.handoff?.content ?? ""} ${item.description ?? ""} ${item.title ?? ""}`
      ).map(normalizePath);
      for (const depId of item.dependencies) {
        total++;
        const depItem = idToItem.get(depId);
        if (!depItem) continue;
        const depFiles = extractFilePaths(
          `${depItem.handoff?.content ?? ""} ${depItem.description ?? ""} ${depItem.title ?? ""}`
        ).map(normalizePath);
        const hasOverlap = itemFiles.some((f) => depFiles.includes(f));
        if (hasOverlap) accurate++;
      }
    }
    dependencyAccuracy = total > 0 ? accurate / total : 1.0;
  }

  return { completeness, logicalOrdering, dependencyAccuracy };
}

/**
 * Parse a handoff markdown string and assess step efficiency.
 *
 * @param handoffContent - Raw markdown content of a handoff file.
 */
export function assessStepEfficiency(handoffContent: string): StepEfficiencyResult {
  const lines = handoffContent.split("\n");

  const stepTitles: string[] = [];

  for (const line of lines) {
    // Match: ### Step 0: ... or ### Step 1 ...
    const headingMatch = line.match(/^###\s+Step\s+\d+[:\s]*(.*)/i);
    if (headingMatch) {
      stepTitles.push(headingMatch[1].trim() || line.trim());
      continue;
    }
    // Match: 1. Some step or 1) Some step at line start
    const numberedMatch = line.match(/^\d+[.)]\s+(.+)/);
    if (numberedMatch) {
      stepTitles.push(numberedMatch[1].trim());
    }
  }

  const totalSteps = stepTitles.length;
  if (totalSteps === 0) {
    return { totalSteps: 0, redundantSteps: 0, efficiencyRatio: 1.0 };
  }

  const seen = new Set<string>();
  let redundantSteps = 0;
  for (const title of stepTitles) {
    if (isRedundantStep(title, seen)) {
      redundantSteps++;
    } else {
      seen.add(title.toLowerCase().trim());
    }
  }

  const efficiencyRatio = 1 - redundantSteps / totalSteps;
  return { totalSteps, redundantSteps, efficiencyRatio };
}

/**
 * Compare tools/files declared in a handoff with what was actually used in execution.
 *
 * @param executionLog - Raw text of the execution log or PR body.
 * @param handoffContent - Raw markdown content of the handoff file.
 */
export function assessToolCorrectness(
  executionLog: string,
  handoffContent: string
): ToolCorrectnessResult {
  const rawDeclared = extractFilePaths(handoffContent);
  const rawUsed = extractFilePaths(executionLog);

  const declaredTools = rawDeclared.map(normalizePath);
  const usedTools = rawUsed.map(normalizePath);

  if (declaredTools.length === 0) {
    return {
      declaredTools: [],
      usedTools,
      misselectedTools: [],
      correctnessRatio: 1.0,
    };
  }

  const usedSet = new Set(usedTools);
  const misselectedTools = declaredTools.filter((t) => !usedSet.has(t));
  const correctCount = declaredTools.length - misselectedTools.length;
  const correctnessRatio = correctCount / declaredTools.length;

  return {
    declaredTools,
    usedTools,
    misselectedTools,
    correctnessRatio,
  };
}

/**
 * Combine plan quality, step efficiency, and tool correctness into an overall
 * reasoning quality score.
 *
 * Weighting: plan 40%, efficiency 30%, tools 30%
 */
export function computeReasoningQuality(
  plan: PlanQualityResult,
  efficiency: StepEfficiencyResult,
  toolCorrectness: ToolCorrectnessResult
): ReasoningQualityResult {
  const planScore = plan.completeness;
  const efficiencyScore = efficiency.efficiencyRatio;
  const toolScore = toolCorrectness.correctnessRatio;

  const overallScore =
    planScore * 0.4 + efficiencyScore * 0.3 + toolScore * 0.3;

  const clampedScore = Math.min(1, Math.max(0, overallScore));

  let assessment: ReasoningQualityResult["assessment"];
  if (clampedScore >= 0.85) assessment = "excellent";
  else if (clampedScore >= 0.70) assessment = "good";
  else if (clampedScore >= 0.50) assessment = "fair";
  else assessment = "poor";

  return {
    overallScore: clampedScore,
    breakdown: {
      planQuality: { score: planScore, weight: 0.4 },
      stepEfficiency: { score: efficiencyScore, weight: 0.3 },
      toolCorrectness: { score: toolScore, weight: 0.3 },
    },
    assessment,
  };
}
