<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- ATC Branch Cleanup Not Removing Failed Execution Branches

## Metadata
- **Branch:** `fix/atc-branch-cleanup-failed-executions`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

The ATC (Air Traffic Controller) in `lib/atc.ts` runs a periodic cleanup sweep that is supposed to delete GitHub branches for work items in terminal/failed states. However, branches from failed executions are persisting, causing a 422 "Reference already exists" loop when ATC retries dispatching those work items to the same branch name.

Known stuck branches:
- `feat/integrate-attribution-into-atc-failed-work-item-ha` (work item in failed state, no open PR)
- `feat/react-error-185-in-coach-chat-interface` (work item in failed state, no open PR)
- `fix/coach-chat-interface-locks-up-after-filing-a-bug-v` (has open PR #305 — should NOT be deleted)

Two bugs need to be fixed:
1. **Branch cleanup**: The cleanup sweep likely only handles `parked`/`cancelled` states, not `failed`. Need to add `failed` to the set of states that trigger branch deletion (when no open PR exists).
2. **Retry/reconciler conflict**: When a work item has an open PR, the reconciler correctly sets it to `reviewing`, but the retry mechanism then resets it to `ready` and tries to re-dispatch to the same branch, causing a 422. The reconciler's `reviewing` state should take precedence — retry logic must check for open PRs before resetting state.

Additionally, on retry: if the original branch exists and no open PR is associated, the ATC should delete the stale branch before re-dispatching rather than hitting a 422.

## Requirements

1. The ATC branch cleanup sweep must include `failed` state in the set of terminal states whose branches are eligible for deletion.
2. Branch deletion must be skipped (guarded) when the work item has an associated open PR (i.e., `prNumber` is set and the PR is still open).
3. The retry logic must check whether a work item has an open PR before resetting it to `ready`. If a `prNumber` is present and the PR is open, the item should be transitioned to `reviewing` (not `ready`), deferring to the reconciler.
4. When retrying a work item whose branch already exists (and no open PR), the ATC must delete the stale branch before re-dispatching to avoid the 422.
5. All changes must be confined to `lib/atc.ts`. No new dependencies.
6. TypeScript must compile without errors (`npx tsc --noEmit`).
7. `npm run build` must succeed.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/atc-branch-cleanup-failed-executions
```

### Step 1: Read and understand the current ATC code

Read `lib/atc.ts` in full. Identify:
- The branch cleanup section (search for `cleanup`, `deleteRef`, `deleteBranch`, or similar)
- The retry section (search for `retry`, `ready`, work item state transitions back to `ready`)
- The reconciler section (search for `reconcil`, `reviewing`, `prNumber`)
- Which states are currently included in cleanup eligibility
- The GitHub helper used to delete branches (likely in `lib/github.ts`)

```bash
cat lib/atc.ts
cat lib/github.ts
```

Take note of:
- The exact function/method used to delete a branch (e.g., `deleteBranch(owner, repo, branchName)`)
- How `prNumber` is stored on work items (check `lib/types.ts`)
- How the reconciler checks PR state (open vs. merged/closed)
- The exact condition used to identify branches eligible for cleanup

### Step 2: Fix branch cleanup to include `failed` state

Locate the cleanup sweep section in `lib/atc.ts`. It likely looks something like:

```typescript
// Current (broken) - only cleans parked/cancelled
const terminalStates = ['parked', 'cancelled'];
// or: item.status === 'parked' || item.status === 'cancelled'
```

**Change 1**: Add `failed` to the set of states eligible for branch cleanup.

**Change 2**: Guard branch deletion — skip if the work item has a `prNumber` AND that PR is still open (open PR check should already exist in the reconciler; reuse the same pattern).

The fixed cleanup logic should follow this pattern:

```typescript
// Eligible for branch cleanup if in a terminal/failed state AND no open PR
const isCleanupEligible = (item: WorkItem): boolean => {
  const cleanupStates = ['parked', 'cancelled', 'failed'];
  if (!cleanupStates.includes(item.status)) return false;
  // Don't delete branch if there's an open PR associated
  if (item.prNumber) return false; // has a PR reference — leave the branch alone
  return true;
};
```

If the existing code already checks PR status via a GitHub API call (checking if the PR is open), replicate that pattern. If it only checks `item.prNumber` presence, that is sufficient for the guard.

### Step 3: Fix the retry/reconciler conflict

Locate the retry logic section. It likely detects work items that have been in `executing` or `failed` state for too long and resets them to `ready` for re-dispatch.

The conflict: the reconciler runs, sees an open PR, sets the item to `reviewing`. Then the retry logic runs, sees a `failed` or stuck `executing` item, and resets to `ready` — overriding the reconciler.

**Fix**: Before the retry logic resets a work item to `ready`, check if the item has a `prNumber`. If it does, skip the retry reset (leave reconciler in charge). Optionally, if you can cheaply verify the PR is still open via the existing GitHub helper, do so — but checking `item.prNumber` presence is sufficient as a guard.

```typescript
// In retry logic — before resetting to ready:
if (item.prNumber) {
  // Has an open PR reference — reconciler should handle this, skip retry reset
  console.log(`[ATC] Skipping retry for ${item.id} — has PR #${item.prNumber}, deferring to reconciler`);
  continue; // or return, depending on the loop structure
}
```

### Step 4: Delete stale branch before re-dispatch on retry

In the retry/re-dispatch path, after confirming no open PR exists, add logic to attempt branch deletion before re-dispatching. This prevents the 422.

Locate where the ATC pushes the handoff and triggers the workflow (the dispatch path). Before dispatch, add:

```typescript
// On retry: delete stale branch if it exists to prevent 422
try {
  await deleteBranch(owner, repo, branchName); // use existing helper
  console.log(`[ATC] Deleted stale branch ${branchName} before retry dispatch`);
} catch (err: any) {
  if (err?.status === 422 || err?.message?.includes('Reference does not exist')) {
    // Branch doesn't exist — that's fine, proceed
  } else {
    throw err;
  }
}
```

Check `lib/github.ts` for the exact function signature for branch deletion. If no branch deletion function exists, add one:

```typescript
// In lib/github.ts (only if not already present):
export async function deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
  const octokit = getOctokit();
  await octokit.git.deleteRef({
    owner,
    repo,
    ref: `heads/${branch}`,
  });
}
```

If the delete helper needs to be added to `lib/github.ts`, add it there and import it in `lib/atc.ts`.

### Step 5: Handle the specific stuck branches

The three known stuck branches need to be addressed. The code fixes in Steps 2-4 will prevent future occurrences. For the currently stuck branches:

- `feat/integrate-attribution-into-atc-failed-work-item-ha` — failed state, no open PR → cleanup sweep will now delete it after this fix
- `feat/react-error-185-in-coach-chat-interface` — failed state, no open PR → same
- `fix/coach-chat-interface-locks-up-after-filing-a-bug-v` — has open PR #305 → cleanup will now correctly skip it

No manual intervention needed in code; the fixed cleanup sweep will handle them on next ATC cycle. However, if there's an admin/one-off mechanism to trigger cleanup, note it in the PR description.

### Step 6: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `item.prNumber` type: may be `number | undefined` — use `item.prNumber !== undefined` rather than just `item.prNumber` if strict null checks are enabled
- If `deleteBranch` was added to `lib/github.ts`, ensure it's exported and imported correctly

### Step 7: Build check

```bash
npm run build
```

Fix any build errors.

### Step 8: Review the changes for correctness

Before committing, re-read your diff carefully:

```bash
git diff
```

Verify:
- [ ] `failed` is included in cleanup-eligible states
- [ ] Cleanup skips items that have a `prNumber` (open PR guard)
- [ ] Retry logic skips items that have a `prNumber` (reconciler deference)  
- [ ] Re-dispatch path attempts branch deletion before pushing
- [ ] Branch deletion errors are handled gracefully (non-existent branch = silent continue)
- [ ] No unintended changes to unrelated sections of `lib/atc.ts`

### Step 9: Verification

```bash
npx tsc --noEmit
npm run build
```

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "fix: ATC branch cleanup includes failed state, retry respects open PRs

- Add 'failed' to terminal states eligible for branch cleanup in ATC sweep
- Guard branch deletion: skip if work item has prNumber (open PR present)
- Retry logic now checks prNumber before resetting to ready — defers to
  reconciler when an open PR exists (fixes retry/reconciler conflict)
- Pre-dispatch branch deletion: on retry, delete stale branch if it exists
  to prevent 422 'Reference already exists' errors

Fixes stuck branches:
- feat/integrate-attribution-into-atc-failed-work-item-ha (failed, no PR)
- feat/react-error-185-in-coach-chat-interface (failed, no PR)
- fix/coach-chat-interface-locks-up-after-filing-a-bug-v (open PR #305, correctly skipped)"

git push origin fix/atc-branch-cleanup-failed-executions

gh pr create \
  --title "fix: ATC branch cleanup includes failed state, retry respects open PRs" \
  --body "## Summary

Fixes two bugs in \`lib/atc.ts\` that were causing a 422 'Reference already exists' loop for retried work items.

### Bug 1: Branch cleanup missing 'failed' state
The ATC cleanup sweep only targeted \`parked\`/\`cancelled\` states. Branches from \`failed\` executions were never deleted. Fixed by adding \`failed\` to the cleanup-eligible states.

Guard added: branches are NOT deleted if the work item has a \`prNumber\` (i.e., an open PR exists for that branch).

### Bug 2: Retry/reconciler conflict
When a work item had an open PR, the reconciler correctly set it to \`reviewing\`. Then the retry logic would override that, reset to \`ready\`, and attempt to re-dispatch to the same branch — causing a 422.

Fixed by checking \`prNumber\` in the retry logic before resetting state. If a \`prNumber\` is present, the retry skips the item and defers to the reconciler.

### Bonus: Pre-dispatch branch deletion
On retry, if the target branch already exists (and no open PR), the ATC now deletes the stale branch before re-dispatching instead of hitting a 422.

### Known stuck branches resolved on next ATC cycle
- \`feat/integrate-attribution-into-atc-failed-work-item-ha\` — will be cleaned up (failed, no PR)
- \`feat/react-error-185-in-coach-chat-interface\` — will be cleaned up (failed, no PR)
- \`fix/coach-chat-interface-locks-up-after-filing-a-bug-v\` — correctly skipped (has open PR #305)

## Files Changed
- \`lib/atc.ts\` — cleanup states, retry guard, pre-dispatch branch deletion
- \`lib/github.ts\` — \`deleteBranch\` helper (if not already present)

## Risk
Medium — changes to ATC retry and cleanup logic. The guards (prNumber checks) are conservative and should not cause false negatives." \
  --base main
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/atc-branch-cleanup-failed-executions
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., the branch cleanup section uses an architecture you cannot safely modify, or the GitHub helper for branch deletion is missing and cannot be safely added), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "atc-branch-cleanup-failed-executions",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts", "lib/github.ts"]
    }
  }'
```