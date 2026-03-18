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
- **Estimated files:** .github/workflows/execute-handoff.yml, lib/atc/health-monitor.ts, lib/atc/dispatcher.ts, lib/atc/types.ts

## Context

Multiple work items are false-failing because the `execute-handoff.yml` workflow concludes with status `"skipped"` even when the executor successfully created a branch, committed code, and opened a PR. The ATC's health monitor and dispatcher treat `"skipped"` as a failure conclusion, marking items as `failed` and triggering retries. The retries then fail with `"Reference already exists"` because the branch was already created by the first run.

Confirmed affected items (2026-03-18):
- `df8aed75` (KG dashboard): branch created, PR opened, TLM passed, CI ran — workflow concluded `skipped`
- `40925159` (ATC auto-indexing): branch created, PR opened, TLM review passed — workflow concluded `skipped`
- `df4a3edc` (risk level detection): branch created but orphaned on retry

The root cause is likely one of:
1. A job-level `if:` condition in `execute-handoff.yml` that is too broad — causing final post-execution steps (e.g., a status-update step) to be skipped, making GitHub report the overall job conclusion as `skipped`
2. The ATC treating `conclusion == 'skipped'` as failure when it should check whether a PR was actually opened

This repo is the **control plane** (Agent Forge itself). The `execute-handoff.yml` workflow lives inside this repo at `.github/workflows/execute-handoff.yml` and orchestrates Claude Code running handoff files against **target repos**. The ATC logic that polls workflow conclusions lives in `lib/atc/health-monitor.ts` and/or `lib/atc/dispatcher.ts`.

**Concurrent work awareness:** Another work item is modifying `.github/actions/tlm-qa-agent/` files. This fix does NOT touch those files.

## Requirements

1. Inspect `execute-handoff.yml` and identify which step(s) or job condition(s) produce a `skipped` conclusion when execution actually succeeded.
2. Fix the workflow so that it concludes `success` when a branch was created and a PR was opened — even if optional post-execution steps are skipped.
3. Update the ATC health monitor (`lib/atc/health-monitor.ts`) to treat `"skipped"` workflow conclusions as a soft/ambiguous case rather than hard failure: if the workflow run lasted > 2 minutes AND the work item has an associated PR or branch, do NOT mark it failed — instead attempt to reconcile by checking GitHub for an existing PR.
4. Add a branch-existence check in the retry/dispatch path: if a branch already exists for a work item being dispatched/retried, check GitHub for an existing PR on that branch. If a PR exists, transition the work item to `reviewing` instead of re-triggering the workflow (which would fail with "Reference already exists").
5. All existing TypeScript types must remain valid (`npx tsc --noEmit` passes).
6. No regressions to existing health monitor or dispatcher logic.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/execute-handoff-skipped-conclusion
```

### Step 1: Audit execute-handoff.yml for skipped-conclusion root cause

Read the full workflow file carefully:
```bash
cat .github/workflows/execute-handoff.yml
```

Look for:
- Any `if:` conditions on steps or jobs that could cause steps to be skipped post-execution (e.g., `if: steps.some-step.outcome == 'success'` where `some-step` might produce `skipped`)
- Any `continue-on-error` misuse
- Steps that run conditionally after the Claude Code execution step — particularly any "report status" or "update work item" step gated on a prior step's success
- Whether GitHub rolls up a job conclusion as `skipped` if the final step is skipped

**Key insight:** GitHub reports a job conclusion as `skipped` if the job's `if:` condition is false. But if individual *steps* within a running job are skipped, the job conclusion is still `success` or `failure` depending on other steps. However, if the ONLY steps in a job that actually execute are all `skipped`, GitHub may report `skipped`. Check if there is a separate "notify" job or "post-execution" job with an `if:` condition referencing a prior job's output.

Document what you find in a comment at the top of the fix.

### Step 2: Fix execute-handoff.yml

Based on your audit, apply the appropriate fix. Common patterns:

**Pattern A — Final "notify/update" job has an `if:` condition that's too strict:**
If there's a job like:
```yaml
notify:
  needs: execute
  if: needs.execute.result == 'success'
  steps:
    - name: Update work item status
      ...
```
And `execute` job had failures but still created a PR, then the `notify` job is skipped. GitHub may report the workflow as `skipped` overall. Fix: change the condition to `always()` or `needs.execute.result != 'cancelled'`, and inside the step use conditional logic to determine what status to report.

**Pattern B — A step inside the execute job is skipped, and it's the step GitHub uses to determine conclusion:**
Find the step and ensure it always runs when the executor has done work:
```yaml
- name: Report execution outcome
  if: always()   # <-- add this
  ...
```

**Pattern C — The `if:` on the job itself:**
If the job has `if: github.event_name == 'workflow_dispatch'` or similar, verify the trigger is always correct.

**The minimal safe fix:** Add `if: always()` to any final status-reporting step that is conditionally gated. Ensure the workflow emits `conclusion: success` when a PR was opened, regardless of whether subsequent reporting steps had errors.

Example of a robust post-execution step:
```yaml
- name: Report status to Agent Forge
  if: always()
  run: |
    # Determine outcome based on whether PR was created
    if [[ -n "${{ steps.open-pr.outputs.pr_url }}" ]]; then
      STATUS="success"
    else
      STATUS="failure"  
    fi
    # ... report to Agent Forge API
```

### Step 3: Update ATC health monitor — treat 'skipped' as ambiguous

Open `lib/atc/health-monitor.ts` and find the section where workflow run conclusions are evaluated to determine if a work item should be marked `failed`.

Search for:
```bash
grep -n "skipped\|workflow_failed\|conclusion" lib/atc/health-monitor.ts | head -40
grep -n "skipped\|workflow_failed\|conclusion" lib/atc/dispatcher.ts | head -40
grep -n "skipped\|conclusion" lib/atc/types.ts | head -20
```

Find the logic that does something like:
```typescript
if (run.conclusion === 'failure' || run.conclusion === 'skipped') {
  // mark as failed
}
```

Update it to handle `skipped` as an ambiguous case:

```typescript
// Helper: determine if a 'skipped' conclusion might actually represent
// successful execution where a post-step was skipped.
// A run that lasted > 2 minutes and has an associated branch/PR should not
// be treated as a hard failure — reconcile instead.
function isAmbiguousSkip(
  run: { conclusion: string; created_at: string; updated_at: string },
  workItem: WorkItem
): boolean {
  if (run.conclusion !== 'skipped') return false;
  const durationMs =
    new Date(run.updated_at).getTime() - new Date(run.created_at).getTime();
  const ranForMoreThan2Min = durationMs > 2 * 60 * 1000;
  const hasBranchOrPr = !!(workItem.branch || workItem.prNumber);
  return ranForMoreThan2Min || hasBranchOrPr;
}
```

Then in the failure handling:
```typescript
if (run.conclusion === 'failure') {
  // hard failure — mark failed as before
  await markWorkItemFailed(workItem, 'workflow_failed');
} else if (run.conclusion === 'skipped') {
  if (isAmbiguousSkip(run, workItem)) {
    // Don't mark failed — attempt reconciliation
    // Check GitHub for existing PR on the expected branch
    await reconcileSkippedRun(workItem, context);
  } else {
    // Truly skipped (never started) — mark failed
    await markWorkItemFailed(workItem, 'workflow_failed');
  }
}
```

Implement `reconcileSkippedRun` (or inline the logic) to:
1. Derive the expected branch name from the work item (e.g., `workItem.branch` or the handoff's target branch)
2. Call GitHub API to search for a PR on that branch: `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`
3. If a PR exists → transition the work item to `reviewing` with the PR number
4. If no PR exists but the branch exists → transition to `failed` with reason `no_pr_after_execution`
5. If neither → transition to `failed` with reason `workflow_failed`

Use the existing GitHub client pattern from `lib/github.ts`. Look at how existing code calls `github.octokit` or similar.

### Step 4: Add branch-existence check in retry/dispatch path

Find where work items are re-dispatched after failure (likely in `lib/atc/dispatcher.ts` or `lib/orchestrator.ts`). Search for the dispatch logic:

```bash
grep -n "dispatch\|Reference already exists\|branch.*exists\|createRef\|createBranch" lib/atc/dispatcher.ts lib/orchestrator.ts | head -30
```

In the dispatch/retry path, before triggering the workflow for a work item, add a branch-existence check:

```typescript
// Before dispatching, check if the branch already exists on GitHub.
// This handles the case where a prior 'skipped' run actually created the branch.
async function checkBranchExistsAndReconcile(
  workItem: WorkItem,
  branchName: string,
  context: CycleContext
): Promise<'proceed' | 'reconciled' | 'failed'> {
  try {
    // Try to get the branch ref
    await github.getRef(`heads/${branchName}`, workItem.repoFullName);
    // Branch exists — check for PR
    const prs = await github.listPullRequests(workItem.repoFullName, {
      head: `${repoOwner}:${branchName}`,
      state: 'all',
    });
    if (prs.length > 0) {
      const pr = prs[0];
      // PR exists — transition to reviewing
      await updateWorkItem(workItem.id, {
        status: 'reviewing',
        prNumber: pr.number,
        prUrl: pr.html_url,
      });
      context.events.push({
        type: 'work_item_reconciled',
        workItemId: workItem.id,
        detail: `Branch and PR already existed; transitioned to reviewing (PR #${pr.number})`,
      });
      return 'reconciled';
    } else {
      // Branch exists but no PR — the previous run partially completed.
      // Don't retry (would fail with "Reference already exists") — mark failed.
      await markWorkItemFailed(workItem, 'branch_exists_no_pr');
      return 'failed';
    }
  } catch (err: any) {
    if (err?.status === 404) {
      // Branch doesn't exist — safe to dispatch
      return 'proceed';
    }
    throw err;
  }
}
```

Integrate this check into the dispatch flow so that before any workflow_dispatch trigger for a `failed` or `parked` item being retried, the branch-existence check runs first.

**Note:** Check `lib/github.ts` for the exact method names available. Adapt the function above to use whatever methods already exist rather than inventing new ones.

### Step 5: Update types if needed

Check `lib/atc/types.ts` for any union types or constants related to workflow conclusions or failure reasons:

```bash
grep -n "workflow_failed\|FailureReason\|WorkItemStatus\|conclusion" lib/atc/types.ts
```

If there's a `FailureReason` union type, add the new reasons:
```typescript
// Before:
export type FailureReason = 'workflow_failed' | 'branch_conflict' | ...;

// After:
export type FailureReason = 
  | 'workflow_failed' 
  | 'branch_exists_no_pr'
  | 'no_pr_after_execution'
  | 'branch_conflict' 
  | ...;
```

### Step 6: Verification

```bash
# Type check
npx tsc --noEmit

# Lint (if configured)
npm run lint 2>/dev/null || true

# Build
npm run build

# Tests (if present)
npm test 2>/dev/null || true
```

Ensure no TypeScript errors are introduced. The workflow YAML is not type-checked but should be valid YAML — visually verify indentation and structure.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "fix: workflow concludes skipped after successful execution, ATC false failures

- Fix execute-handoff.yml: ensure final status-reporting steps run with
  always() condition so workflow concludes success when PR is created
- Update ATC health monitor to treat skipped conclusion as ambiguous
  when run duration > 2min or work item has associated branch/PR;
  attempt reconciliation via GitHub API instead of hard-failing
- Add branch-existence check in retry/dispatch path: if branch already
  exists, check for PR and transition to reviewing rather than retrying
  (which would fail with 'Reference already exists')

Fixes false failures for df8aed75, 40925159, df4a3edc and similar cases."

git push origin fix/execute-handoff-skipped-conclusion

gh pr create \
  --title "fix: workflow concludes 'skipped' after successful execution, causing false ATC failures" \
  --body "## Problem

\`execute-handoff.yml\` was concluding with status \`skipped\` even when the executor successfully created a branch, committed code, and opened a PR. The ATC treated \`skipped\` as a hard failure, marking work items as \`failed\` and triggering retries. Retries then failed with \`Reference already exists\`.

Confirmed affected: df8aed75 (KG dashboard), 40925159 (ATC auto-indexing), df4a3edc (risk detection).

## Changes

### \`.github/workflows/execute-handoff.yml\`
- Added \`if: always()\` (or equivalent) to final status-reporting steps so the workflow concludes \`success\` when a PR was created, regardless of whether optional post-steps were skipped.

### \`lib/atc/health-monitor.ts\`
- Added \`isAmbiguousSkip()\` helper: a \`skipped\` conclusion on a run that lasted > 2 minutes or has an associated branch/PR is treated as ambiguous, not a hard failure.
- Added \`reconcileSkippedRun()\` logic: checks GitHub for an existing PR on the expected branch; transitions to \`reviewing\` if found.

### \`lib/atc/dispatcher.ts\` (or \`lib/orchestrator.ts\`)
- Added branch-existence check before retry dispatch: if the branch already exists, check for a PR and transition to \`reviewing\` instead of re-triggering the workflow.

### \`lib/atc/types.ts\` (if applicable)
- Added \`branch_exists_no_pr\` and \`no_pr_after_execution\` failure reason variants.

## Acceptance Criteria
- [x] Workflow concludes \`success\` when code is committed and PR is opened
- [x] ATC no longer marks items as failed when conclusion is \`skipped\` but work was done
- [x] Retry path reconciles branch-already-exists case gracefully
- [x] TypeScript compiles cleanly" \
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
BRANCH: fix/execute-handoff-skipped-conclusion
FILES CHANGED: [list files actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "Step 4 branch-existence check not implemented", "execute-handoff.yml fix needs manual review of actual YAML structure"]
```

## Important Notes for Executor

1. **Read execute-handoff.yml first before writing any code.** The exact fix depends entirely on what the workflow actually does. Do not assume — inspect the file and understand why a run that created a branch and PR would still conclude `skipped`.

2. **Preserve existing health monitor behavior** for `conclusion === 'failure'` (hard failure) and `conclusion === 'cancelled'`. Only the `skipped` handling changes.

3. **Use existing GitHub API wrappers** from `lib/github.ts`. Do not introduce direct `fetch` calls to the GitHub API if wrapper methods exist.

4. **The concurrent work item** (`fix/action-ledger-logger-log-qa-agent-results-to-struc`) touches `.github/actions/tlm-qa-agent/` only. There is no file overlap with this fix.

5. **If `execute-handoff.yml` is a workflow in a target repo template** (not in agent-forge itself), escalate — the fix location would be different. But based on the system map, `execute-handoff.yml` lives in the data plane (target repos). However, **agent-forge itself is also a target repo** with its own workflows. Verify the file exists at `.github/workflows/execute-handoff.yml` in this repo before proceeding.

   If the file does NOT exist in agent-forge, then the ATC-side fix (Steps 3–5) is still valid and necessary, and the workflow fix should be noted as needing to be applied to the target repo template instead. In that case, also check `lib/orchestrator.ts` for any workflow template that gets pushed to target repos.