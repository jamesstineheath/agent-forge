# Agent Forge -- Dispatcher Early-Exit Optimization

## Metadata
- **Branch:** `feat/dispatcher-early-exit-optimization`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/dispatcher.ts

## Context

The Dispatcher agent (`lib/atc/dispatcher.ts`) runs on a 5-minute cron schedule and handles conflict detection, concurrency enforcement, and auto-dispatch of work items. Currently, it acquires a distributed lock, makes GitHub API calls, and potentially invokes LLMs even when there are zero items in `ready` status — i.e., when the pipeline is idle.

This is wasteful. The fix is a lightweight early-exit guard added **before** lock acquisition: query the work item index for `ready` items, and if none exist, log a brief message and return immediately.

**No other files need changing.** The concurrent work item (`fix/create-cost-baseline-tracking-api`) touches `app/api/analytics/cost-baseline/route.ts`, `app/components/model-routing-dashboard.tsx`, and `lib/hooks.ts` — none of which overlap with `lib/atc/dispatcher.ts`.

### Relevant architecture notes

- **Distributed lock** is in `lib/atc/lock.ts`. It must NOT be acquired in the early-exit path.
- **Work item index** is queried via functions in `lib/work-items.ts`. Look for a `listWorkItems`, `getWorkItems`, or `getWorkItemIndex` function that can be called cheaply without a lock.
- **Event logging** is done via `lib/atc/events.ts`. Use the existing event-logging pattern for the early-exit log line.
- **CycleContext / return type** for the dispatcher's main function is defined in `lib/atc/types.ts`. The early-exit return must conform to the same return type shape.

## Requirements

1. At the top of the Dispatcher's main dispatch function (before lock acquisition), add a lightweight check that queries the work item index for items with `status === 'ready'`.
2. If zero `ready` items exist, log a brief observability message (e.g., "Dispatcher: no ready items, skipping cycle") and return early with a result object indicating `no work` — conforming to the existing return type.
3. When one or more `ready` items exist, execution must fall through to all existing logic unchanged.
4. The early-exit path must NOT acquire the distributed lock, make any GitHub API calls, or invoke any LLM.
5. The existing behavior when items ARE ready is fully preserved (no refactoring of existing logic).
6. `npx tsc --noEmit` passes with zero errors.
7. `npm run build` completes successfully.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dispatcher-early-exit-optimization
```

### Step 1: Read the existing dispatcher and supporting files

Before writing any code, read the following files to understand the exact function signatures, return types, and existing patterns:

```bash
cat lib/atc/dispatcher.ts
cat lib/atc/types.ts
cat lib/atc/events.ts
cat lib/work-items.ts
```

Key things to identify:
- The name of the main dispatch function (likely exported, e.g., `runDispatcher` or `dispatchCycle`)
- The return type of that function (check `lib/atc/types.ts` for `CycleContext`, `DispatchResult`, or similar)
- How work items are listed/queried — look for something like `listWorkItems()`, `getWorkItemIndex()`, or `loadWorkItems()`
- How existing early returns are structured (there may already be guard clauses in the function)
- How events/logs are emitted (e.g., `logEvent(...)` or `appendEvent(...)`)

### Step 2: Add the early-exit guard to `lib/atc/dispatcher.ts`

Find the main dispatch function. Immediately after any setup code that is absolutely required (e.g., parsing env vars or reading config that is trivially cheap), but **before** the lock acquisition call, insert the early-exit guard.

The pattern should look like this (adjust to match actual function signatures):

```typescript
// === EARLY EXIT: no ready items ===
const allItems = await listWorkItems(); // or getWorkItemIndex() — use whatever exists
const readyItems = allItems.filter((item) => item.status === 'ready');
if (readyItems.length === 0) {
  console.log('[Dispatcher] No ready items — skipping cycle');
  // Use the existing event-logging utility if one is available, e.g.:
  // await appendEvent({ type: 'dispatcher_skip', reason: 'no_ready_items' });
  return {
    // Return the same shape as other early returns in this function.
    // Check existing guard clauses for the exact shape — likely something like:
    dispatched: 0,
    skipped: 0,
    errors: [],
    reason: 'no_ready_items',
    // ... other fields required by the return type
  };
}
// === END EARLY EXIT ===
```

**Important implementation notes:**
- Do NOT move, reorder, or modify any code below the early-exit block.
- If `listWorkItems()` / `getWorkItemIndex()` is async, `await` it.
- If there is already a similar "no work" check further down, the new check should be additive and upstream of the lock — do not remove existing checks.
- Match the exact return type. If TypeScript complains, look at other return sites in the same function and copy their shape.
- Keep the guard minimal — one index read, one filter, one conditional return. No additional API calls.

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- Missing required fields in the early-return object → add them with zero/empty values matching the type.
- `listWorkItems` not imported at the top of `dispatcher.ts` → add the import from `lib/work-items` (check existing imports in the file first; it may already be imported).

### Step 4: Verify the build passes

```bash
npm run build
```

Resolve any build errors. Do not proceed to commit if the build is red.

### Step 5: Sanity check the logic

Manually review the final diff:

```bash
git diff lib/atc/dispatcher.ts
```

Confirm:
- The early-exit block is placed **before** any `acquireLock(...)` / `lock.acquire(...)` call.
- No existing logic was accidentally deleted or reordered.
- The `readyItems.length === 0` condition correctly returns early.
- A log line is present in the early-exit path.

### Step 6: Commit, push, open PR

```bash
git add lib/atc/dispatcher.ts
git commit -m "feat: add early-exit guard to Dispatcher when no ready items"
git push origin feat/dispatcher-early-exit-optimization
gh pr create \
  --title "feat: Dispatcher early-exit optimization" \
  --body "$(cat <<'EOF'
## Summary

Adds a lightweight early-exit guard to the Dispatcher agent that checks for ready work items **before** acquiring the distributed lock, making GitHub API calls, or invoking any LLM.

## Changes

- `lib/atc/dispatcher.ts`: Added early-exit check at top of main dispatch function. Queries work item index for `ready` items; returns immediately with `dispatched: 0, reason: 'no_ready_items'` when pipeline is idle.

## Behavior

- **Idle pipeline (0 ready items):** Returns immediately after one index read. No lock acquired, no GitHub calls, no LLM invocations.
- **Active pipeline (≥1 ready items):** Falls through to all existing dispatch logic unchanged.

## Testing

- `npx tsc --noEmit` passes
- `npm run build` passes
- No existing logic was modified or reordered

## Risk

Low — additive guard clause only. All existing code paths are preserved when there is work to do.
EOF
)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dispatcher-early-exit-optimization
FILES CHANGED: lib/atc/dispatcher.ts
SUMMARY: [what was done]
ISSUES: [what failed or is unclear]
NEXT STEPS: [what remains — e.g., return type shape unclear, lock acquisition line not found]
```

**Common blockers and how to escalate:**

If the return type of the main dispatch function cannot be determined (e.g., it returns `void` or the type is complex and opaque), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "dispatcher-early-exit-optimization",
    "reason": "Cannot determine return type shape for early-exit return in dispatcher main function — manual inspection needed",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "2",
      "error": "TypeScript error on early-exit return object — fields unclear",
      "filesChanged": ["lib/atc/dispatcher.ts"]
    }
  }'
```