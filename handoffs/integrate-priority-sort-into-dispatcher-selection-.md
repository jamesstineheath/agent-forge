# Agent Forge -- Integrate priority sort into Dispatcher selection logic

## Metadata
- **Branch:** `feat/integrate-priority-sort-into-dispatcher`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/dispatcher.ts

## Context

The Dispatcher agent (`lib/atc/dispatcher.ts`) is responsible for selecting eligible work items (in `ready` or `queued` state) and dispatching them to target repositories. Currently, item selection uses FIFO or simple ordering — it does not account for priority or rank.

A recent merged PR (`feat: add dispatch sort comparator with default priority constants`) added `dispatchSortComparator` to `lib/atc/utils.ts`. Another merged PR added `priority` and `rank` fields to the `WorkItem` type in `lib/types.ts`. This handoff wires those two pieces together by integrating the comparator into the Dispatcher's selection logic.

**What `dispatchSortComparator` does:**
- Sorts by `priority` ascending (P0 < P1 < P2; items without priority default to P1)
- Within the same priority tier, sorts by `rank` ascending (lower rank = higher precedence; items without rank default to 999)
- Within the same priority+rank, sorts by `createdAt` ascending (earliest first)

**Concurrency note:** There is concurrent work on `feat/propagate-priority-and-rank-from-prd-during-decomp` touching `lib/decomposer.ts` and `lib/pm-prompts.ts`. This handoff only touches `lib/atc/dispatcher.ts` — no overlap.

## Requirements

1. Import `dispatchSortComparator` from `lib/atc/utils.ts` in `lib/atc/dispatcher.ts`
2. In the section where eligible work items are collected for dispatch, apply `.sort(dispatchSortComparator)` before selecting the next candidate
3. The first item after sorting must be the highest-priority, lowest-rank, earliest-created eligible item
4. Legacy items without `priority`/`rank` fields continue to work correctly (the comparator defaults them to P1/999)
5. Add a code comment above the sort call explaining the ordering semantics
6. TypeScript compilation passes with zero errors (`npx tsc --noEmit`)
7. No other files are modified

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/integrate-priority-sort-into-dispatcher
```

### Step 1: Inspect current dispatcher selection logic

Read the file to understand the current structure before making changes:

```bash
cat lib/atc/dispatcher.ts
```

Identify:
- The existing import block (to know where to add the new import)
- The section where eligible items are collected — look for arrays of `WorkItem` objects filtered to `status === 'ready'` or `status === 'queued'`
- The line where the "next item to dispatch" is selected (e.g., `eligible[0]`, `items[0]`, or a `.find()` call after filtering)

Also confirm the exported name from utils:

```bash
grep -n "dispatchSortComparator" lib/atc/utils.ts
```

### Step 2: Add the import

In `lib/atc/dispatcher.ts`, locate the existing import from `lib/atc/utils.ts`. It likely looks something like:

```typescript
import { someUtil, anotherUtil } from './utils';
```

Add `dispatchSortComparator` to that import. If there is no existing import from `./utils`, add a new one:

```typescript
import { dispatchSortComparator } from './utils';
```

### Step 3: Apply sort before item selection

Locate the section in the dispatcher where eligible items are assembled into an array and the next dispatch candidate is chosen. It will look roughly like one of these patterns:

**Pattern A — array then index access:**
```typescript
const eligible = allItems.filter(item =>
  item.status === 'ready' || item.status === 'queued'
);
const next = eligible[0];
```

**Pattern B — filter then find:**
```typescript
const next = allItems.find(item => item.status === 'ready' || item.status === 'queued');
```

**Pattern C — separate collection then loop:**
```typescript
const readyItems = items.filter(i => i.status === 'ready');
// ... dispatch readyItems[0]
```

In all cases, insert the sort **after** filtering and **before** selection. Transform to:

```typescript
// Sort eligible items by priority (P0 first), then rank (lower = higher precedence),
// then createdAt (earliest first). Legacy items without priority/rank default to P1/999.
const sortedEligible = eligible.sort(dispatchSortComparator);
const next = sortedEligible[0];
```

If the pattern uses `.find()` directly on the array, convert it:

```typescript
// Sort eligible items by priority (P0 first), then rank (lower = higher precedence),
// then createdAt (earliest first). Legacy items without priority/rank default to P1/999.
const next = allItems
  .filter(item => item.status === 'ready' || item.status === 'queued')
  .sort(dispatchSortComparator)[0];
```

**Important:** `.sort()` mutates the original array. If the original array is used elsewhere after this point in the same function scope, assign to a new variable (`const sortedEligible = [...eligible].sort(dispatchSortComparator)`) instead of sorting in place.

Scan the rest of the function body to check whether the original array is referenced again after the sort point. If yes, use the spread copy pattern. If not, in-place sort is fine.

### Step 4: Verify the change compiles

```bash
npx tsc --noEmit
```

Resolve any TypeScript errors. Common issues:
- `dispatchSortComparator` not found → confirm the exact export name in `lib/atc/utils.ts` with `grep -n "export" lib/atc/utils.ts`
- Type mismatch on `.sort()` → the comparator signature should be `(a: WorkItem, b: WorkItem) => number`; if the array contains a wider type, cast appropriately

### Step 5: Confirm no other files were modified

```bash
git diff --name-only
```

Output should be exactly:
```
lib/atc/dispatcher.ts
```

If any other file appears in the diff, review and revert unintended changes.

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -30
```

Both should succeed without errors. If `npm run build` is not available, `npx tsc --noEmit` alone is sufficient for this change.

### Step 7: Commit, push, open PR

```bash
git add lib/atc/dispatcher.ts
git commit -m "feat: integrate dispatchSortComparator into Dispatcher selection logic

Sort eligible work items by priority → rank → createdAt before selecting
the next dispatch candidate. P0 items now dispatch before P1/P2 regardless
of creation order. Legacy items without priority/rank default to P1/999
via the comparator's built-in defaults."

git push origin feat/integrate-priority-sort-into-dispatcher

gh pr create \
  --title "feat: integrate priority sort into Dispatcher selection logic" \
  --body "## Summary

Wires \`dispatchSortComparator\` (added in a recent merged PR) into the Dispatcher's item selection logic so that eligible work items are dispatched in priority order rather than FIFO.

## Changes

- **\`lib/atc/dispatcher.ts\`**: Import \`dispatchSortComparator\` from \`./utils\` and apply \`.sort(dispatchSortComparator)\` to the eligible items array before selecting the next dispatch candidate.

## Sort order

1. Priority ascending: P0 → P1 → P2 (items without priority default to P1)
2. Rank ascending within same priority tier (items without rank default to 999)
3. createdAt ascending within same priority+rank tier

## Acceptance criteria

- [x] \`dispatchSortComparator\` imported and used in dispatcher selection
- [x] P0 item queued after P2 item dispatches first
- [x] Lower rank dispatches first within same priority tier
- [x] Earliest-created dispatches first when priority and rank are equal
- [x] TypeScript compiles with zero errors

## No concurrent conflicts

Concurrent branch \`feat/propagate-priority-and-rank-from-prd-during-decomp\` touches \`lib/decomposer.ts\` and \`lib/pm-prompts.ts\` only — no overlap with this change."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/integrate-priority-sort-into-dispatcher
FILES CHANGED: lib/atc/dispatcher.ts
SUMMARY: [what was done]
ISSUES: [what failed or remains ambiguous]
NEXT STEPS: [what the next agent/human needs to do]
```

**Common blockers and resolutions:**

- **`dispatchSortComparator` not exported from utils.ts**: Check exact export name with `grep -n "export.*Sort\|export.*sort\|export.*dispatch" lib/atc/utils.ts`. Escalate if not found.
- **Dispatcher does not collect an array of eligible items** (e.g., dispatches one item at a time via a queue pop): Apply sort to whatever collection is available before the first item is selected. If the architecture is fundamentally incompatible with a pre-sort, escalate.
- **TypeScript errors on WorkItem type**: Confirm `priority` and `rank` are defined on `WorkItem` in `lib/types.ts` (`grep -n "priority\|rank" lib/types.ts`). If missing, escalate — do not add fields to types.ts (that may conflict with concurrent work).

**Escalation:**

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "integrate-priority-sort-into-dispatcher",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/dispatcher.ts"]
    }
  }'
```