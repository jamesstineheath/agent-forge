<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix Stale Work Item Index: Ready Items Showing as Filed in List

## Metadata
- **Branch:** `fix/stale-work-item-index`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/work-items.ts, lib/atc.ts, app/api/work-items/[id]/route.ts, app/api/admin/repair-index/route.ts

## Context

Work item index (`listWorkItems`) is returning stale status for items that have been updated. Three PA-targeted work items (`c0266dcd`, `77b798c2`, `43567a1d`) were set to `status: "ready"` at 2026-03-17T08:31Z but showed as `status: "filed"` in list results for 17+ hours. Direct `getWorkItem()` calls return the correct "ready" status from the blob, confirming the blob store is correct but the index is stale.

**Root cause hypothesis:** `updateWorkItem()` writes to the individual blob but may not reliably update the index blob. The index and individual item blobs are likely written in separate operations, and the index write may be failing silently or the index may be read from a separate cached/stale location.

**Architecture context (from CLAUDE.md/system map):**
- Storage is Vercel Blob (`af-data/work-items/*`)
- `lib/storage.ts` handles Vercel Blob CRUD
- `lib/work-items.ts` contains `updateWorkItem()` and `listWorkItems()`
- ATC (`lib/atc.ts`) reads the index to find dispatchable items — stale index = items never dispatched

**Impact:** ATC blocked 3 high-priority PA work items from dispatch for 17+ hours because the index reported them as `"filed"` instead of `"ready"`.

## Requirements

1. Audit `lib/work-items.ts`: find `updateWorkItem()` and `listWorkItems()` — understand how the index blob is structured and when it is written
2. Ensure `updateWorkItem()` atomically (or as close as possible) updates both the individual item blob AND the index blob
3. Add a silent-failure guard: if the index write throws, log a structured warning with the item ID and new status rather than swallowing the error
4. Add an ATC reconciliation sweep (within the existing ATC cron) that detects index/blob drift for items in non-terminal states and repairs them
5. Add an admin API endpoint `POST /api/admin/repair-index` that manually triggers the full reconciliation sweep (auth-protected)
6. The fix must not break existing tests (`npm test` passes)
7. TypeScript must compile cleanly (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/stale-work-item-index
```

### Step 1: Audit the current index write path

Read the relevant source files in full:

```bash
cat lib/work-items.ts
cat lib/storage.ts
cat lib/atc.ts
```

Look for:
- How `listWorkItems()` fetches items — does it read a single index blob, list all blobs, or both?
- Where `updateWorkItem()` writes — does it update an index blob separately from the item blob?
- Any `try/catch` blocks that could silently swallow index write failures
- Any caching (in-memory Map, module-level cache, etc.) that could serve stale data

Document your findings as inline comments in the code where you make changes.

### Step 2: Fix `updateWorkItem()` to reliably update the index

In `lib/work-items.ts`, modify `updateWorkItem()` so that:

1. **The individual item blob is written first** (as it is now — this is the source of truth)
2. **The index is then updated** with the new item's status/metadata
3. **Index write failures are not silently swallowed** — log a structured warning:

```typescript
console.warn('[work-items] index write failed for item', {
  id: item.id,
  newStatus: item.status,
  error: err instanceof Error ? err.message : String(err),
});
```

The exact implementation depends on what you find in Step 1. Common patterns:

**Pattern A — Index is a separate JSON blob (`af-data/work-items/_index.json`):**
```typescript
// After writing individual item blob:
try {
  const index = await readIndexBlob(); // fetch current index
  const updated = { ...index, [item.id]: { id: item.id, status: item.status, updatedAt: item.updatedAt } };
  await writeIndexBlob(updated);
} catch (err) {
  console.warn('[work-items] index write failed for item', { id: item.id, newStatus: item.status, error: String(err) });
}
```

**Pattern B — `listWorkItems()` lists all blobs (no separate index):**
If there is no separate index and `listWorkItems()` calls Vercel Blob `list()`, the bug may be Vercel Blob's own eventual consistency or a module-level in-memory cache. In this case:
- Remove any module-level cache or add a `Date.now()` cache-busting parameter to list calls
- Add a `revalidate: 0` or equivalent to force fresh reads

**Pattern C — In-memory cache:**
If there is an in-memory `Map` or module-level variable caching the list, invalidate it in `updateWorkItem()`:
```typescript
// At module level:
let workItemCache: WorkItem[] | null = null;

// In updateWorkItem(), after writing:
workItemCache = null; // invalidate
```

### Step 3: Add reconciliation function

Add a `reconcileWorkItemIndex()` function to `lib/work-items.ts`:

```typescript
/**
 * Reconciles the work item index against individual item blobs.
 * For each non-terminal item in the index, reads the individual blob
 * and repairs the index entry if the status differs.
 * Returns a summary of repaired items.
 */
export async function reconcileWorkItemIndex(): Promise<{
  checked: number;
  repaired: number;
  repairedItems: Array<{ id: string; indexStatus: string; blobStatus: string }>;
}> {
  // 1. Read all items from index (however listWorkItems works)
  // 2. For each item NOT in a terminal state (merged, parked, failed, cancelled):
  //    a. Fetch the individual blob directly
  //    b. If blob.status !== index.status, update index entry
  // 3. Return summary
  
  const terminalStates = new Set(['merged', 'parked', 'failed', 'cancelled']);
  const allItems = await listWorkItems(); // existing function
  const repaired: Array<{ id: string; indexStatus: string; blobStatus: string }> = [];

  for (const indexItem of allItems) {
    if (terminalStates.has(indexItem.status)) continue;
    try {
      const blobItem = await getWorkItem(indexItem.id); // direct blob read
      if (blobItem && blobItem.status !== indexItem.status) {
        console.warn('[work-items] index/blob drift detected', {
          id: indexItem.id,
          indexStatus: indexItem.status,
          blobStatus: blobItem.status,
        });
        // Update the index to match the blob (source of truth)
        await writeItemToIndex(blobItem); // use whatever internal index write function exists
        repaired.push({ id: indexItem.id, indexStatus: indexItem.status, blobStatus: blobItem.status });
      }
    } catch (err) {
      console.error('[work-items] reconcile error for item', indexItem.id, err);
    }
  }

  return { checked: allItems.length, repaired: repaired.length, repairedItems: repaired };
}
```

Adapt this skeleton to match the actual storage patterns you find in Step 1.

### Step 4: Wire reconciliation into ATC

In `lib/atc.ts`, add a reconciliation step early in the ATC cron cycle (before dispatch logic):

```typescript
import { reconcileWorkItemIndex } from './work-items';

// Inside the main ATC cycle function, near the top (after acquiring locks if any):
try {
  const reconcileResult = await reconcileWorkItemIndex();
  if (reconcileResult.repaired > 0) {
    console.warn('[ATC] index reconciliation repaired items', reconcileResult);
  }
} catch (err) {
  console.error('[ATC] index reconciliation failed', err);
  // Non-fatal: continue with ATC cycle
}
```

Place this after any dedup guards but before dispatch logic so that repaired items are visible in the same ATC cycle.

### Step 5: Add admin repair endpoint

Create `app/api/admin/repair-index/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { reconcileWorkItemIndex } from '@/lib/work-items';

export async function POST() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await reconcileWorkItemIndex();
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('[admin/repair-index] reconciliation failed', err);
    return NextResponse.json(
      { error: 'Reconciliation failed', details: String(err) },
      { status: 500 }
    );
  }
}
```

### Step 6: Immediately repair the three known-drifted items

After deploying the fix, the ATC reconciliation will repair items automatically on the next cron cycle. However, to handle the three known-drifted items (`c0266dcd`, `77b798c2`, `43567a1d`) proactively, add a one-time repair call in the reconciliation logic (the ATC sweep in Step 4 will handle this automatically once deployed — no additional code needed, but verify these items exist and are non-terminal so they will be swept).

### Step 7: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build

# Tests
npm test
```

Fix any TypeScript errors or test failures before committing. If tests don't exist for `work-items.ts`, that's acceptable — don't add tests (budget is $5).

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "fix: ensure updateWorkItem atomically updates index blob and add reconciliation sweep"
git push origin fix/stale-work-item-index
gh pr create \
  --title "fix: stale work item index — ready items showing as filed" \
  --body "## Problem
Work item index was returning stale status for items updated via \`updateWorkItem()\`. Three PA-targeted items (\`c0266dcd\`, \`77b798c2\`, \`43567a1d\`) were set to \`status: \"ready\"\` but showed as \`\"filed\"\` in list results for 17+ hours, blocking ATC dispatch.

## Root Cause
[Describe what you found in Step 1 — index write path not reliably updating / silent failure / cache issue]

## Fix
- **\`lib/work-items.ts\`**: Ensured \`updateWorkItem()\` reliably updates the index blob and logs a warning on index write failure instead of silently swallowing errors
- **\`lib/work-items.ts\`**: Added \`reconcileWorkItemIndex()\` — scans non-terminal items, detects index/blob drift, repairs in place
- **\`lib/atc.ts\`**: Added reconciliation sweep at the start of each ATC cycle so drift is auto-repaired within one cron interval
- **\`app/api/admin/repair-index/route.ts\`**: Added auth-protected admin endpoint to trigger manual reconciliation

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- \`npm test\` passes

## Impact
ATC will now detect and repair index/blob drift on every cron cycle. The three blocked PA work items will be repaired on the next ATC run after deploy."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/stale-work-item-index
FILES CHANGED: [list files actually modified]
SUMMARY: [what was done — e.g., "Fixed updateWorkItem index write, added reconcileWorkItemIndex, wired into ATC"]
ISSUES: [what failed — e.g., "Could not determine index structure, Pattern A/B/C unclear"]
NEXT STEPS: [what remains — e.g., "Wire reconciliation into ATC cycle, add admin endpoint"]
```

If the index structure is fundamentally different from all three patterns described and you cannot determine the fix without human input, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-stale-work-item-index",
    "reason": "Cannot determine index write path from source — storage pattern does not match any of Pattern A/B/C. Human review of lib/work-items.ts and lib/storage.ts required.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "Index structure unclear — cannot safely modify write path without understanding storage contract",
      "filesChanged": []
    }
  }'
```