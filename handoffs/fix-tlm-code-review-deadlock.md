# Handoff: Fix TLM Code Review Timing Deadlock

**Priority:** P0
**Max Budget:** $6
**Branch:** fix/tlm-code-review-deadlock

## Problem

TLM Code Review never actually reviews PRs due to a timing deadlock between two trigger paths:

1. **`pull_request` trigger (opened/synchronize/reopened):** CI hasn't started yet, so `checkCIStatus()` returns `"pending"`. The action defers with `ci_pending` and exits. CI later passes, but nothing re-triggers the review.

2. **`check_suite` trigger (completed):** CI finishes and fires this event. However, `context.payload.check_suite.pull_requests` is frequently an empty array (GitHub does not reliably populate this field, especially for PRs created by bots or via API). The action sees no PR number and exits with "No PR associated with this event, skipping review."

The net result: Claude API is never called. No PR ever gets reviewed or auto-merged by TLM.

### Secondary Issue: Bot PR Skip

The current bot detection logic skips PRs authored by `github-actions[bot]`, which is exactly who creates pipeline PRs via execute-handoff. This needs to be removed or scoped so pipeline PRs are reviewed.

## Pre-flight Self-check

- [ ] Read `.github/actions/tlm-review/src/index.ts` fully before making changes
- [ ] Read `.github/workflows/tlm-review.yml` to understand trigger configuration
- [ ] Understand the composite action structure in `.github/actions/tlm-review/action.yml`

## Steps

### Step 0: Branch setup
Branch `fix/tlm-code-review-deadlock` already exists from `main`. Commit and push all changes to this branch.

### Step 1: Fix `check_suite` handler to find PRs by SHA

In `.github/actions/tlm-review/src/index.ts`, when the `check_suite` event fires and `pull_requests` array is empty, query the GitHub API for open PRs whose HEAD SHA matches the check suite's head SHA:

```typescript
// After existing check_suite.pull_requests check fails:
if (!prNumber && context.eventName === "check_suite") {
  const headSha = context.payload.check_suite?.head_sha;
  if (headSha) {
    // Query for open PRs matching this SHA
    const { data: pulls } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 10,
    });
    const matchingPr = pulls.find(p => p.head.sha === headSha);
    if (matchingPr) {
      prNumber = matchingPr.number;
      core.info(`Found PR #${prNumber} by SHA match for check_suite event`);
    }
  }
}
```

This eliminates the deadlock: when CI completes, the check_suite handler can always find the associated PR.

### Step 2: Remove bot-author skip logic

Remove or modify the block that skips PRs authored by bots:

```typescript
// REMOVE this block:
if (pr.user?.type === "Bot" || pr.user?.login?.includes("[bot]")) {
  core.info("PR authored by bot, skipping review.");
  return;
}
```

Pipeline PRs are created by `github-actions[bot]` via execute-handoff and must be reviewed by TLM. If we need to skip certain bot PRs in the future, we can add a label-based or branch-name-based filter instead.

### Step 3: Add retry/backoff for CI pending on pull_request events

When the `pull_request` trigger fires and CI is pending, instead of immediately deferring, add a short poll (up to 60 seconds, checking every 15s) to see if CI completes quickly:

```typescript
if (context.eventName === "pull_request" && ciStatus === "pending") {
  core.info("CI is pending, waiting up to 60s for completion...");
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 15000));
    ciStatus = await checkCIStatus(octokit, owner, repo, pr.head.sha, prNumber);
    if (ciStatus !== "pending") break;
  }
  if (ciStatus === "pending") {
    core.info("CI still pending after 60s, deferring to check_suite handler.");
    core.setOutput("decision", "ci_pending");
    core.setOutput("summary", "CI is pending, deferring review to check_suite event.");
    return;
  }
}
```

This handles fast CI runs without needing the check_suite fallback, while still falling through to check_suite for longer CI runs.

### Step 4: Build and verify

```bash
cd .github/actions/tlm-review
npm run build   # or equivalent build command
```

Ensure the compiled output (`dist/`) is updated and committed.

### Step 5: Verify no regressions in workflow file

Confirm `.github/workflows/tlm-review.yml` trigger configuration still correctly includes both `pull_request` and `check_suite` events. No changes should be needed to the workflow file itself.

## Abort Protocol

If you cannot locate the TLM review action source at `.github/actions/tlm-review/src/index.ts`, or the code structure has changed significantly from what's described, stop and report. Do not guess at the file structure.

## Expected Outcome

After this fix:
- `check_suite` completed events reliably find the associated PR via SHA lookup
- Pipeline PRs from `github-actions[bot]` are reviewed instead of skipped
- Fast CI runs get reviewed directly on the `pull_request` event
- Slow CI runs defer to `check_suite`, which now works correctly
- Auto-merge fires after successful review
