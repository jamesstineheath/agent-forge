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

When TLM Code Review returns FLAG_FOR_HUMAN, the PR enters a "Needs Human Review" lifecycle state and waits for the human to decide. But when the human responds, nothing picks it up — the pipeline has no handler for human responses on flagged PRs.

The webhook system already receives `pull_request_review` and `issue_comment` events from GitHub. The event reactor needs three new handlers:

1. **Human approves** (PR review with state=approved) → auto-merge the PR with admin override, transition work item to merged, cascade unblocked items.
2. **Human comments with feedback** (issue_comment on a flagged PR from the repo owner, not a review approval) → re-trigger execution with the human's feedback incorporated. The executor should see the comment as additional context and push updated code to the same branch/PR.
3. **Human closes the PR** → already handled by `handlePRClosed` — marks item failed and retries with feedback.

The repo owner is identified by checking the sender against the repo owner (use `GITHUB_REPOSITORY_OWNER` env var or fetch from the repo API). Bot users (`github-actions[bot]`, `vercel[bot]`) are always filtered out.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] pull_request_review events are parsed in the webhook route
- [ ] issue_comment events on PRs are parsed in the webhook route
- [ ] Bot reviews/comments are filtered out
- [ ] Only repo owner comments/reviews trigger actions (not random collaborators)
- [ ] handleReviewSubmitted merges on approval with admin override
- [ ] handleHumanFeedback re-triggers execution with comment as context
- [ ] Work item is found by PR number before attempting any action
- [ ] dispatchUnblockedItems is called after merge

## Step 0: Branch, commit handoff, push

Create branch `feat/human-approval-auto-merge` from `main`. Commit this handoff file. Push.

## Step 1: In `app/api/webhooks/github/route.ts`, ensure both `pull_request_review` and `issue_comment` events are parsed and forwarded to the event reactor.

For `pull_request_review`: map to event type `github.pr.review_submitted` with payload `{ repo, branch, prNumber, reviewer, state, body }`. Filter out reviews from bot users (`github-actions[bot]`).

For `issue_comment` on PRs (GitHub sends issue_comment for PR comments too — check for `issue.pull_request` in the payload): map to event type `github.pr.comment` with payload `{ repo, prNumber, author, body }`. Filter out bot users. Only forward if the author matches the repo owner.

## Step 2: In `lib/event-reactor.ts`, add handler `handleReviewSubmitted(event)`:
(a) If `event.payload.state !== 'approved'`, return early.
(b) Find the work item via `findWorkItemByPR(event.repo, event.payload.prNumber)`.
(c) If no item found or item status is not `blocked` or `reviewing`, return early.
(d) Merge the PR using the GitHub API with admin override: `PUT /repos/{owner}/{repo}/pulls/{prNumber}/merge` with `merge_method: 'squash'`. Use existing GitHub utility functions.
(e) Transition the work item to `merged`.
(f) Call `dispatchUnblockedItems()` to cascade.
(g) Log: `[reactor] human approved PR #{prNumber} — auto-merging`.

## Step 3: In `lib/event-reactor.ts`, add handler `handleHumanFeedback(event)`:
(a) Find the work item via `findWorkItemByPR(event.repo, event.payload.prNumber)`.
(b) If no item found or item status is not `blocked`, return early — only act on FLAG_FOR_HUMAN items.
(c) Re-trigger the `execute-handoff.yml` workflow via `workflow_dispatch` with the existing branch. Pass the human's comment as additional context (add a `human_feedback` input to the workflow dispatch payload if needed, or append it to the handoff file on the branch).
(d) Transition the work item from `blocked` back to `executing`.
(e) Log: `[reactor] human feedback on PR #{prNumber} — re-triggering execution`.

## Step 4: Wire both new event types in `reactToEvent()`:
- `case 'github.pr.review_submitted': return handleReviewSubmitted(event)`
- `case 'github.pr.comment': return handleHumanFeedback(event)`

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
