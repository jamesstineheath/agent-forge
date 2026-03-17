# Agent Forge -- Add ATC Section 4 — project retry processing

## Metadata
- **Branch:** `feat/atc-section-4-project-retry`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts, lib/projects.ts, lib/work-items.ts

## Context

The ATC (Air Traffic Controller) in `lib/atc.ts` runs a cron cycle that manages the work item pipeline. Currently around line 444 there is work-item retry logic, and around line 446 there is project decomposition logic (§4.5) that detects Notion projects with `Status = "Execute"` and decomposes them into work items.

We need to insert a new **Section 4** between those two blocks that processes project retry requests. When a project retry is triggered (e.g., via Notion checkbox `Retry=true`), the ATC should:
1. Check if the project has hit the retry cap (3 retries)
2. Clear the dedup guard so §4.5 can re-decompose the project
3. Cancel stale work items from the previous attempt (but leave in-flight items alone)
4. Reset the Retry flag and increment the retry counter

This relies on three functions already expected in `lib/projects.ts`:
- `getRetryProjects()` — returns projects where Retry=true
- `clearRetryFlag(projectId, retryCount)` — unchecks Retry, increments count, sets status to Execute
- `markProjectFailedFromRetry(projectId)` — transitions project to Failed

The `deleteJson` utility from `lib/storage.ts` is used for dedup guard cleanup. Work item queries and updates follow existing patterns in `lib/work-items.ts`.

## Requirements

1. A new ATC section (labeled §4 in comments) is inserted in `lib/atc.ts` between the work-item retry logic (~line 444) and the existing §4.5 project decomposition logic (~line 446).
2. The section calls `getRetryProjects()` and iterates over results.
3. For each retry project, if `retryCount >= 3`, call `markProjectFailedFromRetry(projectId)`, log an event indicating cap exceeded, and skip further processing for that project.
4. For eligible retry projects: delete the dedup guard at `atc/project-decomposed/{projectId}`.
5. Cancel all work items for the project in states `['failed', 'parked', 'blocked', 'ready', 'filed', 'queued']`; leave items in `['executing', 'reviewing', 'merged']` untouched.
6. Call `clearRetryFlag(projectId, retryCount)` to reset the retry flag.
7. Log a `project_retry` ATC event with project ID, new retry count, and cancelled item count.
8. If `getRetryProjects`, `clearRetryFlag`, or `markProjectFailedFromRetry` don't exist in `lib/projects.ts`, add stub implementations that satisfy the TypeScript interface.
9. `npx tsc --noEmit` passes with no errors.
10. `npm run build` passes.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-section-4-project-retry
```

### Step 1: Inspect existing code structure

Before editing, read the relevant files to understand exact line numbers, types, and patterns:

```bash
# Understand the ATC cycle structure around lines 420-480
sed -n '400,520p' lib/atc.ts

# Understand the ATCEvent type and action ledger logging pattern
grep -n 'ATCEvent\|actionLedger\|logEvent\|project_retry\|project_decomposed\|deleteJson' lib/atc.ts | head -60

# Check imports in atc.ts
head -60 lib/atc.ts

# Check what's exported from lib/projects.ts
grep -n 'export\|getRetryProjects\|clearRetryFlag\|markProjectFailedFromRetry' lib/projects.ts | head -40

# Check work item query patterns
grep -n 'getWorkItems\|listWorkItems\|updateWorkItem\|WorkItemStatus\|status.*cancel' lib/work-items.ts | head -40

# Check deleteJson signature
grep -n 'deleteJson\|export.*delete' lib/storage.ts | head -20

# Check the WorkItem and Project types
grep -n 'retryCount\|Retry\|projectId\|WorkItemStatus' lib/types.ts | head -40
```

### Step 2: Verify or add required functions in lib/projects.ts

Check if `getRetryProjects`, `clearRetryFlag`, and `markProjectFailedFromRetry` exist:

```bash
grep -n 'getRetryProjects\|clearRetryFlag\|markProjectFailedFromRetry' lib/projects.ts
```

**If any are missing**, add them to `lib/projects.ts`. Use the existing project update/fetch patterns in that file. The stubs should:

- `getRetryProjects()`: Query projects (from Notion or Vercel Blob depending on existing pattern) where `retry === true`. Return an array of objects with at minimum `{ projectId: string, retryCount: number }`.
- `clearRetryFlag(projectId: string, retryCount: number)`: Set `retry = false`, `retryCount = retryCount + 1`, `status = 'Execute'` for the project.
- `markProjectFailedFromRetry(projectId: string)`: Set project status to `'Failed'`.

Look at existing functions like `transitionProjectToComplete` or `transitionProjectToFailed` in `lib/projects.ts` for the exact update pattern to replicate.

Example pattern (adapt to match actual code style):
```typescript
export async function getRetryProjects(): Promise<Array<{ projectId: string; retryCount: number }>> {
  // Use existing project listing mechanism
  const projects = await listProjects(); // or fetchProjects() — match existing pattern
  return projects
    .filter((p) => p.retry === true)
    .map((p) => ({ projectId: p.id, retryCount: p.retryCount ?? 0 }));
}

export async function clearRetryFlag(projectId: string, retryCount: number): Promise<void> {
  // Use existing update pattern — match how other functions update project fields
  await updateProject(projectId, {
    retry: false,
    retryCount: retryCount + 1,
    status: 'Execute',
  });
}

export async function markProjectFailedFromRetry(projectId: string): Promise<void> {
  // Use existing failed transition pattern
  await updateProject(projectId, { status: 'Failed' });
}
```

**Important:** Use whatever internal function names and patterns already exist in `lib/projects.ts`. Do not invent new storage patterns — mirror exactly what's already there.

### Step 3: Add imports to lib/atc.ts

Open `lib/atc.ts` and ensure the following are imported:

1. Add `getRetryProjects`, `clearRetryFlag`, `markProjectFailedFromRetry` to the import from `'./projects'` (or `'@/lib/projects'` — match the existing import style).
2. Verify `deleteJson` is already imported from `'./storage'` (or add it if missing).
3. Verify work item query and update functions are already imported (e.g., `getWorkItemsByProject` or equivalent, `updateWorkItem`).

```bash
# Check current imports
head -40 lib/atc.ts
grep -n "from.*projects\|from.*storage\|from.*work-items" lib/atc.ts
```

Add or update the imports as needed. Example (adapt to match existing import style):

```typescript
// In the projects import line, add:
import { /* existing imports */, getRetryProjects, clearRetryFlag, markProjectFailedFromRetry } from './projects';

// Ensure deleteJson is imported from storage:
import { /* existing imports */, deleteJson } from './storage';
```

### Step 4: Insert Section 4 in lib/atc.ts

Find the exact insertion point — between work-item retry logic and the §4.5 project decomposition comment. Look for a comment like `// §4.5` or `// Section 4.5` or `// Project decomposition`.

Insert the following block **before** the §4.5 block. Adapt variable names to match existing patterns in the file (e.g., how events are logged, how work items are queried):

```typescript
  // §4 — Project retry processing
  // Process projects flagged for retry before decomposition picks them up
  try {
    const retryProjects = await getRetryProjects();
    log(`ATC §4: found ${retryProjects.length} project(s) flagged for retry`);

    for (const { projectId, retryCount } of retryProjects) {
      // Check retry cap
      if (retryCount >= 3) {
        log(`ATC §4: project ${projectId} has hit retry cap (retryCount=${retryCount}), marking failed`);
        await markProjectFailedFromRetry(projectId);
        // Log ATC event — match existing event logging pattern
        await logATCEvent({
          type: 'project_retry',
          projectId,
          detail: `retry cap exceeded (retryCount=${retryCount})`,
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Clear the dedup guard so §4.5 will re-decompose this project
      try {
        await deleteJson(`atc/project-decomposed/${projectId}`);
        log(`ATC §4: cleared dedup guard for project ${projectId}`);
      } catch (err) {
        // Guard may not exist; not an error
        log(`ATC §4: no dedup guard to clear for project ${projectId} (ok)`);
      }

      // Cancel stale work items from previous attempt
      const staleStates: WorkItemStatus[] = ['failed', 'parked', 'blocked', 'ready', 'filed', 'queued'];
      // Use existing work item list/query pattern for this project
      const projectItems = await getWorkItemsByProject(projectId); // adapt to actual function name
      const itemsToCancel = projectItems.filter((item) => staleStates.includes(item.status));

      for (const item of itemsToCancel) {
        await updateWorkItem(item.id, { status: 'cancelled' }); // adapt to actual update signature
      }
      log(`ATC §4: cancelled ${itemsToCancel.length} stale work items for project ${projectId}`);

      // Reset retry flag, increment count, set status to Execute
      await clearRetryFlag(projectId, retryCount);

      // Log ATC event
      await logATCEvent({
        type: 'project_retry',
        projectId,
        detail: `retry initiated (newRetryCount=${retryCount + 1}, cancelledItems=${itemsToCancel.length})`,
        timestamp: new Date().toISOString(),
      });

      log(`ATC §4: project ${projectId} reset for retry (attempt ${retryCount + 1})`);
    }
  } catch (err) {
    log(`ATC §4 error: ${String(err)}`);
  }

  // §4.5 — [existing project decomposition code follows unchanged]
```

**Critical:** 
- Adapt `logATCEvent`, `getWorkItemsByProject`, `updateWorkItem`, and `WorkItemStatus` to match the **exact** function and type names already used in `lib/atc.ts`. Do not introduce new patterns.
- If work items for a project are fetched differently (e.g., via `listWorkItems({ projectId })` or `getWorkItems().filter(...)`), use that pattern.
- If events are logged differently (e.g., appended to an array, written to a file, or sent to a different function), use that exact pattern.
- The `'cancelled'` status value: verify this is a valid `WorkItemStatus` in `lib/types.ts`. If the valid cancellation status is named differently (e.g., `'canceled'` one-l), use the correct spelling.

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors:
- If `WorkItemStatus` doesn't include `'cancelled'`, check `lib/types.ts` for the correct status name and update the `staleStates` array and `updateWorkItem` call accordingly.
- If `deleteJson` doesn't exist in `lib/storage.ts`, look for `deleteBlob`, `removeJson`, or similar and use that.
- If the `ATCEvent` type requires different fields than used above, align the logged object with the actual type definition.

### Step 6: Build verification

```bash
npm run build
```

Fix any build errors before proceeding.

### Step 7: Sanity check the insertion

```bash
# Confirm the new section is present and ordered correctly
grep -n '§4\|§4.5\|project_retry\|getRetryProjects\|clearRetryFlag\|markProjectFailedFromRetry' lib/atc.ts
```

Verify the output shows:
- `§4` comment appears before `§4.5` comment
- `getRetryProjects` called within §4 block
- `clearRetryFlag` and `markProjectFailedFromRetry` called within §4 block

### Step 8: Final verification

```bash
npx tsc --noEmit
npm run build
```

Both must pass with zero errors.

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add ATC Section 4 — project retry processing"
git push origin feat/atc-section-4-project-retry
gh pr create \
  --title "feat: add ATC Section 4 — project retry processing" \
  --body "## Summary

Inserts a new §4 block in the ATC cycle (\`lib/atc.ts\`) between work-item retry logic and the existing §4.5 project decomposition section.

## Changes

### \`lib/atc.ts\`
- Added §4 — Project retry processing block
- Imports \`getRetryProjects\`, \`clearRetryFlag\`, \`markProjectFailedFromRetry\` from \`lib/projects\`
- For each project with Retry=true:
  - If retryCount >= 3: marks project Failed, logs cap-exceeded event, skips
  - Otherwise: deletes dedup guard at \`atc/project-decomposed/{projectId}\`, cancels stale work items (failed/parked/blocked/ready/filed/queued), calls clearRetryFlag, logs project_retry event
- §4.5 project decomposition then naturally picks up projects reset to Execute status

### \`lib/projects.ts\` (if modified)
- Added \`getRetryProjects()\`, \`clearRetryFlag()\`, \`markProjectFailedFromRetry()\` if they were missing

## Acceptance Criteria
- [x] ATC cycle queries for retry projects before §4.5
- [x] Projects with retryCount >= 3 transitioned to Failed
- [x] Dedup guard deleted for retried projects
- [x] Stale work items cancelled; executing/reviewing/merged left untouched
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-section-4-project-retry
FILES CHANGED: [list files modified]
SUMMARY: [what was completed]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "getRetryProjects not found in lib/projects.ts, needs implementation"]
```

## Escalation

If you encounter a blocker you cannot resolve (e.g., `getRetryProjects` / `clearRetryFlag` / `markProjectFailedFromRetry` don't exist and you cannot determine the correct Notion/storage pattern to implement them from the existing code, or the ATC event logging mechanism is opaque):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-atc-section-4-project-retry",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts", "lib/projects.ts"]
    }
  }'
```