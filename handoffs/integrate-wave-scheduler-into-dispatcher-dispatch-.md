# Agent Forge -- Integrate wave scheduler into Dispatcher dispatch step

## Metadata
- **Branch:** `feat/wave-scheduler-dispatcher-integration`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/dispatcher.ts, lib/inngest/dispatcher.ts

## Context

The wave scheduler (`lib/wave-scheduler.ts`) was recently implemented with `assignWavesSafe` — a safe wrapper around wave assignment that returns a fallback result on failure. The Dispatcher currently dispatches work items one-at-a-time sequentially. This task integrates the wave scheduler into the Dispatcher so that items within the same wave are dispatched concurrently via `Promise.allSettled`.

Key facts about the existing codebase:
- `lib/atc/dispatcher.ts` contains the core dispatch logic used by the Inngest dispatcher cycle
- `lib/inngest/dispatcher.ts` is the Inngest step function that calls into the dispatcher module
- `lib/wave-scheduler.ts` exports `assignWavesSafe(items, options?)` returning `{ assignments: Map<string, number>, fallback: boolean }`
- `lib/atc/events.ts` exports event emitter helpers for the event log
- Work items are stored in Neon Postgres via Drizzle (`lib/db/index.ts`, `lib/db/schema.ts`)
- The `work_items` table has a `waveNumber` column (added in a recent migration) or needs one added
- Concurrency limit is 40 total GitHub Actions slots across all repos; per-repo limits are defined in `lib/repos.ts`
- On fallback mode from `assignWavesSafe`, dispatcher should fall back to sequential dispatch and create an escalation

The recent PRs show patterns for:
- Using `Promise.allSettled` for parallel operations
- Emitting events via `lib/atc/events.ts`
- Escalation creation via `lib/escalation.ts`
- Wave scheduler integration patterns from `lib/wave-scheduler.ts` and `lib/wave-scheduler.test.ts`

## Requirements

1. `lib/atc/dispatcher.ts` imports `assignWavesSafe` from `lib/wave-scheduler.ts`
2. `lib/atc/dispatcher.ts` imports wave-related event emitters from `lib/atc/events.ts`
3. After selecting items for a project, `assignWavesSafe` is called to compute wave assignments
4. Each work item's `waveNumber` is persisted to Postgres after wave assignment
5. The dispatcher identifies the lowest-numbered incomplete wave (items not yet in executing/merged/verified/failed state)
6. All items in the current wave are dispatched concurrently using `Promise.allSettled` (not sequentially)
7. Concurrency budget is calculated as: count currently executing items across all repos, subtract from 40 to get available slots; also respect per-repo concurrency limits
8. When `assignWavesSafe` returns `fallback: true`, the dispatcher falls back to sequential one-at-a-time dispatch and creates an escalation via `lib/escalation.ts`
9. Wave events are emitted to the event log: at minimum `wave:assigned` after wave computation and `wave:dispatched` after successful concurrent dispatch
10. `lib/inngest/dispatcher.ts` dispatch step uses the updated wave-aware dispatch logic
11. TypeScript compiles without errors (`npx tsc --noEmit`)
12. No existing tests are broken

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-scheduler-dispatcher-integration
```

### Step 1: Inspect existing code

Read the following files carefully before making any changes:

```bash
cat lib/atc/dispatcher.ts
cat lib/wave-scheduler.ts
cat lib/atc/events.ts
cat lib/atc/types.ts
cat lib/inngest/dispatcher.ts
cat lib/db/schema.ts
cat lib/repos.ts
cat lib/escalation.ts
cat lib/work-items.ts
```

Pay attention to:
- The exact signature of `assignWavesSafe` (return type, parameters)
- What event emitter functions exist in `lib/atc/events.ts` (look for anything wave-related; if none exist, you'll need to add them)
- Whether `waveNumber` already exists on the `work_items` schema or needs to be added
- The shape of `WorkItem` type in `lib/types.ts`
- How the dispatcher currently loops over items and calls workflow_dispatch
- How escalations are created (look at existing escalation calls in the codebase)
- The per-repo concurrency limit structure in `lib/repos.ts`

```bash
cat lib/types.ts
grep -r "waveNumber" --include="*.ts" .
grep -r "assignWavesSafe\|wave-scheduler" --include="*.ts" .
grep -r "createEscalation\|escalation" lib/atc/dispatcher.ts
grep -r "workflow_dispatch\|dispatchItem\|dispatch" lib/atc/dispatcher.ts | head -40
grep -r "executing" lib/atc/dispatcher.ts | head -20
grep -n "concurrency\|maxConcurrent\|perRepo" lib/repos.ts
```

### Step 2: Check DB schema for waveNumber and add migration if needed

```bash
grep -n "wave" lib/db/schema.ts
```

If `waveNumber` does not exist on the `work_items` table schema:

Add it to `lib/db/schema.ts` in the `workItems` table definition:
```typescript
waveNumber: integer("wave_number"),
```

Then check if there's a migration mechanism:
```bash
cat app/api/admin/migrate/route.ts
```

If the admin migrate route runs `ALTER TABLE` statements, add the column there as an idempotent migration:
```sql
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS wave_number INTEGER;
```

After adding to schema and migration, run the migration by noting it needs to be applied. The agent should add the SQL to the existing migration route's idempotent list.

### Step 3: Add wave event emitters to lib/atc/events.ts if not present

```bash
grep -n "wave" lib/atc/events.ts
```

If wave event types/emitters don't exist, add them. Look at the existing event emitter pattern in `lib/atc/events.ts` and add:

```typescript
// Wave events - add to the existing event emission infrastructure
export function emitWaveAssigned(params: {
  projectId: string;
  workItemIds: string[];
  waveNumber: number;
  totalWaves: number;
}): void {
  // Follow the exact same pattern as existing emitEvent calls in this file
  appendEvent({
    type: 'wave:assigned',
    ...params,
    timestamp: new Date().toISOString(),
  });
}

export function emitWaveDispatched(params: {
  projectId: string;
  workItemIds: string[];
  waveNumber: number;
  results: Array<{ id: string; status: 'dispatched' | 'failed'; error?: string }>;
}): void {
  appendEvent({
    type: 'wave:dispatched',
    ...params,
    timestamp: new Date().toISOString(),
  });
}
```

**Important:** Match the exact event emission pattern already in `lib/atc/events.ts`. Do not invent new patterns — replicate what's there.

### Step 4: Implement wave-aware dispatch in lib/atc/dispatcher.ts

This is the core change. Study the current dispatch loop carefully, then refactor it.

The new dispatch logic should follow this pseudocode:

```typescript
import { assignWavesSafe } from '../wave-scheduler';
import { emitWaveAssigned, emitWaveDispatched } from './events'; // or whatever the actual export names are
import { createEscalation } from '../escalation'; // if needed for fallback

// Inside the dispatch function, after selecting eligible items for a project:

async function dispatchProjectItems(
  projectItems: WorkItem[],
  cycleContext: CycleContext, // or whatever context type is used
): Promise<void> {
  
  // 1. Compute wave assignments
  const { assignments, fallback } = assignWavesSafe(projectItems);
  
  // 2. Handle fallback mode: sequential dispatch + escalation
  if (fallback) {
    // Create escalation to notify about fallback
    await createEscalation({
      workItemId: projectItems[0]?.id ?? 'unknown',
      reason: 'Wave scheduler fallback mode: dispatching sequentially',
      // ... match existing escalation call signature
    });
    
    // Sequential fallback: dispatch one at a time (existing behavior)
    for (const item of projectItems) {
      await dispatchSingleItem(item, cycleContext);
    }
    return;
  }
  
  // 3. Persist waveNumber on each work item in DB
  await Promise.allSettled(
    projectItems.map(item => {
      const waveNum = assignments.get(item.id) ?? 1;
      return updateWorkItem(item.id, { waveNumber: waveNum });
    })
  );
  
  // 4. Emit wave:assigned event
  const totalWaves = Math.max(...Array.from(assignments.values()));
  emitWaveAssigned({
    projectId: projectItems[0].projectId,
    workItemIds: projectItems.map(i => i.id),
    waveNumber: 1, // current wave being dispatched
    totalWaves,
  });
  
  // 5. Calculate concurrency budget
  const MAX_TOTAL_SLOTS = 40;
  const currentlyExecuting = await countExecutingItemsAcrossAllRepos();
  const availableSlots = Math.max(0, MAX_TOTAL_SLOTS - currentlyExecuting);
  
  // Also get per-repo limit
  const repoConfig = getRepoConfig(projectItems[0].repo); // adapt to actual API
  const perRepoLimit = repoConfig?.maxConcurrent ?? 3;
  
  // 6. Find lowest incomplete wave
  const TERMINAL_STATES = ['merged', 'verified', 'failed', 'parked'];
  const incompleteWaveNums = Array.from(new Set(
    projectItems
      .filter(item => !TERMINAL_STATES.includes(item.status))
      .map(item => assignments.get(item.id) ?? 1)
  )).sort((a, b) => a - b);
  
  const currentWaveNum = incompleteWaveNums[0];
  if (currentWaveNum === undefined) return; // all waves complete
  
  // 7. Get items in current wave that are ready to dispatch
  const DISPATCHABLE_STATES = ['ready', 'queued'];
  const waveItems = projectItems.filter(item => 
    assignments.get(item.id) === currentWaveNum &&
    DISPATCHABLE_STATES.includes(item.status)
  );
  
  // 8. Apply concurrency budget
  const budget = Math.min(availableSlots, perRepoLimit);
  const itemsToDispatch = waveItems.slice(0, budget);
  
  if (itemsToDispatch.length === 0) return;
  
  // 9. Dispatch all items in current wave concurrently
  const dispatchResults = await Promise.allSettled(
    itemsToDispatch.map(item => dispatchSingleItem(item, cycleContext))
  );
  
  // 10. Emit wave:dispatched event
  emitWaveDispatched({
    projectId: projectItems[0].projectId,
    workItemIds: itemsToDispatch.map(i => i.id),
    waveNumber: currentWaveNum,
    results: dispatchResults.map((result, idx) => ({
      id: itemsToDispatch[idx].id,
      status: result.status === 'fulfilled' ? 'dispatched' : 'failed',
      error: result.status === 'rejected' ? String(result.reason) : undefined,
    })),
  });
}
```

**Critical:** Adapt all of the above to the actual function signatures, types, and patterns found in the existing code. Do not copy this pseudocode verbatim — use it as a guide and match actual patterns.

Key things to preserve:
- All existing conflict detection logic must remain
- All existing concurrency limit checks must remain (the new budget check is additive)
- The `dispatchSingleItem` (or equivalent) function should not change — only the orchestration around it changes
- The existing sequential loop becomes the fallback path

### Step 5: Update lib/inngest/dispatcher.ts

The Inngest dispatcher cycle calls into the dispatcher module. Ensure the dispatch step uses the new wave-aware path.

```bash
cat lib/inngest/dispatcher.ts
```

Look for the dispatch step (likely `step.run('dispatch', ...)` or similar). The wave-aware logic should be called from the dispatcher module — the Inngest layer should remain thin.

If the Inngest dispatcher calls a function like `runDispatchCycle()` or `dispatchReady()` from `lib/atc/dispatcher.ts`, and the new wave logic is inside that function, no changes may be needed in the Inngest file. If the Inngest file has inline dispatch logic, refactor it to call the updated dispatcher module function.

Verify the Inngest step correctly awaits the wave-aware dispatch and that the step timeout is sufficient (wave dispatch with `Promise.allSettled` across many items could take longer than a single dispatch).

### Step 6: Add countExecutingItemsAcrossAllRepos helper

If this helper doesn't exist, add it to `lib/atc/dispatcher.ts` (or `lib/work-items.ts` if that's a better fit):

```typescript
async function countExecutingItemsAcrossAllRepos(): Promise<number> {
  // Query Postgres for count of items in 'executing' or 'generating' status
  // Use the existing db/drizzle patterns from lib/work-items.ts
  const result = await db
    .select({ count: count() })
    .from(workItems)
    .where(inArray(workItems.status, ['executing', 'generating', 'queued']));
  return result[0]?.count ?? 0;
}
```

Match the exact Drizzle query patterns used in `lib/work-items.ts`.

### Step 7: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `waveNumber` not on `WorkItem` type in `lib/types.ts` — add it as optional: `waveNumber?: number`
- Event type union not including `'wave:assigned'` and `'wave:dispatched'` — add to the union in `lib/event-bus-types.ts` if needed
- `assignWavesSafe` return type mismatch — match exactly what `lib/wave-scheduler.ts` exports

```bash
grep -n "GitHubEventType\|WebhookEvent\|EventType" lib/event-bus-types.ts
```

Add wave event types to any event type unions as needed.

### Step 8: Run tests

```bash
npm test -- --testPathPattern="wave-scheduler|dispatcher" --passWithNoTests
npm test
```

If any tests fail due to the new wave logic, fix them. The `lib/wave-scheduler.test.ts` file shows the expected behavior of `assignWavesSafe`.

### Step 9: Build verification

```bash
npm run build
```

Fix any build errors before proceeding.

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "feat: integrate wave scheduler into Dispatcher dispatch step

- Import assignWavesSafe from lib/wave-scheduler.ts
- Persist waveNumber on each work item in Postgres after wave assignment
- Dispatch all items in current wave concurrently via Promise.allSettled
- Calculate concurrency budget: min(per-repo limit, 40 - currently executing)
- Fall back to sequential dispatch + escalation when assignWavesSafe returns fallback mode
- Emit wave:assigned and wave:dispatched events to event log
- Update Inngest dispatcher step to use wave-aware dispatch logic"

git push origin feat/wave-scheduler-dispatcher-integration

gh pr create \
  --title "feat: integrate wave scheduler into Dispatcher dispatch step" \
  --body "## Summary

Refactors the Dispatcher's dispatch logic to operate wave-by-wave using the previously implemented \`assignWavesSafe\` wave scheduler.

## Changes

### \`lib/atc/dispatcher.ts\`
- Imports \`assignWavesSafe\` from \`lib/wave-scheduler.ts\`
- Imports wave event emitters from \`lib/atc/events.ts\`
- After selecting items for a project, calls \`assignWavesSafe\` to compute wave assignments
- Persists \`waveNumber\` on each work item in Postgres
- Identifies lowest incomplete wave number
- Dispatches all items in current wave concurrently via \`Promise.allSettled\`
- Calculates concurrency budget: \`min(per-repo limit, 40 - currentlyExecuting)\`
- Falls back to sequential dispatch + escalation when \`fallback: true\`
- Emits \`wave:assigned\` and \`wave:dispatched\` events

### \`lib/inngest/dispatcher.ts\`
- Updated dispatch step to use wave-aware dispatch logic from dispatcher module

### \`lib/db/schema.ts\` (if needed)
- Added \`waveNumber\` column to \`work_items\` table

### \`lib/types.ts\` (if needed)
- Added optional \`waveNumber\` field to \`WorkItem\` type

### \`lib/atc/events.ts\` (if needed)
- Added \`emitWaveAssigned\` and \`emitWaveDispatched\` event emitters

## Acceptance Criteria
- [x] Dispatcher calls assignWavesSafe and persists waveNumber on each work item in Postgres
- [x] All items in the current wave are dispatched concurrently via Promise.allSettled
- [x] Concurrency budget is respected: total concurrent dispatches across all repos does not exceed 40
- [x] When fallback mode is active, dispatcher falls back to sequential dispatch and creates an escalation
- [x] Wave events (assigned, dispatched) are emitted to the event log during dispatch
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
BRANCH: feat/wave-scheduler-dispatcher-integration
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you hit a blocker that cannot be resolved autonomously (e.g., `assignWavesSafe` signature is incompatible with expected usage, `waveNumber` column causes a migration failure, or the Inngest step structure is fundamentally different from what this handoff assumed):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "integrate-wave-scheduler-dispatcher",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/dispatcher.ts", "lib/inngest/dispatcher.ts"]
    }
  }'
```