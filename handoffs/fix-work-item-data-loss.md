# Handoff: Fix Work Item Data Loss (Reconciliation + Dead-Dep Cascade)

**Priority:** P0 — Critical data loss bug
**Target repo:** agent-forge
**Max Budget:** $5
**Risk Level:** High (fixes core ATC data integrity)

## Problem Statement

Work items are being silently wiped from the Vercel Blob store. This has happened at least twice (Session 44/45 and again in Session 45 continuation). The pattern:

1. Work items are created by the decomposer and dispatched
2. Some items enter "executing" status
3. After some time, ALL work items disappear — the `/api/work-items` endpoint returns `[]`
4. The ATC events log stops updating (no items to process)
5. The entire pipeline is dead-stopped

Root cause is two compounding bugs in `lib/atc.ts`.

## Bug 1: Reconciliation deletes all blobs on transient index read failure

**File:** `lib/atc.ts`, Section 9.5 (blob-index reconciliation)

The reconciliation logic:
```typescript
const indexEntries = await listWorkItems({});
const indexIds = new Set(indexEntries.map(e => e.id));
const danglingIds = [...blobIds].filter(id => id && !indexIds.has(id));
// Deletes all danglingIds
```

`listWorkItems({})` calls `loadIndex()` which returns `[]` on ANY failure (transient blob read error, network timeout, cold start, etc.) because of the `?? []` fallback. When the index appears empty, EVERY blob ID is treated as "dangling" and deleted. This wipes the entire work item store.

**Fix:** Add a safety guard. If the index returns 0 entries but the blob store has >0 work item blobs, skip reconciliation entirely and log a warning. Additionally, add a proportionality guard: if the number of "dangling" blobs exceeds 50% of total blobs, refuse to delete and log an error.

```typescript
// In Section 9.5, BEFORE computing danglingIds:
if (indexEntries.length === 0 && blobs.length > 0) {
  console.warn(`[atc] Reconciliation safety: index is empty but ${blobs.length} blob(s) exist. Skipping to prevent data loss.`);
  await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
  // DO NOT proceed to delete any blobs
} else {
  const danglingIds = [...blobIds].filter(id => id && !indexIds.has(id));
  if (danglingIds.length > 0 && danglingIds.length > blobIds.size * 0.5) {
    console.error(`[atc] Reconciliation safety: ${danglingIds.length}/${blobIds.size} blobs flagged as dangling (>50%). Refusing to delete. Likely index corruption.`);
  } else if (danglingIds.length > 0) {
    for (const id of danglingIds) {
      await deleteJson(`work-items/${id}`);
    }
    events.push(makeEvent(
      "cleanup", "system", undefined, undefined,
      `Blob reconciliation: deleted ${danglingIds.length} dangling work-item blob(s)`
    ));
  }
}
```

## Bug 2: Dead-dep auto-cancel treats null (deleted) deps as permanently unresolvable

**File:** `lib/atc.ts`, Section 4.1 (dead dependency auto-cancellation)

The current logic:
```typescript
if (!dep) {
  // Dependency was deleted - permanently unresolvable
  deadDeps.push(depId);
}
```

When `getWorkItem(depId)` returns null, the code assumes the dependency was intentionally deleted. But null can also mean transient blob read failure or the blob was incorrectly deleted by Bug 1. This creates a cascading failure: Bug 1 deletes some blobs, Bug 2 sees null deps and cancels everything, triggering more cancellations.

**Fix:** Do NOT treat null deps as dead. Only auto-cancel when deps are explicitly in a terminal failure state.

```typescript
if (!dep) {
  // Dep blob missing — could be transient. Do NOT auto-cancel.
  console.warn(`[atc] Dead-dep check: dependency ${depId} for item ${item.id} returned null. Skipping (possible transient failure).`);
  continue; // Skip, don't treat as dead
} else if (TERMINAL_FAILURE_STATUSES.includes(dep.status)) {
  deadDeps.push(depId);
}
```

## Bug 3: No reverse index reconciliation

**File:** `lib/atc.ts`, Section 9.5

After Bug 1 wipes blobs, the index still has entries pointing to deleted blobs. Every `getWorkItem()` returns null, breaking all ATC sections.

**Fix:** Add reverse reconciliation with proportionality guard.

```typescript
// After the forward (dangling blob) check:
const staleIndexEntries = indexEntries.filter(e => !blobIds.has(e.id));
if (staleIndexEntries.length > 0 && staleIndexEntries.length < indexEntries.length) {
  const cleanedIndex = indexEntries.filter(e => blobIds.has(e.id));
  await saveJson("work-items/index", cleanedIndex);
  events.push(makeEvent(
    "cleanup", "system", undefined, undefined,
    `Index reconciliation: removed ${staleIndexEntries.length} stale index entries`
  ));
} else if (staleIndexEntries.length === indexEntries.length && indexEntries.length > 0) {
  console.error(`[atc] Reconciliation safety: ALL ${indexEntries.length} index entries are stale. Refusing to wipe index.`);
}
```

## Step 0: Branch + Commit

Create branch `fix/work-item-data-loss` from `main`. Commit this handoff file. Push.

## Step 1: Fix reconciliation safety guard (Bug 1)

**Modified file:** `lib/atc.ts`

In Section 9.5 (search for "blob-index reconciliation"), wrap the dangling blob deletion in safety guards:
- Empty index + non-empty blobs: skip entirely, log warning
- Dangling count >50% of total: refuse to delete, log error
- Otherwise proceed with existing deletion logic

## Step 2: Fix dead-dep null handling (Bug 2)

**Modified file:** `lib/atc.ts`

In Section 4.1 (search for "Dead dependency auto-cancellation"), change the `if (!dep)` block from pushing to `deadDeps` to logging a warning and `continue`. Only push to `deadDeps` when the dep exists AND is in a terminal failure state.

## Step 3: Add reverse index reconciliation (Bug 3)

**Modified file:** `lib/atc.ts`

In Section 9.5, after the forward (dangling blob) check, add the reverse (stale index entry) check with the same proportionality safety guard.

## Step 4: Build + type check

```bash
npm run build
npx tsc --noEmit
```

Both must pass with zero errors.

## Pre-flight self-check

Before creating a PR, verify:
- [ ] Reconciliation has both safety guards (empty index guard + proportionality guard)
- [ ] Dead-dep auto-cancel does NOT treat null deps as dead
- [ ] Reverse index reconciliation has proportionality guard
- [ ] No changes to work item creation, dispatch, or status transition logic
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes

## Abort protocol

If `npm run build` fails after 3 attempts, stop and open a PR with what you have, noting the build failure in the PR description. Do NOT force changes to unrelated files to make the build pass.

## Acceptance Criteria

1. Transient blob read failures during reconciliation do NOT cause mass deletion
2. Dead-dep auto-cancel only fires on explicitly failed/parked/cancelled deps, never on null
3. Stale index entries (pointing to missing blobs) are cleaned up safely
4. All existing ATC functionality (dispatch, timeout, retry, project detection) unchanged
5. Build and type check pass
