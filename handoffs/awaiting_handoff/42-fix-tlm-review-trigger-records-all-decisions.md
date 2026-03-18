# Handoff 42: fix-tlm-review-trigger-records-all-decisions

## Metadata
- Branch: `fix/tlm-review-records-all-decisions`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $5
- Risk Level: medium
- Complexity: moderate
- Depends On: None
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

The TLM Feedback Compiler found that 43/45 recent PRs have tlm_decision = "unknown" in the Outcome Tracker. Root cause: the `tlm-review.yml` workflow only runs the full Code Review on `check_suite` events when `conclusion == 'success'`. When CI fails, only placeholder comments ("CI Pending"/"CI Failing") are posted — no full review decision is recorded. The Outcome Tracker parses PR reviews looking for "TLM Review:" with decision keywords (APPROVE, REQUEST_CHANGES, FLAG FOR HUMAN). Without a full review, it defaults to "unknown". This breaks the entire self-learning loop: the Feedback Compiler can't analyze decision quality if 95% of decisions aren't recorded.

Evidence:
- PR #231 (CI passed): full review posted, decision = "flag_for_human" ✓  
- PR #268 (CI failed): only placeholders, decision = "unknown" ✗
- Only 3/45 recent PRs have recorded decisions

The Code Reviewer action (`.github/actions/tlm-review/src/index.ts`) already has a `checkCIStatus()` function that returns early with "CI Pending" or "CI Failing" comments. The fix: let the review run to completion even when CI fails, but record a decision of "defer" or "ci_blocked" instead of approving. This way the Outcome Tracker always has a decision to read.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm .github/actions/tlm-review/src/index.ts has checkCIStatus() function
- [ ] Confirm .github/actions/tlm-outcome-tracker/src/index.ts parses TLM decisions from PR reviews
- [ ] Confirm tlm-review.yml has the check_suite conclusion == success filter

## Step 0: Branch, commit handoff, push

Create branch `fix/tlm-review-records-all-decisions` from `main`. Commit this handoff file. Push.

## Step 1: Read `.github/workflows/tlm-review.yml` and `.github/actions/tlm-review/src/index.ts` to understand current trigger logic and the `checkCIStatus()` early return path

## Step 2: Change `tlm-review.yml` trigger condition: remove the `conclusion == 'success'` filter so the workflow runs on ALL `check_suite.completed` events. The action's own `checkCIStatus()` handles CI-failed logic internally.

## Step 3: Update the Code Reviewer action (`index.ts`): when `checkCIStatus()` detects CI failure, instead of returning early with just a comment, still post a formal review body that includes 'TLM Review: CI_BLOCKED' (or similar) so the Outcome Tracker can parse it. The review should NOT approve the PR — it should use `REQUEST_CHANGES` or `COMMENT` event type.

## Step 4: Update the Outcome Tracker (`tlm-outcome-tracker/src/index.ts`): add 'ci_blocked' as a recognized TLM decision. When parsing reviews, detect 'CI_BLOCKED' keyword and set `tlmDecision = 'ci_blocked'`.

## Step 5: Verify: check that the `checkCIStatus()` function still correctly defers approval when CI is pending (not just failed). The 'CI Pending' path should also record a decision if possible, but this is lower priority since pending PRs aren't merged.

## Step 6: Build and verify: `npx tsc --noEmit` in the action directories

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-tlm-review-trigger-records-all-decisions (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/tlm-review-records-all-decisions",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```