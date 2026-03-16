# Agent Forge -- Update work-items.ts to handle 'direct' source items in dispatch logic

## Metadata
- **Branch:** `feat/direct-source-dispatch-logic`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/work-items.ts, lib/types.ts

## Context

Agent Forge manages work items that can originate from multiple sources: `project`, `manual`, `github`, and (newly added) `direct`. The `direct` source type was recently introduced (see merged PR: "feat: add 'direct' source type and 'triggeredBy' field to work item types") which added the type definitions and UI display for it.

However, `lib/work-items.ts` — specifically the dispatch logic (`getNextDispatchable()`) and item creation (`createWorkItem()`) — has not yet been updated to handle `direct`-source items correctly. Direct items:
- Have no parent project
- Have no dependencies
- Should be immediately dispatchable (bypass dependency graph checks)
- May carry `triggeredBy` and `complexityHint` fields
- Should have budget auto-assigned based on `complexityHint` when no explicit budget is provided

This task wires up `lib/work-items.ts` to fully support the `direct` source type in the dispatch pipeline, item creation persistence, budget defaulting, and escalation state transitions.

The escalation state machine was also recently wired (see PR: "feat: wire escalation API auth + pipeline agent integration"), so `escalated` is now a valid target status — but the transition guards in `work-items.ts` may not yet allow it from all necessary source states (`executing`, `reviewing`, `queued`).

## Requirements

1. `getNextDispatchable()` must return `direct`-source work items without checking for a parent project or resolved dependencies — they pass the dependency check unconditionally.
2. `createWorkItem()` must accept and persist `triggeredBy` and `complexityHint` fields to Vercel Blob.
3. When no explicit `budget` is provided and `complexityHint === 'simple'`, default budget to `2` (`FAST_LANE_BUDGET_SIMPLE`).
4. When no explicit `budget` is provided and `complexityHint === 'moderate'`, default budget to `4` (`FAST_LANE_BUDGET_MODERATE`).
5. Status transition to `'escalated'` must be valid from `'executing'`, `'reviewing'`, and `'queued'` states.
6. Existing behavior for `project`-source and `manual`-source work items must be completely unchanged.
7. No TypeScript compilation errors introduced.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/direct-source-dispatch-logic
```

### Step 1: Read current state of relevant files

Before making changes, read the actual current implementations:

```bash
cat lib/work-items.ts
cat lib/types.ts
```

Pay close attention to:
- The `WorkItem` type definition in `lib/types.ts` — confirm `source`, `triggeredBy`, `complexityHint` fields and their exact type signatures
- The `getNextDispatchable()` function signature and its dependency-check logic
- The `createWorkItem()` function signature and what fields it currently persists
- Any existing status transition guard (look for arrays/objects mapping valid transitions, or switch statements)
- Any existing budget assignment logic

### Step 2: Add budget constants and update `createWorkItem()`

In `lib/work-items.ts`, make the following changes:

**2a. Add budget constants** near the top of the file (after imports):

```typescript
const FAST_LANE_BUDGET_SIMPLE = 2;
const FAST_LANE_BUDGET_MODERATE = 4;
```

**2b. Update `createWorkItem()`** to:
- Accept `triggeredBy?: string` and `complexityHint?: 'simple' | 'moderate' | 'complex'` in its input parameter (likely an object matching `Omit<WorkItem, 'id' | 'createdAt' | 'updatedAt'>` or similar — confirm actual signature from reading the file)
- Persist both fields to the stored work item object
- Apply budget defaulting logic when `budget` is not explicitly provided:

```typescript
// Inside createWorkItem(), when building the work item object:
let resolvedBudget = input.budget;
if (resolvedBudget === undefined || resolvedBudget === null) {
  if (input.complexityHint === 'simple') {
    resolvedBudget = FAST_LANE_BUDGET_SIMPLE;
  } else if (input.complexityHint === 'moderate') {
    resolvedBudget = FAST_LANE_BUDGET_MODERATE;
  }
}

const workItem: WorkItem = {
  // ...existing fields...
  triggeredBy: input.triggeredBy,
  complexityHint: input.complexityHint,
  budget: resolvedBudget,
  // ...
};
```

> **Note:** Adapt this to match the exact current structure of `createWorkItem()`. Do not restructure the function — only add the new fields and budget defaulting.

### Step 3: Update `getNextDispatchable()` for direct-source items

Locate the dependency-check logic inside `getNextDispatchable()`. It likely:
1. Filters items by status `'ready'`
2. Checks that the item's parent project exists and is active (or similar project-gating)
3. Checks that all dependency item IDs have status `'merged'`

**Add a bypass for `source === 'direct'`:**

The pattern to follow — adapt to match the actual code structure:

```typescript
// When evaluating whether an item is dispatchable:
if (item.source === 'direct') {
  // Direct items have no project and no dependencies — always dispatchable
  // (still respect status='ready' filter and any concurrency limits)
  dispatchableItems.push(item); // or return item, depending on function structure
  continue;
}

// Existing project/dependency checks for non-direct items follow below...
```

Key constraints:
- Only bypass the **dependency and project checks** — do not bypass status filtering (item must still be `'ready'`) or global concurrency limits if those exist in this function
- Preserve all existing logic for `project`, `manual`, and `github` source items unchanged

### Step 4: Update status transition logic to allow `'escalated'`

Find the status transition guard in `lib/work-items.ts`. It likely appears as one of:
- A `VALID_TRANSITIONS` map/object like `{ executing: ['reviewing', 'merged', ...], ... }`
- A `canTransition(from, to)` function
- A switch/if block inside an `updateWorkItemStatus()` or `transitionWorkItem()` function

**Add `'escalated'` as a valid target from `'executing'`, `'reviewing'`, and `'queued'`:**

```typescript
// Example if it's a map — adapt to actual structure:
const VALID_TRANSITIONS: Record<WorkItemStatus, WorkItemStatus[]> = {
  // ...existing entries...
  queued: [...existingTargets, 'escalated'],
  executing: [...existingTargets, 'escalated'],
  reviewing: [...existingTargets, 'escalated'],
  // ...
};
```

If no transition guard exists yet (transitions are unconstrained), no change is needed here — document that in the commit message.

### Step 5: Verify TypeScript types are consistent

Check `lib/types.ts` to confirm `WorkItem` already has `triggeredBy` and `complexityHint` defined (from the earlier merged PR). If they are missing or typed differently than what you used in Step 2, align the implementation to match the existing types exactly. Do **not** modify `lib/types.ts` unless a field is entirely absent.

If `complexityHint` type in `types.ts` is different from `'simple' | 'moderate' | 'complex'`, use whatever the type actually is.

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- `triggeredBy` or `complexityHint` not in the `WorkItem` type (check `lib/types.ts`)
- `'escalated'` not in the `WorkItemStatus` union type — if missing, it must be added to `lib/types.ts`
- Budget field typed as `number` but assigned `undefined` — use optional chaining or a fallback

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: handle direct-source items in dispatch logic and creation

- getNextDispatchable() bypasses dependency/project checks for source='direct'
- createWorkItem() persists triggeredBy and complexityHint fields
- Budget defaults: simple=2, moderate=4 when no explicit budget provided
- Status transition to 'escalated' allowed from executing/reviewing/queued
- Existing project/manual source item behavior unchanged"

git push origin feat/direct-source-dispatch-logic

gh pr create \
  --title "feat: handle direct-source items in dispatch logic and creation" \
  --body "## Summary

Updates \`lib/work-items.ts\` to fully support the \`direct\` source type introduced in a previous PR.

## Changes

### \`lib/work-items.ts\`
- **\`getNextDispatchable()\`**: Direct-source items bypass dependency graph and project checks — they are always dispatchable when status is \`ready\`
- **\`createWorkItem()\`**: Now accepts and persists \`triggeredBy\` and \`complexityHint\` fields
- **Budget defaulting**: \`complexityHint='simple'\` → budget=2; \`complexityHint='moderate'\` → budget=4 (only when no explicit budget provided)
- **Status transitions**: \`escalated\` is now a valid target state from \`executing\`, \`reviewing\`, and \`queued\`

## Acceptance Criteria
- [x] \`getNextDispatchable()\` returns direct-source items without dependency/project checks
- [x] \`createWorkItem()\` persists \`triggeredBy\` and \`complexityHint\` to Vercel Blob
- [x] \`complexityHint='simple'\` → budget=2; \`complexityHint='moderate'\` → budget=4
- [x] \`escalated\` transition valid from \`executing\`, \`reviewing\`, \`queued\`
- [x] Existing project/manual item behavior unchanged
- [x] TypeScript compiles clean

## Risk
Low — additive changes with explicit bypass only for \`source === 'direct'\`, all existing code paths preserved."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/direct-source-dispatch-logic
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was ambiguous]
NEXT STEPS: [what remains]
```

### Escalation

If you hit a blocker that cannot be resolved autonomously (e.g., `WorkItem` type is missing `triggeredBy`/`complexityHint` entirely and modifying `types.ts` risks breaking other things, or the dispatch logic structure is significantly different from what this handoff anticipates):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "direct-source-dispatch-logic",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/work-items.ts"]
    }
  }'
```