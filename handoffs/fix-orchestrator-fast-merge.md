# Handoff: Fix Orchestrator state machine for fast-path merges

**Priority:** P1
**Max Budget:** $5
**Branch:** fix/orchestrator-fast-merge-transition

## Problem

The Handoff Lifecycle Orchestrator crashes with `Invalid transition: SpecReview -> Merged` when Code Review auto-merges a PR before the lifecycle advances past `SpecReview`. This causes 8 of 12 recent pipeline failures — all false negatives where the work actually completed successfully but was marked failed.

The state machine expects the lifecycle to advance through intermediate states (`SpecReview → CodeReview → Approved → Merged`), but when auto-merge happens quickly, the `pull_request.closed` event arrives while the state is still `SpecReview`.

Collateral damage: the "failed" status triggers retries, which create orphaned duplicate PRs.

## Pre-flight Self-check

- [ ] Read `.github/workflows/handoff-orchestrator.yml` — find the state machine / lifecycle transition logic
- [ ] Identify the valid transitions map/object
- [ ] Find where `Invalid transition` error is thrown
- [ ] Identify all workflow events that trigger the orchestrator (push, pull_request, workflow_run, etc.)

## Step 0: Branch + Commit Setup

```
git checkout main && git pull origin main
git checkout -b fix/orchestrator-fast-merge-transition
```

## Step 1: Add fast-path merge transitions

Find the state machine transitions (likely a map of `currentState → allowedNextStates` or a validation function). Add these fast-path transitions:

- `SpecReview → Merged` (PR merged during or right after spec review)
- `SpecReview → CodeReview` (if not already present)

The key insight: when a PR is merged, the orchestrator should accept the merge from ANY pre-terminal state, not just `Approved` or `CodeReview`. A merge is a terminal event — if it happened, the work is done regardless of where the lifecycle thought it was.

## Step 2: Handle gracefully instead of crashing

Where the `Invalid transition` error is thrown, change the behavior:
- If the target state is `Merged` and the PR is confirmed merged (check `pull_request.merged === true`), accept the transition regardless of current state
- Log a warning instead of crashing: `[orchestrator] Fast-path merge: ${currentState} → Merged (skipped intermediate states)`
- Still update the lifecycle state to `Merged`

## Step 3: Clean up orphaned PRs (manual list)

After fixing the state machine, these orphaned duplicate PRs in personal-assistant should be closed:
- PR #283
- PR #281
- PR #278
- PR #274
- PR #272

Use `gh pr close <number> --repo jamesstineheath/personal-assistant` for each.

## Step 4: Verification

- `npx tsc --noEmit` must pass
- `npm run build` must succeed
- Grep for `Invalid transition` — should no longer be thrown when target is `Merged`

## Abort Protocol

If the state machine is not in the orchestrator workflow or is structured very differently than expected (e.g., uses an external state management system), stop and report.

## Acceptance Criteria

1. `SpecReview → Merged` transition is valid
2. Any-state → `Merged` is accepted when `pull_request.merged === true`
3. Warning logged for fast-path merges instead of crash
4. TypeScript and build pass
5. Orphaned PRs in personal-assistant closed
