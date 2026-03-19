<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Wire failure attribution into Health Monitor agent

## Metadata
- **Branch:** `feat/health-monitor-failure-attribution`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/health-monitor.ts, lib/types.ts

## Context

The component-level failure attribution module was built as part of PRJ-20 but was never integrated into the Health Monitor agent. The original integration target was the ATC monolith (`lib/atc.ts`), which was deprecated on 2026-03-18 (ADR-010) and replaced by 4 autonomous agents.

The attribution module already exists in the codebase. This task is purely integration work: wire the existing function into `lib/atc/health-monitor.ts` so that when the Health Monitor marks a work item as failed, it records which pipeline component caused the failure in the work item's `execution.failureContext` field.

Pipeline components that can be attributed: executor, code reviewer, CI, spec reviewer, etc.

The Health Monitor lives at `lib/atc/health-monitor.ts` and handles stall detection, merge conflict recovery, and failed item reconciliation. When it transitions items to `failed` state, it should also call the attribution module and persist the result.

## Requirements

1. Locate the attribution function in the codebase (search for it in `lib/` — it may be in `lib/attribution.ts`, `lib/failure-attribution.ts`, or similar)
2. Locate the `failureContext` field definition in `lib/types.ts` (look for `FailureContext`, `ExecutionFailureContext`, or similar on the `WorkItem` or `Execution` type)
3. In `lib/atc/health-monitor.ts`, identify every location where a work item is transitioned to `failed` status
4. At each failure transition point, call the attribution function with the relevant context (work item state, error message, stall reason, etc.)
5. Persist the attribution result into `execution.failureContext` on the work item before saving
6. Do not modify the attribution module itself — only add call sites in the Health Monitor
7. The change must compile with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/health-monitor-failure-attribution
```

### Step 1: Discover the attribution module

Search the codebase to find the attribution function and understand its signature:

```bash
# Find the attribution module
grep -r "attribution" lib/ --include="*.ts" -l
grep -r "failureContext" lib/ --include="*.ts" -l
grep -r "FailureContext" lib/ --include="*.ts" -l

# Find the function signature
grep -r "export function\|export const\|export async function" lib/ --include="*.ts" | grep -i "attrib"

# Inspect types
grep -A 20 "failureContext\|FailureContext" lib/types.ts
```

Read the full attribution module file to understand:
- The function name and export
- Its parameter signature (what inputs it needs)
- Its return type (what shape it returns)
- Any enums or constants for component names

### Step 2: Understand Health Monitor failure transitions

Read `lib/atc/health-monitor.ts` in full, then identify every location where a work item is set to `failed`:

```bash
grep -n "failed\|status.*fail\|fail.*status" lib/atc/health-monitor.ts
```

Common patterns to look for:
- `item.status = 'failed'`
- `updateWorkItem({ ...item, status: 'failed' })`
- Stall timeout transitions
- CI failure transitions
- Explicit failure state assignments

For each failure site, note:
- What caused the failure (stall? CI red? merge conflict unresolvable? spec review failure?)
- What contextual data is available (error messages, PR status, workflow run status)

### Step 3: Map failure causes to attribution components

Based on what you find in the attribution module's component enum/constants, map each Health Monitor failure site to the appropriate component. Typical mapping:

| Health Monitor failure reason | Attribution component |
|---|---|
| Stall in `executing` stage | `executor` |
| Stall in `reviewing` stage | `code_reviewer` |
| CI check failure | `ci` |
| Stall in `generating` (spec review) | `spec_reviewer` |
| Merge conflict unresolvable | `executor` or `ci` |

Use whatever component names/enum values the attribution module actually defines — do not invent new ones.

### Step 4: Wire attribution into Health Monitor

Import the attribution function at the top of `lib/atc/health-monitor.ts`:

```typescript
// Add import (adjust path and function name based on what you find in Step 1)
import { attributeFailure } from '../attribution';
// or wherever it lives
```

At each failure transition site identified in Step 2, call the attribution function and attach the result to the work item before saving. The pattern should look something like:

```typescript
// Before: just setting status to failed
const updatedItem = {
  ...item,
  status: 'failed' as const,
};
await updateWorkItem(updatedItem);

// After: attribute failure first, then persist
const failureContext = attributeFailure({
  workItem: item,
  reason: 'stall_timeout', // or whatever context is available
  component: 'executor',   // from attribution module's constants
  // ...other params the function requires
});

const updatedItem = {
  ...item,
  status: 'failed' as const,
  execution: {
    ...item.execution,
    failureContext,
  },
};
await updateWorkItem(updatedItem);
```

Adjust parameter names and structure to match the actual function signature you discovered in Step 1. If `execution` or `failureContext` is structured differently in `lib/types.ts`, follow that shape exactly.

### Step 5: Handle the case where execution may be undefined

The `execution` field on a work item may be undefined if the item never started executing. Guard accordingly:

```typescript
execution: item.execution
  ? { ...item.execution, failureContext }
  : { failureContext },
```

Only if the type allows this — check `lib/types.ts` first and follow whatever shape is required.

### Step 6: Verification

```bash
npx tsc --noEmit
```

Fix any TypeScript errors. Common issues:
- Wrong import path for attribution module
- Missing required fields in attribution function call
- Type mismatch on `failureContext` field

```bash
npm run build
```

If tests exist:
```bash
npm test -- --testPathPattern="health-monitor|attribution" 2>/dev/null || echo "No matching tests"
```

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: wire failure attribution into Health Monitor agent

Integrate the existing attribution module into lib/atc/health-monitor.ts.
When the Health Monitor transitions a work item to 'failed', it now calls
attributeFailure() and persists the result in execution.failureContext.

Covers all failure sites: stall timeouts, CI failures, unresolvable merge
conflicts. Attribution module itself is unchanged — integration only."

git push origin feat/health-monitor-failure-attribution

gh pr create \
  --title "feat: wire failure attribution into Health Monitor agent" \
  --body "## Summary

Integrates the existing component-level failure attribution module (built in PRJ-20) into the Health Monitor agent.

## Changes

- **\`lib/atc/health-monitor.ts\`**: Import attribution function; call it at each failure transition site; persist result in \`execution.failureContext\` before saving the work item.

## What was NOT changed

- Attribution module itself — no logic changes, integration only
- Work item types — \`failureContext\` field already existed
- Other agents (Dispatcher, Project Manager, Supervisor)

## Testing

- \`npx tsc --noEmit\` passes with no errors
- All failure sites in Health Monitor now populate \`failureContext\`

## Risk

Low — additive change. Failure attribution is best-effort metadata; if the attribution call itself throws, the failure transition should still complete (consider wrapping in try/catch if needed)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/health-monitor-failure-attribution
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was unclear]
NEXT STEPS: [what remains — e.g. "attribution function not found, needs manual search"]
```

## Escalation

If the attribution module cannot be located anywhere in the codebase, or if `failureContext` does not exist on the `WorkItem`/`Execution` type in `lib/types.ts`, escalate rather than inventing new types or functions:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "wire-failure-attribution-health-monitor",
    "reason": "Attribution module or failureContext type not found in codebase — PRJ-20 artifact may not have been merged. Cannot integrate without the source module.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "grep found no attribution module in lib/ and no failureContext field in lib/types.ts",
      "filesChanged": []
    }
  }'
```