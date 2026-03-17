# Agent Forge -- Add HLO State Types and 'superseded' Status to types.ts

## Metadata
- **Branch:** `feat/hlo-state-types-superseded`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

This task extends `lib/types.ts` in the Agent Forge control plane with new TypeScript types needed for the Handoff Lifecycle Orchestrator (HLO) feature. The HLO embeds lifecycle state as JSON in PR comments to track where a work item is in the execution pipeline. These types are foundational for downstream HLO implementation work.

The existing `lib/types.ts` already contains `WorkItem` with a status/outcome union type that includes `'merged' | 'failed' | 'parked' | 'cancelled'` — we need to add `'superseded'` to that union. All new interfaces and constants should be exported.

## Requirements

1. Add `HLOLifecycleState` interface with fields: `branch`, `prNumber`, `currentState`, `stateEnteredAt`, `retryCount`, `lastTransition`
2. Add `PRSLAConfig` interface with fields: `alertThresholdMs`, `remediationThresholdMs`, `hardCloseThresholdMs`, `rebaseCommitThreshold`
3. Add `'superseded'` to the WorkItem status/outcome union type (alongside `'merged'`, `'failed'`, `'parked'`, `'cancelled'`)
4. Add `SupersededInfo` interface with fields: `supersededBy`, `reason`, `closedAt`
5. Export `DEFAULT_PR_SLA_CONFIG` const with values: `alertThresholdMs: 2 * 60 * 60 * 1000`, `remediationThresholdMs: 4 * 60 * 60 * 1000`, `hardCloseThresholdMs: 24 * 60 * 60 * 1000`, `rebaseCommitThreshold: 5`
6. Project builds successfully with `npm run build` (no type errors)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/hlo-state-types-superseded
```

### Step 1: Inspect existing types.ts

Read the full contents of `lib/types.ts` to understand the current structure before making changes:

```bash
cat lib/types.ts
```

Look for:
- The `WorkItem` interface definition
- The status/outcome union type (likely something like `status: 'filed' | 'ready' | 'queued' | ... | 'merged' | 'failed' | 'parked' | 'cancelled'`)
- Where to best insert the new interfaces (end of file, or grouped with related types)

### Step 2: Add new types and extend WorkItem

Edit `lib/types.ts` to:

1. Add `'superseded'` to the existing WorkItem status/outcome union. Find the union that contains `'merged'` and `'failed'` and `'parked'` and `'cancelled'` — add `| 'superseded'` to it.

2. Append the following new exports to the end of the file (or insert them in a logical location near other types):

```typescript
// HLO (Handoff Lifecycle Orchestrator) types

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
```

### Step 3: Verification

```bash
npx tsc --noEmit
npm run build
```

If there are type errors related to the `'superseded'` addition (e.g., exhaustive switch statements elsewhere in the codebase that don't handle it), locate those files and add a `'superseded'` case. For switch statements, a `case 'superseded': return ...` that mirrors the `'cancelled'` or `'failed'` handling is appropriate.

If any other file imports from `lib/types.ts` and breaks, fix the import or add the missing case.

### Step 4: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add HLO state types and 'superseded' status to types.ts"
git push origin feat/hlo-state-types-superseded
gh pr create \
  --title "feat: add HLO state types and 'superseded' status to types.ts" \
  --body "## Summary

Adds TypeScript types for the Handoff Lifecycle Orchestrator (HLO) and extends WorkItem with a new terminal status.

## Changes

- **\`HLOLifecycleState\`**: Interface representing the JSON state the HLO embeds in PR comments (branch, prNumber, currentState, stateEnteredAt, retryCount, lastTransition)
- **\`PRSLAConfig\`**: Interface for configurable SLA thresholds (alert/remediation/hardClose/rebaseCommit)
- **\`SupersededInfo\`**: Interface for tracking which PR superseded a work item
- **\`DEFAULT_PR_SLA_CONFIG\`**: Exported const with default values (2h alert, 4h remediation, 24h hard close, 5 commits)
- **WorkItem status union**: Added \`'superseded'\` terminal status alongside merged/failed/parked/cancelled

## Testing

- \`npx tsc --noEmit\` passes
- \`npm run build\` passes

## Risk

Low — additive type-only changes. The new union member \`'superseded'\` is non-breaking for existing switch statements as TypeScript will only error if they are exhaustive with \`never\` checks."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/hlo-state-types-superseded
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter an unresolvable blocker (e.g., the existing union type structure is significantly different from expected, or adding `'superseded'` causes cascading exhaustiveness errors across many files that require architectural judgment):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-hlo-state-types-superseded",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```