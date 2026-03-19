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

The webhook system already receives `pull_request_review` and `issue_comment` events from GitHub. The event reactor needs handlers for human responses:

1. **Human approves** → auto-merge the PR with admin override, transition work item to merged, cascade unblocked items.
2. **Human comments with feedback** → re-trigger execution with the human's feedback incorporated.
3. **Human closes the PR** → already handled by `handlePRClosed`.

**IMPORTANT — approval detection:** The repo owner cannot use GitHub's formal "Approve" review button because the pipeline opens PRs under their PAT (making them the author, and GitHub blocks self-approval). Instead, approval must be detected from **owner comments** containing approval language. Define an `APPROVAL_PATTERNS` array: `['approve', 'approved', 'lgtm', 'looks good', 'merge', 'ship it']`. If the owner's comment (lowercased, trimmed) matches any pattern or starts with any pattern, treat it as approval. All other owner comments are treated as feedback for re-execution.

Bot users (`github-actions[bot]`, `vercel[bot]`) are always filtered out. Only comments from the repo owner trigger actions.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] issue_comment events on PRs are parsed in the webhook route
- [ ] pull_request_review events are parsed in the webhook route (as a secondary approval path)
- [ ] Bot reviews/comments are filtered out
- [ ] Only repo owner comments/reviews trigger actions
- [ ] Owner comments matching APPROVAL_PATTERNS trigger auto-merge with admin override
- [ ] Owner comments NOT matching approval patterns re-trigger execution with feedback
- [ ] Formal PR review approvals also trigger auto-merge (secondary path)
- [ ] Work item is found by PR number before attempting any action
- [ ] Only acts on items in `blocked` status (FLAG_FOR_HUMAN items)
- [ ] dispatchUnblockedItems is called after merge

## Step 0: Branch, commit handoff, push

Create branch `feat/human-approval-auto-merge` from `main`. Commit this handoff file. Push.

## Step 1: In `app/api/webhooks/github/route.ts`, ensure both `pull_request_review` and `issue_comment` events are parsed and forwarded to the event reactor.

For `issue_comment` on PRs (GitHub sends `issue_comment` for PR comments — check for `issue.pull_request` in the payload): map to event type `github.pr.comment` with payload `{ repo, prNumber, author, body }`. Filter out bot users.

For `pull_request_review`: map to event type `github.pr.review_submitted` with payload `{ repo, branch, prNumber, reviewer, state, body }`. Filter out bot reviews.

## Step 2: In `lib/event-reactor.ts`, add handler `handleOwnerComment(event)` — this is the PRIMARY human response handler:
(a) Find the work item via `findWorkItemByPR(event.repo, event.payload.prNumber)`.
(b) If no item found or item status is not `blocked`, return early — only act on FLAG_FOR_HUMAN items.
(c) Check if the comment matches approval patterns. Define `APPROVAL_PATTERNS = ['approve', 'approved', 'lgtm', 'looks good', 'merge', 'ship it']`. Normalize the comment: `comment.trim().toLowerCase()`. Match if the normalized comment equals any pattern OR starts with any pattern followed by a space/punctuation/end-of-string.
(d) **If approval:** Merge the PR using the GitHub API with admin override (`PUT /repos/{owner}/{repo}/pulls/{prNumber}/merge` with `merge_method: 'squash'`). Transition work item to `merged`. Call `dispatchUnblockedItems()`. Log: `[reactor] owner approved PR #{prNumber} via comment — auto-merging`.
(e) **If feedback:** Re-trigger the `execute-handoff.yml` workflow via `workflow_dispatch` with the existing branch. Pass the human's comment as additional context (add a `human_feedback` input to the workflow dispatch, or append it to the handoff file on the branch). Transition from `blocked` to `executing`. Log: `[reactor] owner feedback on PR #{prNumber} — re-triggering execution`.

## Step 3: In `lib/event-reactor.ts`, add handler `handleReviewSubmitted(event)` as a SECONDARY approval path:
(a) If `event.payload.state !== 'approved'`, return early.
(b) Find work item via `findWorkItemByPR`. If not found or not `blocked`, return early.
(c) Same merge logic as Step 2d.
This handles the case where someone with a different GitHub account (not the PAT owner) approves.

## Step 4: Wire both event types in `reactToEvent()`:
- `case 'github.pr.comment': return handleOwnerComment(event)`
- `case 'github.pr.review_submitted': return handleReviewSubmitted(event)`

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
