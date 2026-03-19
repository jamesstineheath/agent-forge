# Handoff 42: human-approval-auto-merge

## Metadata
- Branch: `feat/human-approval-auto-merge`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $5
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-19
- Executor: Claude Code (GitHub Actions)

## Context

When TLM Code Review returns FLAG_FOR_HUMAN, the PR enters a "Needs Human Review" lifecycle state and waits for the human to decide. But when the human approves the PR (via a GitHub review approval), nothing picks it up — the pipeline has no handler for human approvals. The PR sits in limbo until someone manually merges it.

The webhook system already receives `pull_request_review` events from GitHub. The event reactor (`lib/event-reactor.ts`) handles CI pass/fail, PR merge/close, and workflow completion — but not review approvals.

The fix: add a `github.pr.review_submitted` event handler to the reactor. When a non-bot user submits an APPROVED review on a PR whose work item is in `blocked` or `reviewing` status with a FLAG_FOR_HUMAN lifecycle state, the reactor should merge the PR (using admin override to bypass the failed TLM review check) and transition the work item to `merged`.

Also need to handle the rejection case: when the human closes the PR (already handled by `handlePRClosed`) or leaves a comment like "do not merge" — closing the PR is the signal to retry with feedback.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] pull_request_review events are parsed in the webhook route
- [ ] Bot reviews (github-actions[bot]) are filtered out
- [ ] handleReviewSubmitted only acts on 'approved' state
- [ ] Work item is found by PR number before attempting merge
- [ ] PR merge uses admin override (to bypass failed TLM check status)
- [ ] Work item transitions to merged after successful PR merge
- [ ] dispatchUnblockedItems is called after merge
- [ ] Non-approved reviews (commented, changes_requested) are ignored gracefully

## Step 0: Branch, commit handoff, push

Create branch `feat/human-approval-auto-merge` from `main`. Commit this handoff file. Push.

## Step 1: In `app/api/webhooks/github/route.ts`, ensure `pull_request_review` events are being parsed and forwarded to the event reactor. Map them to a new event type `github.pr.review_submitted` with payload `{ repo, branch, prNumber, reviewer, state, body }`. The reviewer field should be the GitHub username. Filter out reviews from `github-actions[bot]` at the webhook level — we only care about human reviews.

## Step 2: In `lib/event-reactor.ts`, add a new handler `handleReviewSubmitted(event)`. Logic: (a) If `event.payload.state !== 'approved'`, return early — we only auto-merge on approval. (b) Find the work item via `findWorkItemByPR(event.repo, event.payload.prNumber)`. (c) If no item found or item status is not `blocked` or `reviewing`, return early. (d) Merge the PR using the GitHub API with admin override: `PUT /repos/{owner}/{repo}/pulls/{prNumber}/merge` with `merge_method: 'squash'` and admin headers. Use the existing GitHub utility functions. (e) Transition the work item to `merged`. (f) Call `dispatchUnblockedItems()` to cascade. (g) Log: `[reactor] human approved PR #{prNumber} — auto-merging`.

## Step 3: Wire the new event type in the `reactToEvent()` switch/dispatch in `lib/event-reactor.ts`. Add `case 'github.pr.review_submitted': return handleReviewSubmitted(event)`.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: human-approval-auto-merge (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/human-approval-auto-merge",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```