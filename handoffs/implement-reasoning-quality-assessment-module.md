# Agent Forge -- Implement Reasoning Quality Assessment Module

## Metadata
- **Branch:** `feat/reasoning-metrics`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/reasoning-metrics.ts

## Context

Agent Forge is a dev orchestration platform. This task creates a new module `lib/reasoning-metrics.ts` that provides deterministic/heuristic functions for assessing the quality of AI-generated work. These metrics will be consumed by the Outcome Tracker to evaluate completed work items.

The module must export four functions:
1. `assessPlanQuality` — evaluates how well work items cover a project plan
2. `assessStepEfficiency` — evaluates handoff markdown for redundant or no-op steps
3. `assessToolCorrectness` — compares tools/files declared in handoff vs actually used
4. `computeReasoningQuality` — combines the three metrics into a weighted overall score

**No LLM calls.** All functions are pure, deterministic, rule-based parsers.

Relevant existing patterns from the repo:
- Types live in `lib/types.ts` — check existing `WorkItem` interface before defining types
- The evaluation types module already exists at `lib/evaluation/types.ts` — reference it if it defines relevant interfaces
- New lib files follow TypeScript strict mode (see `tsconfig.json`)
- Recent PRs added `lib/cost-tracking.ts`, `lib/plan-cache/types.ts`, `lib/evaluation/types.ts` — follow those patterns

## Requirements

1. `lib/reasoning-metrics.ts` must be created and export all four functions: `assessPlanQuality`, `assessStepEfficiency`, `assessToolCorrectness`, `computeReasoningQuality`
2. The file must define and export the return types: `PlanQualityMetric`, `StepEfficiencyMetric`, `ToolCorrectnessMetric`, `ReasoningQualityAssessment`
3. `assessPlanQuality(workItems, projectPlan?)` must evaluate:
   - `completeness`: ratio of plan sections covered by work items (1.0 if all covered, or if no plan provided)
   - `logicalOrdering`: whether the dependency DAG among work items is topologically sound (no cycles)
   - `dependencyAccuracy`: ratio of declared dependencies that have actual file overlaps (or 1.0 if no deps declared)
4. `assessStepEfficiency(handoffContent)` must:
   - Parse markdown to count numbered steps (lines matching `/^\s*###\s+Step\s+\d+/i` or `/^\d+\.\s/`)
   - Identify validation-only/no-op duplicate steps
   - Return `totalSteps`, `redundantSteps`, `efficiencyRatio` (1 - redundant/total, or 1.0 if 0 steps)
5. `assessToolCorrectness(executionLog, handoffContent)` must:
   - Extract file/tool references from handoff (lines with backtick paths or `###` file headers)
   - Extract file/tool references from execution log
   - Return `declaredTools`, `usedTools`, `misselectedTools` (declared but not used), `correctnessRatio`
6. `computeReasoningQuality(plan, efficiency, toolCorrectness)` must:
   - Return an `overallScore` between 0 and 1 computed as: `plan.completeness * 0.4 + efficiency.efficiencyRatio * 0.3 + toolCorrectness.correctnessRatio * 0.3`
   - Include `breakdown` with individual scores and weights
   - Include `assessment` string: "excellent" (≥0.85), "good" (≥0.70), "fair" (≥0.50), or "poor" (<0.50)
7. `assessPlanQuality` must return `completeness: 1.0` when no `projectPlan` is provided
8. `assessPlanQuality` must return `completeness: 1.0` when all plan section keywords appear in work item titles/descriptions
9. Project must build successfully with `npm run build` and typecheck with `npx tsc --noEmit`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/reasoning-metrics
```

### Step 1: Inspect existing types

Read these files to understand existing interfaces before writing anything:

```bash
cat lib/types.ts
cat lib/evaluation/types.ts 2>/dev/null || echo "not found"
```

Note the `WorkItem` interface fields — particularly `title`, `description`, `dependencies` (if present), and any file-related fields.

### Step 2: Create `lib/reasoning-metrics.ts`

Create the file with the following structure. Adjust `WorkItem` import path and field names based on what you found in Step 1.

```typescript
/**
 * lib/reasoning-metrics.ts
 *
 * Deterministic/heuristic functions for assessing reasoning quality
 * of AI-generated work items and handoff files.
 * No LLM calls — pure rule-based parsing.
 */

import { WorkItem } from "./types";

// ─── Return Types ────────────────────────────────────────────────────────────

export interface PlanQualityMetric {
  /** Ratio of plan sections covered by work items (0–1). 1.0 if no plan provided. */
  completeness: number;
  /** True if dependency DAG has no cycles (topologically sound). */
  logicalOrdering: boolean;
  /** Ratio of declared dependencies that have actual file overlaps (0–1). 1.0 if no deps. */
  dependencyAccuracy: number;
}

export interface StepEfficiencyMetric {
  /** Total numbered steps parsed from handoff markdown. */
  totalSteps: number;
  /** Steps identified as pure validation-only duplicates or no-ops. */
  redundantSteps: number;
  /** 1 - (redundantSteps / totalSteps), or 1.0 if totalSteps === 0. */
  efficiencyRatio: number;
}

export interface ToolCorrectnessMetric {
  /** File/tool references declared in the handoff. */
  declaredTools: string[];
  /** File/tool references found in the execution log. */
  usedTools: string[];
  /** Declared tools that do not appear in the execution log. */
  misselectedTools: string[];
  /** (usedTools ∩ declaredTools).length / declaredTools.length, or 1.0 if none declared. */
  correctnessRatio: number;
}

export interface ReasoningQualityAssessment {
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
  // Build adjacency map: id → array of dependency ids
  const deps: Map<string, string[]> = new Map();
  for (const item of workItems) {
    const itemDeps: string[] = (item as any).dependencies ?? [];
    deps.set(item.id, itemDeps);
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
): PlanQualityMetric {
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
    (item) => Array.isArray((item as any).dependencies) && (item as any).dependencies.length > 0
  );
  if (itemsWithDeps.length > 0) {
    let accurate = 0;
    let total = 0;
    const idToItem = new Map(workItems.map((i) => [i.id, i]));
    for (const item of itemsWithDeps) {
      const declaredDeps: string[] = (item as any).dependencies;
      const itemFiles = extractFilePaths(
        `${(item as any).handoffContent ?? ""} ${item.description ?? ""} ${item.title ?? ""}`
      ).map(normalizePath);
      for (const depId of declaredDeps) {
        total++;
        const depItem = idToItem.get(depId);
        if (!depItem) continue;
        const depFiles = extractFilePaths(
          `${(depItem as any).handoffContent ?? ""} ${depItem.description ?? ""} ${depItem.title ?? ""}`
        ).map(normalizePath);
        // Overlap exists if any file in item also appears in dep
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
export function assessStepEfficiency(handoffContent: string): StepEfficiencyMetric {
  // Match ### Step N headings (primary) or numbered list items at start of line
  const stepHeadingRegex = /^###\s+Step\s+\d+[:\s].*/im;
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
): ToolCorrectnessMetric {
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
  plan: PlanQualityMetric,
  efficiency: StepEfficiencyMetric,
  toolCorrectness: ToolCorrectnessMetric
): ReasoningQualityAssessment {
  const planScore = plan.completeness;
  const efficiencyScore = efficiency.efficiencyRatio;
  const toolScore = toolCorrectness.correctnessRatio;

  const overallScore =
    planScore * 0.4 + efficiencyScore * 0.3 + toolScore * 0.3;

  const clampedScore = Math.min(1, Math.max(0, overallScore));

  let assessment: ReasoningQualityAssessment["assessment"];
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
```

### Step 3: Verify WorkItem type compatibility

After writing the file, inspect `lib/types.ts` to confirm the `WorkItem` interface. If the interface uses different field names (e.g., `name` instead of `title`, `deps` instead of `dependencies`), update `lib/reasoning-metrics.ts` accordingly.

```bash
grep -n "WorkItem\|interface\|type " lib/types.ts | head -40
```

If `WorkItem` is not exported from `lib/types.ts`, check for it in other files:
```bash
grep -rn "export.*WorkItem" lib/ --include="*.ts"
```

Update the import path in `lib/reasoning-metrics.ts` as needed.

### Step 4: TypeScript check and build

```bash
npx tsc --noEmit
```

If there are type errors:
- If `WorkItem` fields differ (e.g., no `title`, uses `name`): update field references in the helper functions
- If `(item as any).dependencies` causes issues: keep the cast or define a local type guard
- If `id` doesn't exist on `WorkItem`: adjust `isTopologicallySound` to use whatever the unique identifier field is

Then run the full build:
```bash
npm run build
```

Fix any remaining build errors before proceeding.

### Step 5: Spot-check logic manually (optional but recommended)

Run a quick Node.js sanity check to confirm key acceptance criteria:

```bash
node -e "
const { assessPlanQuality, assessStepEfficiency, computeReasoningQuality, assessToolCorrectness } = require('./lib/reasoning-metrics');

// AC: assessPlanQuality returns completeness=1.0 when no plan provided
const noplan = assessPlanQuality([{ id: '1', title: 'foo', description: '' }]);
console.assert(noplan.completeness === 1.0, 'completeness should be 1.0 with no plan');

// AC: assessStepEfficiency parses numbered steps
const handoff = '### Step 0: Setup\n### Step 1: Implement\n### Step 2: Verify tests\n';
const eff = assessStepEfficiency(handoff);
console.assert(eff.totalSteps >= 2, 'should count steps: got ' + eff.totalSteps);

// AC: computeReasoningQuality returns score between 0 and 1
const score = computeReasoningQuality(
  { completeness: 1.0, logicalOrdering: true, dependencyAccuracy: 1.0 },
  { totalSteps: 3, redundantSteps: 0, efficiencyRatio: 1.0 },
  { declaredTools: [], usedTools: [], misselectedTools: [], correctnessRatio: 1.0 }
);
console.assert(score.overallScore === 1.0, 'perfect score should be 1.0: got ' + score.overallScore);
console.assert(score.assessment === 'excellent', 'should be excellent: got ' + score.assessment);

console.log('All spot checks passed');
" 2>&1 || echo "Note: Node check may fail if ts-node not available; TypeScript check is sufficient"
```

If the Node.js check fails due to CommonJS/ESM issues, that's fine — the TypeScript check in Step 4 is the authoritative validation.

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Both must succeed with no errors.

### Step 7: Commit, push, open PR

```bash
git add lib/reasoning-metrics.ts
git commit -m "feat: implement reasoning quality assessment module

Add lib/reasoning-metrics.ts with four deterministic/heuristic functions:
- assessPlanQuality: evaluates completeness, logical ordering, dependency accuracy
- assessStepEfficiency: parses handoff markdown for redundant/no-op steps
- assessToolCorrectness: compares declared vs used tools/files
- computeReasoningQuality: weighted combination (40/30/30) into overall score

All functions are pure and make no LLM calls. Will be consumed by Outcome Tracker."

git push origin feat/reasoning-metrics

gh pr create \
  --title "feat: implement reasoning quality assessment module" \
  --body "## Summary

Adds \`lib/reasoning-metrics.ts\` with deterministic/heuristic functions for evaluating AI reasoning quality on completed work items. These will be called by the Outcome Tracker.

## Functions

- \`assessPlanQuality(workItems, projectPlan?)\` — checks completeness (plan section coverage), logical ordering (DAG cycle detection), and dependency accuracy (file overlap)
- \`assessStepEfficiency(handoffContent)\` — parses markdown steps, identifies redundant/no-op steps, computes efficiency ratio
- \`assessToolCorrectness(executionLog, handoffContent)\` — extracts file/tool references from both sources, identifies misselections
- \`computeReasoningQuality(plan, efficiency, toolCorrectness)\` — weighted average (40/30/30) with excellence tiers

## Notes

- No LLM calls — all pure rule-based parsing
- \`WorkItem.dependencies\` accessed via \`as any\` cast since it may not yet be in the base type
- All exported types (\`PlanQualityMetric\`, \`StepEfficiencyMetric\`, \`ToolCorrectnessMetric\`, \`ReasoningQualityAssessment\`) are defined in this file

## Acceptance Criteria

- [x] Exports all four functions
- [x] \`assessStepEfficiency\` correctly counts numbered steps
- [x] \`computeReasoningQuality\` returns 0–1 with correct 40/30/30 weighting
- [x] \`assessPlanQuality\` returns \`completeness: 1.0\` when no plan provided
- [x] \`npm run build\` succeeds"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/reasoning-metrics
FILES CHANGED: lib/reasoning-metrics.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g., WorkItem type incompatibility, build errors]
NEXT STEPS: [e.g., "Fix WorkItem field names: repo uses 'name' not 'title'"]
```

### Escalation

If blocked by an architectural decision (e.g., `WorkItem` type is incompatible in a non-trivial way, or `dependencies` field doesn't exist anywhere in the type system and adding it requires coordination):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-reasoning-quality-assessment-module",
    "reason": "WorkItem type in lib/types.ts is missing dependencies/title fields needed by reasoning-metrics.ts; requires type system decision before proceeding",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 3",
      "error": "Type incompatibility: WorkItem interface does not expose required fields",
      "filesChanged": ["lib/reasoning-metrics.ts"]
    }
  }'
```