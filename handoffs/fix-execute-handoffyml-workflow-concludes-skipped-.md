<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix execute-handoff.yml: workflow concludes 'skipped' after committing code, causing false failures

## Metadata
- **Branch:** `fix/execute-handoff-skipped-conclusion`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** .github/workflows/execute-handoff.yml, lib/atc.ts

## Context

Multiple work items are failing with `reason: workflow_failed` where the ATC detects the execute-handoff.yml workflow concluding as "skipped". However, the executor DID create branches, commit code, and open PRs in these cases. The workflow ran for 6-9 minutes before concluding "skipped", which caused ATC to mark items as failed and trigger retries. Retries then fail with "Reference already exists" because the branch was already created by the first run.

Confirmed affected work items (2026-03-18):
- `df8aed75` (KG dashboard): branch created, PR opened, TLM passed, CI failed — but execute-handoff concluded "skipped"
- `40925159` (ATC auto-indexing): branch created, PR opened, TLM passed — but execute-handoff concluded "skipped"
- `df4a3edc` (risk level detection): branch created, orphaned on retry

Root causes to fix:
1. In `execute-handoff.yml`: a job step's `if:` condition is too broad, causing final steps (likely the "report results" step that communicates back to ATC) to be skipped when they should run. This makes the overall job conclude as "skipped".
2. In `lib/atc.ts`: the ATC treats `conclusion == 'skipped'` as failure without checking if a PR was actually opened. Need to add branch/PR existence checks before marking failed.
3. The retry flow has no guard against "branch already exists" — it should detect an existing branch + PR and transition to "reviewing" instead of failing.

The ATC monitors workflow runs via `lib/github.ts` polling and transitions work items based on `conclusion`. The relevant monitoring logic is in `lib/atc.ts` (sections §2, §2.8).

## Requirements

1. `execute-handoff.yml` must conclude with `success` (not `skipped`) when code is committed to a branch and a PR is opened.
2. Any `if:` conditions on post-execution steps (report-back, status update) must be reviewed — these steps should run whenever the main execution phase ran, regardless of whether Claude committed code or not.
3. ATC must not mark a work item as `failed` with `workflow_failed` when `conclusion == 'skipped'` if there is an open PR associated with the work item's branch.
4. ATC retry flow must check if the target branch already exists before dispatching. If branch exists and a PR is open, transition the work item to `reviewing` instead of retrying.
5. No regressions: items that genuinely fail (no branch created, no PR) should still be marked failed correctly.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/execute-handoff-skipped-conclusion
```

### Step 1: Audit execute-handoff.yml for skipped step conditions

Read the full workflow file carefully:
```bash
cat .github/workflows/execute-handoff.yml
```

Look for:
- Job-level `if:` conditions that might evaluate to false after execution
- Step-level `if:` conditions on "report results", "update work item status", "notify ATC", or similar post-execution steps
- Any step that uses `if: steps.some_step.outcome == 'success'` where `some_step` might have concluded differently (e.g., `skipped` or `failure`)

**Common pattern causing this bug:**
```yaml
# BROKEN: If execution step is skipped for any reason, this entire step is skipped
- name: Report results
  if: steps.execute.outcome == 'success'
  run: ...
```

When a step is skipped (e.g., because an earlier `if:` evaluated false), GitHub Actions marks that step as `skipped`. If ALL steps in a job are either `success` or `skipped` with no `failure`, the job concludes as `skipped` rather than `success`. This causes the ATC to see `conclusion: skipped` and treat it as a failure.

### Step 2: Fix execute-handoff.yml post-execution steps

The fix depends on what you find in Step 1, but the general approach:

**Option A: Broaden the condition on the report-back step** so it runs whenever execution was attempted (not just when it succeeded):

```yaml
# FIXED: Run report step if execution ran (success or failure), not just success
- name: Report results
  if: always() && steps.execute.outcome != 'skipped'
  run: ...
```

Or more simply, if the report step should always run at the end:
```yaml
- name: Report results
  if: always()
  run: ...
```

**Option B: If the entire job has a conditional that's too narrow**, fix the job-level `if:`:
```yaml
jobs:
  execute:
    # Make sure this condition covers all cases where the handoff was dispatched
    if: github.event.inputs.handoff_file != ''
```

**Important**: After making the fix, the workflow should conclude `success` when:
- The handoff was executed and a PR was created
- The handoff was executed and no changes were needed (Claude decided nothing to do)
- The report-back step ran successfully

The workflow should conclude `failure` when:
- Claude Code itself crashes or exits non-zero
- The report-back step fails to communicate results

### Step 3: Add branch existence guard in the retry flow (execute-handoff.yml)

If execute-handoff.yml has a step that creates the branch or checks out a new branch, add a guard:

Find the branch creation step (likely `git checkout -b $BRANCH_NAME` or similar via the GitHub API), then add a pre-check. Example pattern:

```yaml
- name: Check if branch already exists
  id: branch_check
  run: |
    BRANCH="${{ github.event.inputs.branch_name }}"
    if git ls-remote --exit-code --heads origin "$BRANCH" > /dev/null 2>&1; then
      echo "branch_exists=true" >> $GITHUB_OUTPUT
      echo "Branch $BRANCH already exists"
    else
      echo "branch_exists=false" >> $GITHUB_OUTPUT
    fi

- name: Create branch
  if: steps.branch_check.outputs.branch_exists == 'false'
  run: |
    git checkout -b ${{ github.event.inputs.branch_name }}
```

If the workflow uses the GitHub API to create branches (via `lib/github.ts` called from a script), add equivalent logic there.

### Step 4: Audit lib/atc.ts for skipped conclusion handling

Read the relevant ATC sections:
```bash
cat lib/atc.ts | grep -n "skipped\|workflow_failed\|conclusion\|failed\|retry" | head -60
```

Also read the full monitoring section (search for where workflow run conclusions are evaluated):
```bash
grep -n "conclusion" lib/atc.ts
```

Look for patterns like:
```typescript
if (run.conclusion === 'failure' || run.conclusion === 'skipped') {
  // mark work item as failed
}
```

### Step 5: Fix ATC skipped conclusion handling

In `lib/atc.ts`, find where workflow run conclusions are evaluated and add PR existence check before marking failed.

**Current (broken) pattern:**
```typescript
if (run.conclusion === 'failure' || run.conclusion === 'skipped') {
  await updateWorkItem(item.id, { status: 'failed', reason: 'workflow_failed' });
}
```

**Fixed pattern:**
```typescript
if (run.conclusion === 'failure' || run.conclusion === 'skipped') {
  // Before marking failed, check if a PR was actually opened for this work item
  // This handles the case where execute-handoff concludes 'skipped' but work was done
  const existingPR = item.prNumber
    ? await getPR(item.repoFullName, item.prNumber)
    : await findPRForBranch(item.repoFullName, item.branch);

  if (existingPR && existingPR.state === 'open') {
    console.log(`[ATC] Work item ${item.id}: workflow concluded '${run.conclusion}' but PR #${existingPR.number} exists and is open — transitioning to reviewing`);
    await updateWorkItem(item.id, {
      status: 'reviewing',
      prNumber: existingPR.number,
      prUrl: existingPR.html_url,
    });
  } else {
    await updateWorkItem(item.id, { status: 'failed', reason: 'workflow_failed' });
  }
}
```

Check what GitHub API helpers are available in `lib/github.ts` for finding PRs by branch name. Look for a function like `findPRForBranch` or add one if it doesn't exist.

### Step 6: Add findPRForBranch helper if missing (lib/github.ts)

Check if `lib/github.ts` has a function to look up a PR by branch name:
```bash
grep -n "findPR\|getPR\|listPR\|pull" lib/github.ts | head -20
```

If not, add one:
```typescript
/**
 * Find an open PR for a given head branch in a repo.
 * Returns null if no open PR exists for that branch.
 */
export async function findPRForBranch(
  repoFullName: string,
  branch: string
): Promise<{ number: number; html_url: string; state: string } | null> {
  const [owner, repo] = repoFullName.split('/');
  const token = process.env.GH_PAT;
  
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );
  
  if (!response.ok) return null;
  
  const prs = await response.json();
  if (prs.length === 0) return null;
  
  return {
    number: prs[0].number,
    html_url: prs[0].html_url,
    state: prs[0].state,
  };
}
```

### Step 7: Add branch existence check in ATC retry dispatch

Find the section in `lib/atc.ts` where work items are dispatched (or re-dispatched after failure). Add a guard:

```typescript
// Before dispatching, check if branch already exists and has an open PR
// This prevents "Reference already exists" errors on retry
async function shouldRetryOrRecoverItem(item: WorkItem): Promise<'retry' | 'recover_to_reviewing' | 'fail'> {
  if (!item.branch) return 'retry';
  
  const existingPR = await findPRForBranch(item.repoFullName, item.branch);
  if (existingPR && existingPR.state === 'open') {
    return 'recover_to_reviewing';
  }
  
  return 'retry';
}
```

Then in the dispatch/retry logic, call this before re-dispatching a failed item:
```typescript
if (item.status === 'failed' && item.reason === 'workflow_failed') {
  const action = await shouldRetryOrRecoverItem(item);
  if (action === 'recover_to_reviewing') {
    await updateWorkItem(item.id, {
      status: 'reviewing',
      prNumber: existingPR.number,
      prUrl: existingPR.html_url,
    });
    continue; // skip dispatch
  }
}
```

Note: Integrate this naturally into the existing ATC dispatch flow rather than creating a completely separate function if the existing structure doesn't support it cleanly.

### Step 8: TypeScript type check and build
```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors. Common issues to watch for:
- `findPRForBranch` return type might not match what callers expect
- `WorkItem` type in `lib/types.ts` may need a `branch` field if not already present — check before adding
- Null safety on `existingPR` references

### Step 9: Verify no regressions in test suite
```bash
npm test
```

If tests reference the ATC conclusion-handling logic, update them to reflect the new behavior (skipped + PR exists → reviewing, skipped + no PR → failed).

### Step 10: Commit, push, open PR
```bash
git add -A
git commit -m "fix: execute-handoff concludes 'skipped' on success, ATC false failure handling

- Fix execute-handoff.yml: post-execution report step was conditionally
  skipped, causing the workflow to conclude 'skipped' instead of 'success'
  even when code was committed and a PR was opened
- Fix ATC: treat conclusion='skipped' as potential success by checking for
  existing open PR before marking work item as failed
- Add ATC retry guard: if branch already exists and has an open PR on retry,
  transition work item to 'reviewing' instead of re-dispatching
- Add findPRForBranch helper to lib/github.ts for PR lookup by branch name

Fixes false failures for df8aed75, 40925159, df4a3edc and prevents
'Reference already exists' errors on retry"

git push origin fix/execute-handoff-skipped-conclusion

gh pr create \
  --title "fix: execute-handoff.yml 'skipped' conclusion causing false workflow failures" \
  --body "## Problem

The \`execute-handoff.yml\` workflow was concluding as \`skipped\` in cases where the executor DID create a branch, commit code, and open a PR. This caused the ATC to mark work items as \`failed\` with \`reason: workflow_failed\`, triggering retries that then failed with 'Reference already exists'.

Confirmed affected items: df8aed75 (KG dashboard), 40925159 (ATC auto-indexing), df4a3edc (risk level detection).

## Root Causes Fixed

1. **execute-handoff.yml**: A post-execution step had an \`if:\` condition that evaluated to false when the execution step had a non-success outcome (e.g., the step was skipped or a condition wasn't met). When all steps are skipped/success with no failure, GitHub Actions marks the job as \`skipped\` rather than \`success\`.

2. **lib/atc.ts**: The ATC treated \`conclusion === 'skipped'\` as equivalent to failure without checking if a PR was actually opened. Added PR existence check before marking failed — if an open PR exists, transition to \`reviewing\` instead.

3. **Retry flow**: Added branch existence check before re-dispatching failed items. If a branch already exists with an open PR, recover to \`reviewing\` instead of retrying (which would fail with 'Reference already exists').

## Changes

- \`.github/workflows/execute-handoff.yml\`: Fixed \`if:\` condition on report-back step
- \`lib/atc.ts\`: Added PR existence check in conclusion handling + retry guard
- \`lib/github.ts\`: Added \`findPRForBranch()\` helper

## Testing

- TypeScript compiles clean
- Existing tests pass
- Manually verified logic covers: skipped+PR→reviewing, skipped+no PR→failed, genuine failure→failed"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/execute-handoff-skipped-conclusion
FILES CHANGED: [list of files modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "ATC retry guard not yet implemented", "findPRForBranch needs testing"]
```

## Escalation

If you cannot determine the root cause from reading `execute-handoff.yml` (e.g., the file uses a composite action or reusable workflow that isn't in this repo), or if the ATC conclusion-handling logic is significantly different from what's described here, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-execute-handoff-skipped-conclusion",
    "reason": "Cannot locate root cause: execute-handoff.yml structure differs from expected, or ATC conclusion handling uses different pattern than described in handoff",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 1 or Step 4",
      "error": "Describe what you found vs what was expected",
      "filesChanged": [".github/workflows/execute-handoff.yml", "lib/atc.ts"]
    }
  }'
```