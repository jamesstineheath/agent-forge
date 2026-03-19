# Agent Forge -- Add shared types for model routing (TaskType, WorkItemSignals)

## Metadata
- **Branch:** `feat/add-model-routing-shared-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams. The codebase is adding a model routing system that intelligently selects Claude models based on task type and signals from work items. Before the router, policy, events, and analytics modules can be built, the foundational type definitions must exist in `lib/types.ts`.

This task adds five new exported types to `lib/types.ts`:
- `TaskType` — a union type enumerating all pipeline task categories
- `WorkItemSignals` — a structured interface capturing signals extracted from work items for routing decisions
- `ModelRoutingAnalytics` — a dashboard-facing type for cost/quality metrics per model
- `CostBaseline` — captures a cost baseline snapshot for comparison
- `CostComparison` — captures a before/after cost comparison result

`lib/types.ts` already contains the core shared types for the project (e.g., `WorkItem`, `Project`). This change appends new type exports — no existing types are modified.

**Concurrent work to avoid:** The branch `feat/create-tlm-memory-migration-script-and-compatibili` touches `app/api/agents/tlm-memory/route.ts`, `lib/episode-compat.ts`, `lib/episode-recorder.ts`, and `scripts/migrate-tlm-memory.ts`. It does NOT touch `lib/types.ts`, so there is no file conflict.

## Requirements

1. `TaskType` is exported from `lib/types.ts` as a string literal union type containing exactly these 10 values: `'handoff_generation'`, `'decomposition'`, `'backlog_review'`, `'health_assessment'`, `'code_review'`, `'spec_review'`, `'outcome_tracking'`, `'feedback_compilation'`, `'dispatch'`, `'conflict_detection'`
2. `WorkItemSignals` is exported from `lib/types.ts` as an interface with fields: `criteriaCount: number`, `repoCount: number`, `workItemType: string`, `complexity: 'simple' | 'moderate' | 'complex'`, and optional `fileCount?: number`
3. `ModelRoutingAnalytics` is exported from `lib/types.ts` as an interface with sub-fields for per-model costs, daily spend, quality scores, and escalation rates
4. `CostBaseline` is exported from `lib/types.ts` as an interface with fields: `baselineCostPerSuccess: number`, `recordedAt: string`, `totalItems: number`, `totalCost: number`
5. `CostComparison` is exported from `lib/types.ts` as an interface with fields: `baselineCostPerSuccess: number`, `currentCostPerSuccess: number`, `costReduction: number`, `baselineSuccessRate: number`, `currentSuccessRate: number`, `periodStart: string`, `periodEnd: string`
6. Project compiles successfully with `npx tsc --noEmit` and `npm run build` with no type errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-model-routing-shared-types
```

### Step 1: Inspect existing lib/types.ts

Read the current contents of `lib/types.ts` to understand the existing structure and find the best location to append the new types:

```bash
cat lib/types.ts
```

Note the existing exports so the new types can be appended cleanly at the end of the file without disrupting any existing definitions.

### Step 2: Append new type definitions to lib/types.ts

Add the following block to the **end** of `lib/types.ts`. Do not modify any existing types — append only.

```typescript
// ---------------------------------------------------------------------------
// Model Routing Types
// ---------------------------------------------------------------------------

/**
 * All pipeline task types that can be routed to a specific Claude model.
 */
export type TaskType =
  | 'handoff_generation'
  | 'decomposition'
  | 'backlog_review'
  | 'health_assessment'
  | 'code_review'
  | 'spec_review'
  | 'outcome_tracking'
  | 'feedback_compilation'
  | 'dispatch'
  | 'conflict_detection';

/**
 * Structured signals extracted from a work item to inform model routing decisions.
 */
export interface WorkItemSignals {
  /** Number of acceptance criteria on the work item. */
  criteriaCount: number;
  /** Number of target repositories involved. */
  repoCount: number;
  /** The category/type label of the work item (e.g. "feature", "fix"). */
  workItemType: string;
  /** Estimated complexity of the work item. */
  complexity: 'simple' | 'moderate' | 'complex';
  /** Optional: number of files estimated to be changed. */
  fileCount?: number;
}

/**
 * Per-model cost and quality analytics for the dashboard.
 */
export interface ModelRoutingAnalytics {
  /** Aggregated cost broken down by model identifier. */
  perModelCosts: Record<string, number>;
  /** Total spend per calendar day (ISO date string → cost in USD). */
  dailySpend: Record<string, number>;
  /** Quality scores per model (model identifier → 0–1 score). */
  qualityScores: Record<string, number>;
  /** Escalation rates per model (model identifier → 0–1 rate). */
  escalationRates: Record<string, number>;
}

/**
 * A cost baseline snapshot recorded at a point in time for future comparisons.
 */
export interface CostBaseline {
  /** Average cost (USD) per successful work item at baseline. */
  baselineCostPerSuccess: number;
  /** ISO timestamp when this baseline was recorded. */
  recordedAt: string;
  /** Total number of work items included in the baseline calculation. */
  totalItems: number;
  /** Total cost (USD) across all items in the baseline period. */
  totalCost: number;
}

/**
 * A before/after cost comparison against a recorded baseline.
 */
export interface CostComparison {
  /** Average cost (USD) per successful item at baseline. */
  baselineCostPerSuccess: number;
  /** Average cost (USD) per successful item in the current period. */
  currentCostPerSuccess: number;
  /** Fractional cost reduction (positive = cheaper than baseline). */
  costReduction: number;
  /** Success rate (0–1) during the baseline period. */
  baselineSuccessRate: number;
  /** Success rate (0–1) during the current period. */
  currentSuccessRate: number;
  /** ISO timestamp for the start of the comparison period. */
  periodStart: string;
  /** ISO timestamp for the end of the comparison period. */
  periodEnd: string;
}
```

### Step 3: Verify the file looks correct

```bash
# Confirm new exports are present
grep -E "^export (type|interface) (TaskType|WorkItemSignals|ModelRoutingAnalytics|CostBaseline|CostComparison)" lib/types.ts
```

Expected output (5 lines, one per export):
```
export type TaskType =
export interface WorkItemSignals {
export interface ModelRoutingAnalytics {
export interface CostBaseline {
export interface CostComparison {
```

### Step 4: Verification

```bash
# Type-check only (fast)
npx tsc --noEmit

# Full build
npm run build
```

Both commands must complete with zero errors. If there are pre-existing build errors unrelated to this change, note them in the PR description but do not attempt to fix them.

### Step 5: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: add model routing shared types (TaskType, WorkItemSignals, analytics)"
git push origin feat/add-model-routing-shared-types
gh pr create \
  --title "feat: add model routing shared types (TaskType, WorkItemSignals, analytics)" \
  --body "## Summary

Adds foundational type definitions required by the model routing system.

### New exports in \`lib/types.ts\`

| Type | Kind | Purpose |
|------|------|---------|
| \`TaskType\` | union | Enumerates all 10 pipeline task types for model routing |
| \`WorkItemSignals\` | interface | Structured signals extracted from work items for routing decisions |
| \`ModelRoutingAnalytics\` | interface | Dashboard-facing cost/quality metrics per model |
| \`CostBaseline\` | interface | Cost baseline snapshot for comparison |
| \`CostComparison\` | interface | Before/after cost comparison against a baseline |

### Notes
- No existing types were modified — all changes are append-only additions.
- No conflict with concurrent branch \`feat/create-tlm-memory-migration-script-and-compatibili\` (different files).

### Acceptance Criteria
- [x] \`TaskType\` exported with 10 string literal members
- [x] \`WorkItemSignals\` exported with all required fields
- [x] \`ModelRoutingAnalytics\`, \`CostBaseline\`, \`CostComparison\` exported
- [x] \`npm run build\` passes with no type errors
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
   ```bash
   git add lib/types.ts
   git commit -m "feat: partial - add model routing shared types (wip)"
   git push origin feat/add-model-routing-shared-types
   ```
2. Open the PR with partial status:
   ```bash
   gh pr create --title "feat: add model routing shared types [WIP]" --body "Partial implementation — see ISSUES below."
   ```
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-model-routing-shared-types
FILES CHANGED: lib/types.ts
SUMMARY: Appended model routing type definitions to lib/types.ts
ISSUES: [describe what failed, e.g. tsc errors, unexpected existing conflicts]
NEXT STEPS: [e.g. resolve type error on line N, or re-check existing WorkItem definition for naming collision]
```

If you encounter an unresolvable blocker (ambiguous requirement, missing context, repeated build failures after 3 attempts), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-model-routing-shared-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```