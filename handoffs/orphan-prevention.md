# Handoff: Harden pipeline against orphaned and permanently-stuck work items

**Repo:** `agent-forge`
**Branch:** `fix/orphan-prevention`
**Mode:** Explore/Fix
**Model:** Sonnet
**Max Budget:** $5

## Problem

The pipeline had 11 orphaned work items from a dedup bug that blocked dispatch for days. While the dedup guard (PR #25) prevents re-decomposition, three gaps remain that can cause the same class of problem:

1. Work items with permanently unresolvable dependencies (deps pointing to failed/parked/cancelled/deleted items) sit in the queue forever, consuming capacity and blocking downstream items.
2. Dangling Blob entries (work item blobs not in the index) are never detected or cleaned.
3. The dedup guard in ATC section 4.5 scans all work items with individual `getWorkItem()` calls, which is O(n) Blob reads per project per cycle.

## Changes

### 1. Dead dependency auto-cancellation (ATC section 4.1)

In `lib/atc.ts`, after the existing dependency_block event logging in section 4.1, add logic to detect permanently blocked items and auto-cancel them:

```typescript
// After the existing dependency_block detection loop:
// Check if blocking deps are permanently unresolvable
const TERMINAL_FAILURE_STATUSES = ["failed", "parked", "cancelled"];
for (const item of blocked) {
  const deadDeps: string[] = [];
  for (const depId of item.dependencies) {
    const dep = await getWorkItem(depId);
    if (!dep) {
      // Dependency was deleted - permanently unresolvable
      deadDeps.push(depId);
    } else if (TERMINAL_FAILURE_STATUSES.includes(dep.status)) {
      // Dependency failed/parked/cancelled - will never reach "merged"
      deadDeps.push(depId);
    }
  }

  if (deadDeps.length > 0) {
    await updateWorkItem(item.id, { status: "cancelled" as any });
    events.push(makeEvent(
      "auto_cancel", item.id, item.status, "cancelled",
      `Auto-cancelled: ${deadDeps.length} dead dependency(ies) [${deadDeps.join(", ")}]`
    ));
  }
}
```

This cascades: if item A depends on item B which failed, A gets cancelled. If item C depends on A, next cycle C gets cancelled too. The cascade naturally propagates through the dependency DAG.

**Important:** The `WorkItem` type in `lib/types.ts` may not include `"cancelled"` as a valid status. Check and add it if needed. Also update the terminal status check in Section 13 (project completion) to include `"cancelled"`.

### 2. Blob-index reconciliation (new ATC section, run periodically)

Add a new section to `runATCCycle()` (after section 8, branch cleanup) that reconciles the work-item index with actual Blob contents. Throttle to once per hour like branch cleanup.

```typescript
// Section 9.5: Work item blob-index reconciliation (hourly)
const RECONCILIATION_KEY = "atc/last-reconciliation";
const reconLast = await loadJson<{ lastRunAt: string }>(RECONCILIATION_KEY);
const reconElapsed = reconLast
  ? (now.getTime() - new Date(reconLast.lastRunAt).getTime()) / 60_000
  : Infinity;

if (reconElapsed >= 60) {
  try {
    const { list } = await import("@vercel/blob");
    const { blobs } = await list({ prefix: "af-data/work-items/", mode: "folded" });
    const blobIds = new Set(
      blobs.map(b => b.pathname.replace("af-data/work-items/", "").replace(".json", ""))
    );

    const indexEntries = await listWorkItems({});
    const indexIds = new Set(indexEntries.map(e => e.id));

    // Find dangling blobs (in blob store but not in index)
    const danglingIds = [...blobIds].filter(id => !indexIds.has(id));
    if (danglingIds.length > 0) {
      for (const id of danglingIds) {
        await deleteJson(`work-items/${id}`);
      }
      events.push(makeEvent(
        "cleanup", "system", undefined, undefined,
        `Blob reconciliation: deleted ${danglingIds.length} dangling work-item blob(s)`
      ));
    }

    await saveJson(RECONCILIATION_KEY, { lastRunAt: now.toISOString() });
  } catch (err) {
    console.error("[atc] Blob-index reconciliation failed:", err);
  }
}
```

**Note:** Check how `@vercel/blob` `list()` works in the codebase. The existing `lib/storage.ts` may already have a list function, or you may need to use the Blob SDK directly. Adapt the import and API to match.

### 3. Efficient project dedup guard (ATC section 4.5)

Replace the O(n) scan in section 4.5 with a dedicated dedup key per project:

```typescript
// Replace the existing dedup guard block with:
const dedupKey = `atc/project-decomposed/${project.projectId}`;
const alreadyDecomposed = await loadJson<{ decomposedAt: string }>(dedupKey);
if (alreadyDecomposed) {
  events.push(makeEvent(
    "project_trigger", project.projectId, undefined, undefined,
    `Dedup guard: project "${project.title}" already decomposed at ${alreadyDecomposed.decomposedAt}, skipping`
  ));
  continue;
}

// After successful decomposition (after the workItems.length check), save the dedup key:
await saveJson(dedupKey, { decomposedAt: now.toISOString(), workItemCount: workItems.length });
```

This is O(1) instead of O(n) and doesn't depend on the work-item index being consistent.

## Steps

### Step 0: Branch + setup
```bash
git checkout main && git pull
git checkout -b fix/orphan-prevention
```

### Step 1: Check types
Read `lib/types.ts` and confirm whether `"cancelled"` is a valid `WorkItem` status. If not, add it to the status union type.

### Step 2: Implement dead dependency auto-cancellation
Edit `lib/atc.ts` section 4.1. Add the dead dependency detection and auto-cancel logic after the existing `dependency_block` event loop.

### Step 3: Implement blob-index reconciliation
Add a new section to `lib/atc.ts` between the branch cleanup (section 8) and escalation monitoring (section 10). Include hourly throttling. Check `lib/storage.ts` for existing list/delete functions before importing `@vercel/blob` directly.

### Step 4: Replace dedup guard
In section 4.5, replace the O(n) work-item scan with the dedicated dedup key approach. Save the key after successful decomposition.

### Step 5: Update Section 13
In the project completion detection section, ensure `"cancelled"` is included in the `terminalStatuses` array alongside `"merged"`, `"parked"`, `"failed"`.

### Step 6: Verify TypeScript compiles
```bash
npx tsc --noEmit
```

### Step 7: Commit and push
```bash
git add lib/atc.ts lib/types.ts
git commit -m "fix: dead dependency auto-cancel, blob-index reconciliation, efficient dedup guard

- Auto-cancel work items with permanently unresolvable dependencies
  (deps that are failed, parked, cancelled, or deleted). Cascades
  through the DAG naturally across ATC cycles.
- Hourly blob-index reconciliation detects and deletes dangling
  work-item blobs not tracked in the index.
- Replace O(n) dedup guard in section 4.5 with O(1) dedicated
  project dedup key.
- Add 'cancelled' to terminal statuses in Section 13."
git push -u origin fix/orphan-prevention
```

## Pre-flight self-check
- [ ] `"cancelled"` added to WorkItem status type if not already present
- [ ] Dead dependency detection cascades correctly (item with dead dep -> cancelled -> dependents cancelled next cycle)
- [ ] Blob reconciliation only runs hourly (throttle key check)
- [ ] Dedup key saved after successful decomposition, not before
- [ ] Section 13 includes `"cancelled"` in terminal statuses
- [ ] No TypeScript errors
- [ ] No changes to existing passing behavior (existing tests still pass if any)

## Abort protocol
If the `@vercel/blob` list API doesn't work as expected for the reconciliation section, skip it and ship the other two changes. The dead dependency auto-cancel is the highest-value fix.
