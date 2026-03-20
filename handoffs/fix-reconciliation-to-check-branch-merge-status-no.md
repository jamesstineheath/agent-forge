<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Fix reconciliation to check branch merge status, not just tracked PR

## Metadata
- **Branch:** `fix/reconciliation-branch-merge-status`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/health-monitor.ts, lib/github.ts, lib/atc/types.ts

## Context

The reconciliation sweep in the Health Monitor agent checks whether a work item's tracked `prNumber` is merged to decide if a work item should transition to "merged" status. However, there's a pipeline behavior that breaks this assumption:

1. The Orchestrator creates a branch and an initial PR, which auto-merges.
2. After auto-merge, the TLM Code Review workflow opens a **second PR** on the same branch.
3. The work item's `prNumber` gets updated to this second (still-open) PR.
4. Reconciliation sees the second PR as open, so it never transitions the work item to "merged" — even though the branch's actual code is already in `main`.

The net effect: work items get stuck in `reviewing` or `executing` state permanently after successful code delivery.

**Relevant code locations:**
- `lib/atc/health-monitor.ts` — Contains `§2.8 — Failed PR Reconciliation` which checks `prNumber` merge status. This is where the branch-merge fallback needs to be added.
- `lib/github.ts` — GitHub API wrapper. May need a new helper to check if a branch's HEAD is merged into `main`.
- `lib/atc/types.ts` — Shared types for the ATC agents.

**Pattern from recent merged PR:** The fix "Fix blocked status conflation and stale pipeline health" touched `lib/atc/health-monitor.ts` — follow those patterns.

**Note:** `lib/atc.ts` is deprecated (ADR-010). Do not modify it. All reconciliation logic lives in `lib/atc/health-monitor.ts`.

## Requirements

1. Add a GitHub API helper function (in `lib/github.ts`) that checks whether a given branch has been merged into `main` — by looking at the branch's HEAD commit SHA and checking if any merged PR on the repo has that SHA as its merge commit or head SHA.
2. In `lib/atc/health-monitor.ts`, in the reconciliation section that handles `reviewing` (and `executing` where applicable) work items, add a fallback: when the tracked `prNumber` is not merged, also check if the work item's branch has been merged into `main` via the new helper. If it has, transition the work item to `merged`.
3. The fix must handle work items that have a `branch` field set. If no branch is known, fall back to existing behavior (check `prNumber` only).
4. Do not break existing behavior for work items where the tracked PR is the actual merged PR.
5. Add a descriptive log/event entry when a work item is transitioned via branch-merge detection (distinct from the existing PR-number-based path) to aid debugging.
6. (Secondary) In the code reviewer action or spec review, add a guard: before opening a new PR, check if the branch is already merged into `main`. If it is, skip PR creation. This lives in `.github/actions/tlm-review/` or the workflow — implement only if the primary fix above is complete and budget allows.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/reconciliation-branch-merge-status
```

### Step 1: Understand the current reconciliation logic

Read and understand the relevant files before making changes:

```bash
cat lib/atc/health-monitor.ts
cat lib/github.ts
cat lib/atc/types.ts
```

Look specifically for:
- In `health-monitor.ts`: The section labeled `§2.8` or any block that iterates over work items with `status === 'reviewing'` or `status === 'failed'` and checks `prNumber` for merge status.
- In `github.ts`: Existing helpers like `isPRMerged`, `getPR`, `listPRs`, or similar. Note the GitHub API client pattern used (likely `@octokit/rest` or `fetch` with `GH_PAT`).

### Step 2: Add branch-merge detection helper to `lib/github.ts`

Add a new exported async function. The implementation strategy: use the GitHub API to check if the branch's HEAD commit is an ancestor of `main`, OR check if any merged PR targets the branch. The most reliable approach is to use the [compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits) or list merged PRs for the branch.

**Recommended approach** — check merged PRs for the branch head:

```typescript
/**
 * Check whether a branch has been merged into main (via any PR).
 * Returns true if any merged PR on the repo has this branch as its head.
 * Useful when work items track a secondary PR after the original merged PR.
 */
export async function isBranchMergedIntoMain(
  owner: string,
  repo: string,
  branchName: string
): Promise<boolean> {
  // Strategy 1: check if branch HEAD is reachable from main
  // Using the compare API: if branch is "behind" or "identical" to main
  // it means the branch commits are in main.
  try {
    const response = await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/compare/main...${encodeURIComponent(branchName)}`
    );
    if (!response.ok) {
      // Branch may be deleted (already merged and cleaned up)
      if (response.status === 404) return true; // branch gone = likely merged
      return false;
    }
    const data = await response.json();
    // "behind" means all branch commits are already in main
    // "identical" means branch == main
    return data.status === 'behind' || data.status === 'identical';
  } catch {
    return false;
  }
}
```

**Important:** Match the exact pattern used by existing functions in `lib/github.ts` for the API call (check whether it uses `Octokit`, a `fetch` wrapper, or direct `fetch` with `Authorization: token ${GH_PAT}`). Do not introduce a new HTTP client pattern.

If the existing code uses Octokit:
```typescript
export async function isBranchMergedIntoMain(
  owner: string,
  repo: string,
  branchName: string
): Promise<boolean> {
  try {
    const octokit = getOctokit(); // use whatever the existing pattern is
    const { data } = await octokit.repos.compareCommits({
      owner,
      repo,
      base: 'main',
      head: branchName,
    });
    return data.status === 'behind' || data.status === 'identical';
  } catch (err: any) {
    // 404 = branch deleted (merged and cleaned up)
    if (err?.status === 404) return true;
    return false;
  }
}
```

### Step 3: Update reconciliation in `lib/atc/health-monitor.ts`

Find the reconciliation sweep section — look for:
- A loop over work items filtering by `status === 'reviewing'` (or `'failed'`)
- A call to check if a PR is merged (e.g., `isPRMerged(item.prNumber)` or similar)
- A transition to `'merged'` status

Add the branch-merge fallback **after** the existing PR check fails:

```typescript
// Existing pattern (pseudocode — match actual style in file):
if (item.prNumber) {
  const merged = await isPRMerged(owner, repo, item.prNumber);
  if (merged) {
    await transitionWorkItem(item, 'merged');
    logEvent('pr_reconciled_merged', item.id);
    continue;
  }
}

// ADD THIS FALLBACK:
// If tracked PR is not merged, check if the branch itself is merged into main
// This handles the duplicate-PR case where the second PR is still open
// but the branch's code was already delivered via the first (auto-merged) PR.
if (item.branch) {
  const { owner: repoOwner, repo: repoName } = parseRepoSlug(item.repoSlug ?? targetRepo);
  const branchMerged = await isBranchMergedIntoMain(repoOwner, repoName, item.branch);
  if (branchMerged) {
    await transitionWorkItem(item, 'merged');
    logEvent('branch_merge_reconciled', item.id, {
      branch: item.branch,
      trackedPR: item.prNumber,
      reason: 'branch_head_in_main_despite_open_pr',
    });
    console.log(
      `[health-monitor] Work item ${item.id} transitioned to merged via branch-merge ` +
      `detection (branch: ${item.branch}, tracked PR: ${item.prNumber})`
    );
    continue;
  }
}
```

**Key details to get right:**
- Import `isBranchMergedIntoMain` from `lib/github.ts` at the top of the health monitor file.
- Identify how `owner` and `repo` are derived from a work item — check the existing code to see if there's a `repoSlug` field, a `repo` field, or a global constant. Match that pattern exactly.
- The `item.branch` field: check `lib/types.ts` to confirm the field name on `WorkItem`. It may be `branch`, `branchName`, or `headBranch`.
- Only apply this to work items in `reviewing` status (and optionally `executing` if they have a branch). Do not apply to `filed`, `ready`, `queued`, or `generating`.

### Step 4: Verify TypeScript types

Check `lib/types.ts` for the `WorkItem` type to ensure `branch` (or whatever the field is named) is defined. If it's not typed, add it:

```typescript
// In lib/types.ts, find the WorkItem interface and ensure it has:
branch?: string;
```

Run TypeScript to check for errors:
```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 5: (Secondary, if budget allows) Guard against duplicate PR creation

Check `.github/actions/tlm-review/` for the code reviewer action entrypoint. If there's a step that calls `gh pr create` or the GitHub API to open a PR, add a guard:

```bash
# Before creating a PR, check if branch is already merged into main
COMPARE=$(gh api repos/:owner/:repo/compare/main...${BRANCH_NAME} --jq '.status' 2>/dev/null || echo "error")
if [[ "$COMPARE" == "behind" || "$COMPARE" == "identical" ]]; then
  echo "Branch ${BRANCH_NAME} is already merged into main. Skipping PR creation."
  exit 0
fi
```

If the action is a JavaScript/TypeScript action, add equivalent logic using Octokit before any `octokit.pulls.create` call.

**Only implement Step 5 if Steps 1–4 are complete and TypeScript compiles cleanly.**

### Step 6: Verification

```bash
# TypeScript must compile with no errors
npx tsc --noEmit

# Build must succeed
npm run build

# Run existing tests to ensure no regressions
npm test

# If there are specific ATC/health-monitor tests, run them:
npx jest lib/atc --passWithNoTests
```

Verify the logic manually by tracing through a hypothetical scenario:
- Work item in `reviewing` status with `prNumber: 456` (open) and `branch: "feat/some-feature"`
- PR 456 is open → existing check returns false
- `isBranchMergedIntoMain("jamesstineheath", "agent-forge", "feat/some-feature")` → compare API returns `status: "behind"` → returns `true`
- Work item transitions to `merged` ✓

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "fix: reconciliation checks branch merge status, not just tracked PR

The reconciliation sweep was checking only the work item's tracked prNumber
for merge status. This broke when the pipeline created a duplicate PR (code
review opens a second PR after the first auto-merges), causing the work item
to update its prNumber to the still-open second PR and never transition to merged.

Fix: Add isBranchMergedIntoMain() helper in lib/github.ts that uses the
GitHub compare API to detect when a branch's HEAD is already in main.
In health-monitor.ts reconciliation, fall back to this check when the
tracked PR is not merged. Log distinct events for branch-merge transitions.

Fixes work items stuck in 'reviewing' with a merged branch and open second PR."

git push origin fix/reconciliation-branch-merge-status

gh pr create \
  --title "fix: reconciliation checks branch merge status, not just tracked PR" \
  --body "## Problem

The reconciliation sweep only checked whether the work item's tracked \`prNumber\` was merged. The pipeline creates duplicate PRs on the same branch:
1. Orchestrator creates branch + first PR → auto-merges
2. TLM Code Review opens a **second PR** on the same branch
3. Work item's \`prNumber\` updates to the second (still-open) PR
4. Reconciliation sees second PR as open → never transitions to \`merged\`

## Fix

- Added \`isBranchMergedIntoMain(owner, repo, branch)\` to \`lib/github.ts\` using the GitHub compare API (\`GET /repos/{owner}/{repo}/compare/main...{branch}\`). Returns \`true\` when status is \`behind\` or \`identical\` (all branch commits are in main), or \`true\` on 404 (branch deleted = already cleaned up after merge).
- In \`lib/atc/health-monitor.ts\` reconciliation: after failing the tracked-PR check, fall back to branch-merge detection. Emits a distinct \`branch_merge_reconciled\` event for observability.
- Handles the 404 case (branch deleted post-merge) as a merged signal.

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Existing tests pass

## Risk
Medium — touches reconciliation logic. The fallback only fires when the tracked PR is NOT merged, so existing behavior for items with a correctly-tracked merged PR is unchanged."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/reconciliation-branch-merge-status
FILES CHANGED: [list modified files]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [remaining steps — e.g., "Step 5 (duplicate PR guard) not implemented", "Type error in lib/github.ts line N"]
```

If blocked by ambiguity (e.g., `WorkItem.branch` field doesn't exist and the field name is unclear, or the GitHub API client pattern is completely different from expected):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-reconciliation-branch-merge-status",
    "reason": "Cannot determine WorkItem branch field name or GitHub API client pattern from existing code",
    "confidenceScore": 0.25,
    "contextSnapshot": {
      "step": "3",
      "error": "Unclear field name for branch on WorkItem type, or unexpected GitHub client pattern in lib/github.ts",
      "filesChanged": ["lib/github.ts"]
    }
  }'
```