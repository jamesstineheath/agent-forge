# Handoff: Fix CI trigger for bot-created PRs

**Priority:** P1
**Max Budget:** $3
**Branch:** fix/ci-trigger-bot-prs

## Problem

PRs created by `github-actions[bot]` using `GITHUB_TOKEN` don't fire `pull_request` events (GitHub's infinite-loop prevention). This means `ci.yml` (which triggers on `pull_request`) never runs on executor-created PRs, causing them to time out waiting for CI.

The spec-review workflow works because it triggers on `push` (not `pull_request`).

## Pre-flight Self-check

- [ ] Read `.github/workflows/execute-handoff.yml` — find where PRs are created
- [ ] Read `.github/workflows/ci.yml` — confirm it triggers on `pull_request`
- [ ] Confirm `GH_PAT` secret is referenced in execute-handoff.yml

## Step 0: Branch + Commit Setup

```
git checkout main && git pull origin main
git checkout -b fix/ci-trigger-bot-prs
```

## Step 1: Add close/reopen step to execute-handoff.yml

In `.github/workflows/execute-handoff.yml`, add a new step AFTER the step that creates or ensures a PR exists. This step closes and reopens the PR using `GH_PAT` to trigger the `pull_request` event for CI:

```yaml
- name: Trigger CI on bot-created PR
  if: success()
  env:
    GITHUB_TOKEN: ${{ secrets.GH_PAT }}
  run: |
    BRANCH="${{ steps.params.outputs.branch }}"
    # Wait briefly for PR to be indexed
    sleep 5
    PR_NUMBER=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
    if [ -n "$PR_NUMBER" ] && [ "$PR_NUMBER" != "null" ]; then
      echo "Closing and reopening PR #$PR_NUMBER to trigger CI..."
      gh pr close "$PR_NUMBER" --repo "${{ github.repository }}"
      sleep 2
      gh pr reopen "$PR_NUMBER" --repo "${{ github.repository }}"
      echo "CI should now be triggered for PR #$PR_NUMBER"
    else
      echo "No open PR found for branch $BRANCH, skipping CI trigger"
    fi
```

**Important:** The `GITHUB_TOKEN` must be set to `GH_PAT` (not the default `GITHUB_TOKEN`) so the close/reopen events are attributed to a real user, bypassing GitHub's bot-event suppression.

Also do the same for the personal-assistant repo's execute-handoff workflow if it has one. Check `.github/workflows/execute-handoff.yml` in `jamesstineheath/personal-assistant`.

## Step 2: Verify the step reference

Make sure the `steps.params.outputs.branch` reference is correct. Read the workflow to find the actual step ID that outputs the branch name. Adjust the reference accordingly.

## Step 3: Verification

- The YAML must be valid (no syntax errors)
- `GH_PAT` is used (not default GITHUB_TOKEN) for the close/reopen

## Abort Protocol

If `execute-handoff.yml` doesn't create PRs or uses a completely different structure than expected, stop and report. If `GH_PAT` secret is not referenced anywhere in the workflow, stop and report — it means PAT-based auth isn't set up.

## Acceptance Criteria

1. New "Trigger CI on bot-created PR" step exists in execute-handoff.yml
2. Step uses `GH_PAT` for auth
3. Step runs after PR creation
4. YAML is syntactically valid
