# Handoff: ATC Dedup Guard + Orphan Cleanup + Debug Endpoint Removal

Max Budget: $5

## Context

Session 42 fixed the Blob auth bug that caused 0-item decompositions. After the fix, the ATC re-decomposed both PRJ-1 and PRJ-2 successfully. However, due to a missing dedup guard in ATC Section 4.5, each project was decomposed TWICE on consecutive cron cycles (Notion status propagation race). This created 22 work items instead of 11. The duplicate (newer) set is executing correctly; the original set has failed lead items with permanently blocked dependents.

Additionally, three debug endpoints were added during Sessions 38-42 and should now be removed.

## Pre-flight Self-check

- [ ] Read `lib/atc.ts` Section 4.5 (around line 200-240)
- [ ] Read `lib/work-items.ts` to understand `listWorkItems` filter options
- [ ] Read `lib/types.ts` for WorkItem shape (especially `source.type` and `source.sourceId`)
- [ ] Confirm the three debug endpoint files exist before deleting

## Step 0: Branch + Commit Setup

Branch: `fix/atc-dedup-guard-cleanup` (already created)
Base: `main` at `c8f9b92`

## Step 1: Add Dedup Guard to ATC Section 4.5

In `lib/atc.ts`, Section 4.5, after `const success = await transitionToExecuting(project)` and before the `decomposeProject()` call, add a dedup check:

```typescript
// Dedup guard: skip decomposition if work items already exist for this project
const existingItems = await listWorkItems({});
const projectItemCount = existingItems.filter(async (entry) => {
  // We need to check the full item, not just the index entry
  return false; // placeholder
}).length;
```

The correct implementation: iterate `existingItems`, call `getWorkItem(entry.id)` for each, check if `item.source.type === "project" && item.source.sourceId === project.projectId`. If any exist, log a dedup skip event and `continue` (do not decompose again).

Note: This is a performance-acceptable approach at current scale (< 50 items). At higher scale, add a `projectId` filter to `listWorkItems`.

Expected pattern:
```typescript
// Dedup guard: skip if project already has work items
const allItemEntries = await listWorkItems({});
let alreadyDecomposed = false;
for (const entry of allItemEntries) {
  const existingItem = await getWorkItem(entry.id);
  if (existingItem && existingItem.source?.type === "project" && existingItem.source?.sourceId === project.projectId) {
    alreadyDecomposed = true;
    break;
  }
}
if (alreadyDecomposed) {
  events.push(makeEvent(
    "project_trigger", project.projectId, undefined, undefined,
    `Dedup guard: project "${project.title}" already has work items, skipping decomposition`
  ));
  continue;
}
```

## Step 2: Add Orphan Cleanup API Endpoint

Create `app/api/admin/cleanup-orphans/route.ts`:

- POST endpoint, protected by Bearer token auth (`AGENT_FORGE_API_SECRET`)
- Accepts JSON body: `{ projectId: string, keepSet: "newest" | "oldest" }`
- Lists all work items for the given projectId
- Groups them by decomposition batch (using `createdAt` timestamps, items decomposed together will have timestamps within seconds of each other)
- Keeps the specified set, marks the other set's items as status `"cancelled"`
- Returns summary of cancelled items

Alternatively (simpler): accept `{ itemIds: string[] }` and mark each as `"cancelled"`. This is more explicit and less error-prone.

Add `"cancelled"` to the valid WorkItem status values in `lib/types.ts` if not already present.

## Step 3: Remove Debug Endpoints

Delete these three files:
- `app/api/debug/blob-test/route.ts`
- `app/api/debug/decomposer/route.ts`
- `app/api/debug/seed-repos/route.ts`

Also delete the parent directories if they become empty:
- `app/api/debug/blob-test/`
- `app/api/debug/decomposer/`
- `app/api/debug/seed-repos/`
- `app/api/debug/` (if empty after above)

## Step 4: Fix Section 13 Stuck-state for 0-item Projects

In `lib/atc.ts` Section 13, the current code has:
```typescript
if (projectItems.length === 0) continue;
```

This causes projects with 0 work items (failed decomposition) to stay in "Executing" forever. Fix: if a project has been in "Executing" for more than 30 minutes with 0 work items, transition it to "Failed".

```typescript
if (projectItems.length === 0) {
  // Check if project has been executing for > 30 min with no items
  // Use project's updatedAt or a stored timestamp
  // For now, leave a TODO comment noting this needs a timestamp check
  // The dedup guard in Step 1 prevents the re-decomposition that was the primary symptom
  continue;
}
```

Note: The dedup guard from Step 1 is the primary fix. The stuck-state fix is secondary since projects that fail decomposition already get transitioned to Failed in the catch block of Section 4.5. The only case that remains stuck is if `getExecuteProjects()` returns the project, `transitionToExecuting()` succeeds, but decomposition produces 0 items without throwing. Add a check after decomposition: if `workItems.length === 0`, transition to Failed.

## Step 5: Verification

- `npm run build` must pass
- `npx tsc --noEmit` must pass
- `grep -rn "debug/blob-test\|debug/decomposer\|debug/seed-repos" --include="*.ts" --include="*.tsx"` returns 0 results (no remaining references to debug endpoints)
- Verify the dedup guard logic by reading through Section 4.5 flow

## Abort Protocol

If `npm run build` fails due to type errors from the `cancelled` status addition, check that `updateWorkItemSchema` and all status union types in `lib/types.ts` include `"cancelled"`. If Section 13 changes cause cascading type issues, revert Section 13 changes and ship Steps 1-3 only.

## Acceptance Criteria

1. ATC Section 4.5 skips decomposition when project already has work items (dedup guard)
2. Debug endpoints removed (3 files deleted)
3. Admin cleanup endpoint exists for manually cancelling orphaned items
4. Zero-item decomposition results in project transitioning to Failed (not stuck in Executing)
5. Build passes
