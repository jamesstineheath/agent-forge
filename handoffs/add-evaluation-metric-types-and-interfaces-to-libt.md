# Agent Forge -- Add Evaluation Metric Types and Interfaces to lib/types.ts

## Metadata
- **Branch:** `feat/evaluation-metric-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams. The `lib/types.ts` file contains all shared TypeScript types for the control plane, including the `WorkItem` type that tracks work items through their lifecycle.

This task expands the evaluation model by adding new interfaces for tracking plan quality, step efficiency, tool correctness, reasoning quality, component attribution, cost, and drift. These types will be used by future evaluation and observability features. A recent merged PR (`feat: define evaluation metric types and interfaces`) already added a parallel `lib/evaluation/types.ts` — this task adds the canonical types directly into `lib/types.ts` and augments the existing `WorkItem` type.

The existing `WorkItem` type in `lib/types.ts` must gain an optional `reasoningMetrics?: ReasoningQualityAssessment` field without breaking any existing code.

## Requirements

1. `lib/types.ts` exports `PlanQualityMetric` interface with fields: `completeness` (number 0-1), `logicalOrdering` (boolean), `dependencyAccuracy` (number 0-1), `missingItems` (string[]), `unnecessaryItems` (string[])
2. `lib/types.ts` exports `StepEfficiencyMetric` interface with fields: `totalSteps` (number), `unnecessarySteps` (number), `efficiency` (number 0-1), `redundantStepIds` (string[])
3. `lib/types.ts` exports `ToolCorrectnessMetric` interface with fields: `correctSelections` (number), `incorrectSelections` (number), `accuracy` (number 0-1), `misselections` (array of `{expected: string, actual: string, stepId: string}`)
4. `lib/types.ts` exports `ReasoningQualityAssessment` interface combining `planQuality: PlanQualityMetric`, `stepEfficiency: StepEfficiencyMetric`, `toolCorrectness: ToolCorrectnessMetric`, `overallScore` (number 0-1), `assessedAt` (ISO string)
5. `lib/types.ts` exports `ComponentAttribution` interface with fields: `component` (union enum: `'decomposer' | 'orchestrator' | 'spec-reviewer' | 'executor' | 'code-reviewer' | 'qa-agent' | 'ci'`), `confidence` (number 0-1), `evidence` (string), `failureMode` (string)
6. `lib/types.ts` exports `CostEntry` interface with fields: `workItemId` (string), `agentType` (string), `repo` (string), `inputTokens` (number), `outputTokens` (number), `estimatedCostUsd` (number), `timestamp` (string)
7. `lib/types.ts` exports `DriftSnapshot` interface with fields: `period` (string), `outcomeDistribution` (Record<string, number>), `baselineDistribution` (Record<string, number>), `driftScore` (number), `degraded` (boolean), `snapshotAt` (string)
8. The existing `WorkItem` type gains an optional `reasoningMetrics?: ReasoningQualityAssessment` field
9. `npm run build` completes with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/evaluation-metric-types
```

### Step 1: Inspect existing lib/types.ts

Read the current contents of `lib/types.ts` to understand the existing structure, especially the `WorkItem` type definition:

```bash
cat lib/types.ts
```

Take note of:
- Where `WorkItem` is defined and its current fields
- The existing export pattern (named exports, etc.)
- Any existing evaluation-related types that might overlap with `lib/evaluation/types.ts`

Also check what was added in the recent parallel PR:
```bash
cat lib/evaluation/types.ts 2>/dev/null || echo "File not found"
```

### Step 2: Add new evaluation metric interfaces to lib/types.ts

Append the following new interfaces to `lib/types.ts`. Insert them **before** the final exports or at the end of the file — keep existing content intact.

Add these interfaces in order:

```typescript
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

export interface DriftSnapshot {
  /** Period label (e.g., "2024-W01") */
  period: string;
  /** Distribution of outcomes in this period */
  outcomeDistribution: Record<string, number>;
  /** Baseline distribution to compare against */
  baselineDistribution: Record<string, number>;
  /** Score indicating degree of drift (higher = more drift) */
  driftScore: number;
  /** Whether the system has degraded relative to baseline */
  degraded: boolean;
  /** ISO 8601 timestamp of when this snapshot was taken */
  snapshotAt: string;
}
```

### Step 3: Add reasoningMetrics field to WorkItem type

Locate the `WorkItem` interface/type in `lib/types.ts`. Add the optional field at the end of the type, before the closing brace:

```typescript
  reasoningMetrics?: ReasoningQualityAssessment;
```

For example, if `WorkItem` currently ends like:
```typescript
export interface WorkItem {
  // ... existing fields ...
  updatedAt: string;
}
```

It should become:
```typescript
export interface WorkItem {
  // ... existing fields ...
  updatedAt: string;
  reasoningMetrics?: ReasoningQualityAssessment;
}
```

**Important:** Do not remove or modify any existing fields on `WorkItem`. Only append the new optional field.

### Step 4: Verify the changes compile

```bash
npx tsc --noEmit
```

If there are any errors, fix them. Common issues to watch for:
- Duplicate type names if `lib/evaluation/types.ts` already exports similar types (rename if needed, or confirm they are different)
- Any circular dependency issues

### Step 5: Verify build succeeds

```bash
npm run build
```

Confirm the build completes with no TypeScript errors. Next.js build warnings about page size are acceptable; TypeScript errors are not.

### Step 6: Spot-check the exported types are accessible

Run a quick type check by verifying the exports are visible:

```bash
node -e "
const { execSync } = require('child_process');
// Quick check that types compile in a consumer context
const fs = require('fs');
const content = fs.readFileSync('lib/types.ts', 'utf8');
const required = [
  'PlanQualityMetric',
  'StepEfficiencyMetric', 
  'ToolCorrectnessMetric',
  'ReasoningQualityAssessment',
  'ComponentAttribution',
  'CostEntry',
  'DriftSnapshot',
  'reasoningMetrics'
];
const missing = required.filter(name => !content.includes(name));
if (missing.length > 0) {
  console.error('MISSING:', missing);
  process.exit(1);
} else {
  console.log('All required types present');
}
"
```

### Step 7: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: add evaluation metric types and interfaces to lib/types.ts

- Add PlanQualityMetric, StepEfficiencyMetric, ToolCorrectnessMetric interfaces
- Add ReasoningQualityAssessment combining all three metrics
- Add ComponentAttribution with AgentComponent enum type
- Add CostEntry and DriftSnapshot interfaces
- Extend WorkItem with optional reasoningMetrics field"

git push origin feat/evaluation-metric-types

gh pr create \
  --title "feat: add evaluation metric types and interfaces to lib/types.ts" \
  --body "## Summary

Adds core TypeScript types for the expanded evaluation model to \`lib/types.ts\`.

## New Types

- \`PlanQualityMetric\` — completeness, logicalOrdering, dependencyAccuracy, missingItems, unnecessaryItems
- \`StepEfficiencyMetric\` — totalSteps, unnecessarySteps, efficiency, redundantStepIds
- \`ToolCorrectnessMetric\` — correctSelections, incorrectSelections, accuracy, misselections
- \`ReasoningQualityAssessment\` — combines all three metrics with overallScore and assessedAt
- \`AgentComponent\` — union type for the 7 agent components
- \`ComponentAttribution\` — component, confidence, evidence, failureMode
- \`CostEntry\` — workItemId, agentType, repo, inputTokens, outputTokens, estimatedCostUsd, timestamp
- \`DriftSnapshot\` — period, outcomeDistribution, baselineDistribution, driftScore, degraded, snapshotAt

## WorkItem Changes

Added optional \`reasoningMetrics?: ReasoningQualityAssessment\` field to existing \`WorkItem\` type.

## Acceptance Criteria

- [x] All 7 new interfaces exported from lib/types.ts
- [x] ComponentAttribution includes all 7 component enum values
- [x] WorkItem has optional reasoningMetrics field
- [x] \`npm run build\` passes with no type errors"
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
FILES CHANGED: [lib/types.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker you cannot resolve (e.g., conflicting type names from `lib/evaluation/types.ts`, unexpected `WorkItem` structure, or build failures after 3 attempts), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-evaluation-metric-types-lib-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```