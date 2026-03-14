# Agent Forge -- Queue Management + Auto-Dispatch

## Metadata
- **Branch:** `feat/queue-management`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts, lib/types.ts, lib/work-items.ts, lib/orchestrator.ts, app/api/atc/cron/route.ts

## Context

The ATC cron (lib/atc.ts) currently monitors active executions and transitions work item states, but it does not auto-dispatch queued items when capacity opens up. The dispatch flow (lib/orchestrator.ts, `dispatchWorkItem`) only runs when triggered by a human via the dashboard dispatch button. This means the pipeline stalls whenever an execution completes: someone has to manually dispatch the next item.

Phase 2b closes this loop. When ATC detects that a repo has available capacity (active executions < concurrencyLimit), it should automatically dispatch the highest-priority ready item targeting that repo.

Current ATC cycle flow (lib/atc.ts, `runATCCycle`):
1. Load executing + reviewing work items
2. Check each for timeout, poll GitHub for state changes
3. Log concurrency_block events (but take no action)
4. Save state + events

The concurrency check in step 3 already compares active count vs. repo.concurrencyLimit but only logs an event. It needs to flip: instead of logging "at capacity", it should check "below capacity" and dispatch.

Key files:
- `lib/atc.ts` -- ATC cycle logic. Modify to add auto-dispatch after state transitions.
- `lib/types.ts` -- ATCEvent type. Add `auto_dispatch` event type.
- `lib/work-items.ts` -- Work item CRUD. Already has `listWorkItems({ status, targetRepo })` which is what we need for finding dispatchable items.
- `lib/orchestrator.ts` -- `dispatchWorkItem(id)` is the existing dispatch function. ATC calls this directly.
- `app/api/atc/cron/route.ts` -- Cron endpoint. May need to increase timeout or add error handling for dispatch failures during cron.

## Requirements

1. After processing all active executions (state transitions, timeouts), ATC checks each registered repo for available capacity.
2. For each repo with capacity (activeCount < concurrencyLimit), ATC finds the highest-priority "ready" work item targeting that repo. Priority ordering: high > medium > low, then by createdAt ascending (oldest first).
3. ATC calls `dispatchWorkItem(id)` for the selected item. On success, log an `auto_dispatch` event. On failure, log an `error` event and continue (don't crash the cycle).
4. ATC dispatches at most one item per repo per cycle (conservative, avoids race conditions).
5. Add `auto_dispatch` to the ATCEvent type union.
6. The ATC cron response should include dispatch actions taken this cycle.
7. Global concurrency limit: add a constant `GLOBAL_CONCURRENCY_LIMIT = 3` (total active executions across all repos). Check this before dispatching.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/queue-management
```

### Step 1: Update ATCEvent type

In `lib/types.ts`, add `"auto_dispatch"` to the ATCEvent type union:
```typescript
type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "error";
```

### Step 2: Add priority sorting helper

In `lib/work-items.ts`, export a helper function `getNextDispatchable(targetRepo: string): Promise<WorkItem | null>` that:
- Calls `listWorkItems({ status: "ready", targetRepo })`
- Loads full work items for each entry
- Sorts by priority (high=0, medium=1, low=2), then by createdAt ascending
- Returns the first item, or null if none

### Step 3: Add auto-dispatch to ATC cycle

In `lib/atc.ts`, after the existing concurrency check loop (step 3 in the current code), add an auto-dispatch section:

```typescript
// 4. Auto-dispatch: for repos with available capacity, dispatch next ready item
const GLOBAL_CONCURRENCY_LIMIT = 3;
const totalActive = activeExecutions.filter(
  e => e.status === "executing" || e.status === "reviewing"
).length;

if (totalActive < GLOBAL_CONCURRENCY_LIMIT) {
  for (const repoEntry of repoIndex) {
    if (totalActive >= GLOBAL_CONCURRENCY_LIMIT) break;
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;
    const activeCount = concurrencyMap.get(repo.fullName) ?? 0;
    if (activeCount >= repo.concurrencyLimit) continue;

    const nextItem = await getNextDispatchable(repo.fullName);
    if (!nextItem) continue;

    try {
      const result = await dispatchWorkItem(nextItem.id);
      events.push(makeEvent(
        "auto_dispatch", nextItem.id, "ready", "executing",
        `Auto-dispatched to ${repo.fullName} (branch: ${result.branch})`
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      events.push(makeEvent(
        "error", nextItem.id, undefined, undefined,
        `Auto-dispatch failed: ${msg}`
      ));
    }
  }
}
```

Import `dispatchWorkItem` from `./orchestrator` and `getNextDispatchable` from `./work-items` at the top of `lib/atc.ts`.

### Step 4: Update cron response

In `app/api/atc/cron/route.ts`, add dispatch count to the response:
```typescript
const dispatchEvents = state.recentEvents.filter(e => e.type === "auto_dispatch");
// In the response JSON:
state: {
  lastRunAt: state.lastRunAt,
  activeExecutions: state.activeExecutions.length,
  queuedItems: state.queuedItems,
  eventsThisCycle: state.recentEvents.length,
  dispatchedThisCycle: dispatchEvents.length,
},
```

### Step 5: Verification
```bash
npx tsc --noEmit
npm run build
```

### Step 6: Commit, push, open PR
```bash
git add -A
git commit -m "feat: queue management + auto-dispatch in ATC

ATC now automatically dispatches the highest-priority ready work item
when a repo has available capacity. Dispatches at most one item per
repo per cycle, respects both per-repo and global concurrency limits.

Adds auto_dispatch event type and getNextDispatchable helper."
git push origin feat/queue-management
gh pr create --title "feat: queue management + auto-dispatch" --body "## Summary
- ATC auto-dispatches ready work items when repo capacity is available
- Priority ordering: high > medium > low, then oldest first
- Per-repo and global (3) concurrency limits enforced
- At most one dispatch per repo per ATC cycle
- New auto_dispatch event type for audit trail

## Files Changed
- lib/types.ts (ATCEvent type)
- lib/work-items.ts (getNextDispatchable helper)
- lib/atc.ts (auto-dispatch logic in runATCCycle)
- app/api/atc/cron/route.ts (dispatch count in response)

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Medium. Calls dispatchWorkItem which creates branches and pushes files to target repos. Failure handling wraps each dispatch in try/catch so a single failure doesn't crash the cycle. Conservative: max one dispatch per repo per cycle."
```

### Step 7: Auto-merge
If CI passes and TLM review approves, merge the PR:
```bash
gh pr merge --squash --auto
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/queue-management
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
