# Agent Forge -- Conflict Detection + Failure Handling

## Metadata
- **Branch:** `feat/conflict-detection`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts, lib/types.ts, lib/github.ts, lib/work-items.ts
- **Dependencies:** Requires 05-queue-management to be merged first (auto-dispatch must exist for conflict checks to gate it).

## Context

With auto-dispatch enabled (handoff 05), the ATC needs two safety layers:

1. **Conflict detection:** If two work items modify overlapping files, running them concurrently causes merge conflicts. The ATC should detect this before dispatching and hold conflicting items until the first execution completes.

2. **Failure handling:** Currently, a failed execution just sits in "failed" status forever. The ATC should retry transient failures (workflow timeout, GitHub API blip) up to 2 times, then park items that fail persistently.

Current state of active execution tracking (lib/types.ts, ATCState):
```typescript
activeExecutions: {
  workItemId: string;
  targetRepo: string;
  branch: string;
  status: string;
  startedAt: string;
  elapsedMinutes: number;
}[]
```

This lacks `filesBeingModified`. We need to add it and populate it from either:
- The PR's changed files list (via GitHub API, `GET /repos/{owner}/{repo}/pulls/{number}/files`)
- The handoff file's "Estimated files" metadata field

The PR files approach is more accurate but only available once a PR exists (i.e., during "reviewing" status). The handoff metadata is available immediately but is an estimate. We use both: handoff estimate during "executing", PR files during "reviewing".

For failure handling, we need to track retry state. Add `retryCount` and `lastFailedAt` to the WorkItem execution metadata. The ATC checks: if a failed item has retryCount < 2, reset it to "ready" for re-dispatch. If retryCount >= 2, set status to "parked".

Key files:
- `lib/types.ts` -- Add `filesBeingModified` to ATCState active execution. Add `conflict` and `retry` to ATCEvent types. Add `retryCount` to execution metadata.
- `lib/github.ts` -- Add `getPRFiles(repo, prNumber)` function.
- `lib/atc.ts` -- Add conflict check before auto-dispatch. Add failure retry logic after state transition processing.
- `lib/work-items.ts` -- No changes needed (updateWorkItem already handles execution metadata).

## Requirements

1. ATCState `activeExecutions` entries gain a `filesBeingModified: string[]` field.
2. During ATC cycle, populate `filesBeingModified` from PR files (if PR exists) or from the handoff content's "Estimated files" metadata line (regex parse).
3. Before auto-dispatching an item, check if any of its estimated files overlap with any active execution's `filesBeingModified` in the same repo. If overlap, skip dispatch and log a `conflict` event.
4. WorkItem `execution` type gains optional `retryCount: number` (default 0).
5. After ATC processes state transitions, scan for recently failed items (failed this cycle). If retryCount < 2: increment retryCount, set status back to "ready", log a `retry` event. If retryCount >= 2: set status to "parked", log a `parked` event.
6. ATCEvent type union gains `"conflict"`, `"retry"`, and `"parked"`.
7. Add `getPRFiles(repo: string, prNumber: number): Promise<string[]>` to lib/github.ts.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/conflict-detection
```

### Step 1: Update types

In `lib/types.ts`:

Add to ATCEvent type union:
```typescript
type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error";
```

Add `filesBeingModified` to ATCState active execution:
```typescript
activeExecutions: {
  workItemId: string;
  targetRepo: string;
  branch: string;
  status: string;
  startedAt: string;
  elapsedMinutes: number;
  filesBeingModified: string[];
}[]
```

Add `retryCount` to the WorkItem execution type:
```typescript
execution: {
  workflowRunId?: number;
  prNumber?: number;
  prUrl?: string;
  startedAt?: string;
  completedAt?: string;
  outcome?: "merged" | "failed" | "parked" | "reverted";
  retryCount?: number;
} | null;
```

Also update the `updateWorkItemSchema` execution object to include:
```typescript
retryCount: z.number().optional(),
```

### Step 2: Add getPRFiles to github.ts

In `lib/github.ts`, add:
```typescript
export async function getPRFiles(repo: string, prNumber: number): Promise<string[]> {
  const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
  const res = await ghFetch(url);
  if (!res.ok) return [];
  const files = (await res.json()) as Array<{ filename: string }>;
  return files.map(f => f.filename);
}
```

### Step 3: Add file overlap detection helpers to atc.ts

In `lib/atc.ts`, add helper functions:

```typescript
function parseEstimatedFiles(handoffContent: string): string[] {
  // Parse "Estimated files:" line from handoff metadata
  const match = handoffContent.match(/\*\*Estimated files:\*\*\s*(.+)/i);
  if (!match) return [];
  return match[1].split(",").map(f => f.trim()).filter(Boolean);
}

function hasFileOverlap(filesA: string[], filesB: string[]): boolean {
  const setB = new Set(filesB);
  return filesA.some(f => setB.has(f));
}
```

### Step 4: Populate filesBeingModified in ATC cycle

When building the `activeExecutions` array in `runATCCycle`, fetch files for each active item:

```typescript
// After fetching pr for each active item:
let filesBeingModified: string[] = [];
if (pr && item.execution?.prNumber) {
  filesBeingModified = await getPRFiles(item.targetRepo, item.execution.prNumber);
} else if (item.handoff?.content) {
  filesBeingModified = parseEstimatedFiles(item.handoff.content);
}

activeExecutions.push({
  workItemId: item.id,
  targetRepo: item.targetRepo,
  branch,
  status: item.status,
  startedAt: startedAt ?? now.toISOString(),
  elapsedMinutes: Math.round(elapsedMinutes),
  filesBeingModified,
});
```

### Step 5: Add conflict check to auto-dispatch section

In the auto-dispatch loop (added by handoff 05), before calling `dispatchWorkItem`, check for file conflicts:

```typescript
// Before dispatching nextItem:
const nextItemFiles = nextItem.handoff?.content
  ? parseEstimatedFiles(nextItem.handoff.content)
  : [];

const repoActiveExecs = activeExecutions.filter(e => e.targetRepo === repo.fullName);
const conflicting = repoActiveExecs.find(e => hasFileOverlap(nextItemFiles, e.filesBeingModified));

if (conflicting) {
  events.push(makeEvent(
    "conflict", nextItem.id, undefined, undefined,
    `Dispatch blocked: file overlap with active item ${conflicting.workItemId} in ${repo.fullName}`
  ));
  continue; // Skip this repo, try next
}
```

Note: For items that haven't had a handoff generated yet (status "ready", no handoff content), `parseEstimatedFiles` returns `[]` and the conflict check passes. This is intentional: the handoff hasn't been generated yet, so we can't know the files. The Spec Reviewer in the target repo is the second gate.

### Step 6: Add failure retry logic

After processing all active items (the main for loop), add a new section:

```typescript
// 3.5: Retry failed items (max 2 retries, then park)
const MAX_RETRIES = 2;
const failedThisCycle = events
  .filter(e => e.newStatus === "failed" && e.type !== "error")
  .map(e => e.workItemId);

for (const failedId of failedThisCycle) {
  const item = await getWorkItem(failedId);
  if (!item) continue;
  const retryCount = item.execution?.retryCount ?? 0;

  if (retryCount < MAX_RETRIES) {
    await updateWorkItem(failedId, {
      status: "ready",
      execution: {
        ...item.execution,
        retryCount: retryCount + 1,
        completedAt: undefined,
        outcome: undefined,
      },
    });
    events.push(makeEvent(
      "retry", failedId, "failed", "ready",
      `Retry ${retryCount + 1}/${MAX_RETRIES}: resetting to ready for re-dispatch`
    ));
  } else {
    await updateWorkItem(failedId, {
      status: "parked",
      execution: {
        ...item.execution,
        outcome: "parked",
      },
    });
    events.push(makeEvent(
      "parked", failedId, "failed", "parked",
      `Parked after ${retryCount} retries. Requires human attention.`
    ));
  }
}
```

### Step 7: Verification
```bash
npx tsc --noEmit
npm run build
```

### Step 8: Commit, push, open PR
```bash
git add -A
git commit -m "feat: conflict detection + failure handling in ATC

Adds file-overlap conflict detection to prevent concurrent executions
from modifying the same files. Adds retry logic (max 2 retries) for
transient failures, with automatic parking for persistent failures.

New event types: conflict, retry, parked."
git push origin feat/conflict-detection
gh pr create --title "feat: conflict detection + failure handling" --body "## Summary
- File-overlap conflict detection blocks dispatch when active executions touch the same files
- Files sourced from PR diff (reviewing status) or handoff metadata (executing status)
- Failed items auto-retry up to 2 times, then park for human attention
- New ATCEvent types: conflict, retry, parked
- retryCount tracked in work item execution metadata

## Files Changed
- lib/types.ts (ATCEvent types, ATCState.filesBeingModified, execution.retryCount)
- lib/github.ts (getPRFiles helper)
- lib/atc.ts (conflict detection, retry logic, file population)

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Medium. Conflict detection is conservative (blocks on any file overlap). Retry logic resets items to ready, which the next ATC cycle will re-dispatch.

## Dependencies
Requires 05-queue-management (auto-dispatch) to be merged first."
```

### Step 9: Auto-merge
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
BRANCH: feat/conflict-detection
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
