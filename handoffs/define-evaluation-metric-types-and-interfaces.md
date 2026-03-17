# Agent Forge -- Define Evaluation Metric Types and Interfaces

## Metadata
- **Branch:** `feat/evaluation-metric-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/evaluation/types.ts

## Context

Agent Forge is a dev orchestration platform built with Next.js. This task creates the foundational TypeScript type definitions for an expanded evaluation model. These types will support future features for tracking plan quality, step efficiency, tool correctness, failure attribution, metric drift, and cost tracking across the pipeline.

The evaluation model introduces a universal outcome taxonomy (Correct, Reversed, CausedIssues, Missed, Premature) and structures for aggregating metrics into a report. This is a pure type definition file — no runtime logic, no API changes, no UI changes. The risk is minimal.

The existing codebase uses TypeScript with standard interfaces and JSDoc comments. See `lib/types.ts` for existing type patterns.

## Requirements

1. Create `lib/evaluation/types.ts` with all required exports
2. Export `OutcomeCategory` as a union type with exactly five values: `'Correct' | 'Reversed' | 'CausedIssues' | 'Missed' | 'Premature'`
3. Export `ToolMismatch` interface as a sub-type for `ToolCorrectnessMetric`
4. Export `PlanQualityMetric` interface with fields: `completeness` (number 0-1), `logicalOrdering` (boolean), `missingItems` (string[]), `redundantItems` (string[])
5. Export `StepEfficiencyMetric` interface with fields: `totalSteps` (number), `unnecessarySteps` (number), `efficiency` (number 0-1), `unnecessaryStepDetails` (string[])
6. Export `ToolCorrectnessMetric` interface with fields: `correctTools` (number), `incorrectTools` (number), `accuracy` (number 0-1), `mismatches` (ToolMismatch[])
7. Export `ComponentAttribution` interface with fields: `workItemId` (string), `failureStage` (union of exactly six values: `'decomposition' | 'spec-review' | 'execution' | 'code-review' | 'qa' | 'ci'`), `agentType` (string), `rootCause` (string), `confidence` (number 0-1)
8. Export `DriftSnapshot` interface with fields: `period` (string), `outcomeDistribution` (Record<OutcomeCategory, number>), `baseline` (Record<OutcomeCategory, number>), `driftScore` (number), `degraded` (boolean)
9. Export `CostRecord` interface with fields: `workItemId` (string), `agentType` (string), `repo` (string), `inputTokens` (number), `outputTokens` (number), `totalCost` (number), `timestamp` (string)
10. Export `EvaluationReport` interface that aggregates all metric types
11. All interfaces must have JSDoc comments explaining their purpose
12. Project must compile with `npx tsc --noEmit`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/evaluation-metric-types
```

### Step 1: Create the evaluation directory and types file

Create the directory `lib/evaluation/` and the file `lib/evaluation/types.ts` with the following content:

```typescript
/**
 * Evaluation metric types for Agent Forge's expanded evaluation model.
 * These types support tracking plan quality, step efficiency, tool correctness,
 * failure attribution, metric drift, and cost across the pipeline.
 */

/**
 * Universal outcome taxonomy used across all evaluation components.
 * - Correct: The agent action achieved the intended result
 * - Reversed: The agent action produced the opposite of the intended result
 * - CausedIssues: The agent action introduced new problems
 * - Missed: A required action was not taken
 * - Premature: An action was taken before its preconditions were met
 */
export type OutcomeCategory =
  | 'Correct'
  | 'Reversed'
  | 'CausedIssues'
  | 'Missed'
  | 'Premature';

/**
 * Represents a mismatch between the expected and actual tool used in a pipeline step.
 */
export interface ToolMismatch {
  /** The step or context where the mismatch occurred */
  step: string;
  /** The tool that was expected to be used */
  expectedTool: string;
  /** The tool that was actually used */
  actualTool: string;
  /** Human-readable explanation of the impact of this mismatch */
  impact: string;
}

/**
 * Measures the quality of a decomposed plan, assessing whether the work items
 * generated from a project plan are complete, well-ordered, and free of redundancy.
 */
export interface PlanQualityMetric {
  /** Score from 0 to 1 indicating how completely the plan covers the required scope */
  completeness: number;
  /** Whether the work items are arranged in a logically correct dependency order */
  logicalOrdering: boolean;
  /** Descriptions of items or tasks that were missing from the generated plan */
  missingItems: string[];
  /** Descriptions of items or tasks that were duplicated or unnecessary in the plan */
  redundantItems: string[];
}

/**
 * Measures the efficiency of the steps taken during execution of a work item,
 * identifying unnecessary steps that added cost or latency without value.
 */
export interface StepEfficiencyMetric {
  /** Total number of steps taken during execution */
  totalSteps: number;
  /** Number of steps that were deemed unnecessary or redundant */
  unnecessarySteps: number;
  /** Ratio of necessary steps to total steps, from 0 to 1 */
  efficiency: number;
  /** Human-readable descriptions of each unnecessary step and why it was unnecessary */
  unnecessaryStepDetails: string[];
}

/**
 * Measures how accurately the correct tools (agents, workflows, APIs) were selected
 * and applied at each stage of pipeline execution.
 */
export interface ToolCorrectnessMetric {
  /** Number of tool selections that were correct */
  correctTools: number;
  /** Number of tool selections that were incorrect */
  incorrectTools: number;
  /** Ratio of correct tool selections to total selections, from 0 to 1 */
  accuracy: number;
  /** Detailed records of each tool mismatch that occurred */
  mismatches: ToolMismatch[];
}

/**
 * The pipeline stage at which a failure or attribution point occurred.
 */
export type FailureStage =
  | 'decomposition'
  | 'spec-review'
  | 'execution'
  | 'code-review'
  | 'qa'
  | 'ci';

/**
 * Attributes a failure or suboptimal outcome to a specific component and stage
 * in the pipeline, enabling root cause analysis across agent types and stages.
 */
export interface ComponentAttribution {
  /** The ID of the work item where this failure or attribution was observed */
  workItemId: string;
  /** The pipeline stage at which the failure occurred */
  failureStage: FailureStage;
  /** The type of agent responsible at this stage (e.g., 'TLM-spec-review', 'claude-code') */
  agentType: string;
  /** Human-readable description of the root cause of the failure */
  rootCause: string;
  /** Confidence score from 0 to 1 in this attribution assessment */
  confidence: number;
}

/**
 * A snapshot of outcome distribution at a point in time, used to detect
 * drift or regression in pipeline performance relative to a baseline period.
 */
export interface DriftSnapshot {
  /** Human-readable label for the time period this snapshot covers (e.g., '2024-W42') */
  period: string;
  /** Distribution of outcomes across the universal taxonomy for this period */
  outcomeDistribution: Record<OutcomeCategory, number>;
  /** Baseline distribution of outcomes to compare against */
  baseline: Record<OutcomeCategory, number>;
  /** Numeric score representing the magnitude of drift from baseline (higher = more drift) */
  driftScore: number;
  /** Whether the drift indicates a performance degradation (true = worse than baseline) */
  degraded: boolean;
}

/**
 * A record of token and cost usage for a single agent invocation within the pipeline,
 * enabling cost attribution and budget tracking per work item and agent type.
 */
export interface CostRecord {
  /** The ID of the work item this cost is attributed to */
  workItemId: string;
  /** The type of agent that incurred this cost (e.g., 'TLM-review', 'orchestrator') */
  agentType: string;
  /** The target repository where the agent ran */
  repo: string;
  /** Number of input tokens consumed */
  inputTokens: number;
  /** Number of output tokens produced */
  outputTokens: number;
  /** Total cost in USD for this invocation */
  totalCost: number;
  /** ISO 8601 timestamp of when this cost was incurred */
  timestamp: string;
}

/**
 * Aggregated evaluation report for a work item or project, combining all
 * metric types into a single structure for holistic quality assessment.
 */
export interface EvaluationReport {
  /** Unique identifier for this evaluation report */
  reportId: string;
  /** The work item or project ID this report covers */
  subjectId: string;
  /** Whether this report covers a single work item ('work-item') or a full project ('project') */
  subjectType: 'work-item' | 'project';
  /** ISO 8601 timestamp of when this report was generated */
  generatedAt: string;
  /** Plan quality metrics, if applicable (present for project-level reports) */
  planQuality?: PlanQualityMetric;
  /** Step efficiency metrics for execution */
  stepEfficiency?: StepEfficiencyMetric;
  /** Tool correctness metrics across all pipeline stages */
  toolCorrectness?: ToolCorrectnessMetric;
  /** Component attribution records for any failures or issues */
  attributions: ComponentAttribution[];
  /** Drift snapshot comparing this period against the baseline */
  driftSnapshot?: DriftSnapshot;
  /** Cost records for all agent invocations associated with this subject */
  costs: CostRecord[];
  /** Overall outcome category for this work item or project */
  overallOutcome?: OutcomeCategory;
}
```

### Step 2: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are any compilation errors, fix them before proceeding.

### Step 3: Verify the build passes

```bash
npm run build
```

### Step 4: Verify exports are correct

Quickly confirm all required exports exist in the file:

```bash
grep -E "^export (type|interface)" lib/evaluation/types.ts
```

Expected output should include lines for: `OutcomeCategory`, `ToolMismatch`, `PlanQualityMetric`, `StepEfficiencyMetric`, `ToolCorrectnessMetric`, `FailureStage`, `ComponentAttribution`, `DriftSnapshot`, `CostRecord`, `EvaluationReport`.

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add evaluation metric types and interfaces"
git push origin feat/evaluation-metric-types
gh pr create \
  --title "feat: define evaluation metric types and interfaces" \
  --body "## Summary

Adds \`lib/evaluation/types.ts\` with the core TypeScript type definitions for the expanded evaluation model.

## New Types

- \`OutcomeCategory\` — Universal outcome taxonomy (Correct, Reversed, CausedIssues, Missed, Premature)
- \`ToolMismatch\` — Sub-type for recording tool selection mismatches
- \`PlanQualityMetric\` — Completeness, ordering, and redundancy of decomposed plans
- \`StepEfficiencyMetric\` — Ratio of necessary to total execution steps
- \`ToolCorrectnessMetric\` — Accuracy of tool/agent selection across pipeline stages
- \`FailureStage\` — Union of 6 pipeline stages for attribution
- \`ComponentAttribution\` — Root cause attribution for failures to specific agents/stages
- \`DriftSnapshot\` — Outcome distribution drift detection vs. baseline
- \`CostRecord\` — Token and cost attribution per agent invocation
- \`EvaluationReport\` — Aggregated report combining all metric types

## Changes
- Added \`lib/evaluation/types.ts\` (new file)

## Verification
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- All interfaces have JSDoc comments
"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/evaluation-metric-types
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker you cannot resolve autonomously (e.g., `tsconfig.json` path aliases preventing the new directory from being recognized, conflicting type definitions in `lib/types.ts`, or build tooling issues), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "define-evaluation-metric-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/evaluation/types.ts"]
    }
  }'
```