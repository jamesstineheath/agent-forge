# Handoff 39: fix-blocked-item-merge-reconciliation

## Metadata
- Branch: `fix/blocked-item-merge-reconciliation`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-19
- Executor: Claude Code (GitHub Actions)

## Context

When a work item is in `blocked` status and its PR merges, the pipeline never detects the merge. This causes items to sit in `blocked` forever despite their work being done.

Root cause: Neither the event reactor nor the health monitor can find blocked items when a PR merges:
- `findWorkItemByBranch()` in `lib/work-items.ts` scans: `executing, reviewing, retrying, merged` — missing `blocked`
- `findWorkItemByPR()` in `lib/work-items.ts` scans: `executing, reviewing, retrying, merged, failed` — missing `blocked`
- Health monitor checks for merged PRs on `executing` (lines ~398-426), `reviewing` (lines ~599-627), and `failed` (section 2.8, lines ~815-849) items — but never `blocked` items

This was discovered when 7 blocked items were found whose PRs had already merged but the work item status was never updated. All had to be manually reconciled.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] findWorkItemByBranch includes 'blocked' in scan list
- [ ] findWorkItemByPR includes 'blocked' in scan list
- [ ] Health monitor has blocked-item merge reconciliation section
- [ ] No changes to terminal status guards or other reconciliation logic

## Step 0: Branch, commit handoff, push

Create branch `fix/blocked-item-merge-reconciliation` from `main`. Commit this handoff file. Push.

## Step 1: In `lib/work-items.ts`, add `'blocked'` to the status scan list in `findWorkItemByBranch()` (currently `['executing', 'reviewing', 'retrying', 'merged']`). Change to `['executing', 'reviewing', 'retrying', 'merged', 'blocked']`.

## Step 2: In `lib/work-items.ts`, add `'blocked'` to the status scan list in `findWorkItemByPR()` (currently `['executing', 'reviewing', 'retrying', 'merged', 'failed']`). Change to `['executing', 'reviewing', 'retrying', 'merged', 'failed', 'blocked']`.

## Step 3: In `lib/atc/health-monitor.ts`, add a new reconciliation section (after the existing section 2.8 failed reconciliation) that scans `blocked` items with a `prNumber` or `branch`. For each, check if the PR is merged via `getPRByNumber()`. If merged, transition `blocked -> merged`, trigger incremental re-index, and call `dispatchUnblockedItems()`. Log as `[health-monitor] §2.9 reconciled blocked item {id} — PR already merged`.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-blocked-item-merge-reconciliation (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/blocked-item-merge-reconciliation",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```