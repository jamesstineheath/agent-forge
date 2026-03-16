# Agent Forge -- Fix "Ensure PR Exists" Fallback Creating Duplicate PRs

## Metadata
- **Branch:** `fix/ensure-pr-exists-duplicate-pr-bug`
- **Priority:** high
- **Model:** sonnet
- **Type:** bugfix
- **Max Budget:** $3
- **Risk Level:** low
- **Estimated files:** .github/workflows/execute-handoff.yml

## Context

The `execute-handoff.yml` workflow has an "Ensure PR exists (fallback)" step that creates a new PR if no open PR is found on the execution branch. Since `allow_auto_merge: true` is now enabled at the repo level, the PR that Claude Code creates in Step 12 frequently auto-merges in 5-10 seconds (especially for fast CI builds). By the time the fallback step runs, there's no open PR — but the commits are already in `main`. The fallback step doesn't detect this and creates a second stale PR on the same branch.

This produced 5 duplicate stale PRs today alone (PRs #95, #100, #105, #107, #109 — all duplicates of already-merged PRs #94, #99, #104, #106, #108). Each stale PR triggers CI, QA Agent, and TLM Review runs unnecessarily, corrupts work item state, and wastes pipeline budget.

## Root Cause

The "Ensure PR exists (fallback)" step:
1. Checks: `gh pr list --head $BRANCH --state open` — returns empty after auto-merge
2. If empty: creates a new PR via `gh pr create`
3. Missing check: whether branch commits are already in `main`

## Requirements

1. Read `.github/workflows/execute-handoff.yml` to find the exact "Ensure PR exists (fallback)" step
2. Add a merged-branch guard at the start of that step, before any PR creation logic
3. Guard logic: if branch tip is already an ancestor of `origin/main`, log a message and exit 0
4. The existing PR creation logic must be preserved for the genuine fallback case (branch not yet merged, no open PR)
5. `npx tsc --noEmit` still passes (YAML change, not TypeScript, but ensure no other files touched accidentally)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/ensure-pr-exists-duplicate-pr-bug
```

### Step 1: Read the workflow file
```bash
cat .github/workflows/execute-handoff.yml
```

Find the "Ensure PR exists (fallback)" step. Note the exact bash commands in it.

### Step 2: Add the merged-branch guard

The guard to add at the TOP of the "Ensure PR exists (fallback)" step's `run:` block (before any `gh pr` commands):

```bash
# Guard: skip if branch commits are already merged into main
git fetch origin main --quiet
BRANCH_TIP=$(git rev-parse "origin/${BRANCH_NAME}" 2>/dev/null || echo "")
if [ -n "$BRANCH_TIP" ]; then
  if git merge-base --is-ancestor "$BRANCH_TIP" origin/main 2>/dev/null; then
    echo "Branch ${BRANCH_NAME} is already merged into main — skipping fallback PR creation (auto-merge fired before this step ran)"
    exit 0
  fi
fi
```

The variable `BRANCH_NAME` should already be set in the step's environment (it's used in `gh pr list --head $BRANCH_NAME`). If the step uses a different variable name for the branch, use that name instead.

### Step 3: Verify the change looks correct
```bash
cat .github/workflows/execute-handoff.yml | grep -A 30 "Ensure PR exists"
```

Confirm:
- The guard appears before any `gh pr create` or `gh pr list` calls
- The guard uses the correct branch variable name
- The `exit 0` only fires when the branch is already in main

### Step 4: Validate YAML syntax
```bash
# Quick syntax check
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/execute-handoff.yml'))" && echo "YAML valid"
```

If Python3 isn't available:
```bash
npx js-yaml .github/workflows/execute-handoff.yml > /dev/null && echo "YAML valid"
```

### Step 5: Commit, push, open PR
```bash
git add .github/workflows/execute-handoff.yml
git commit -m "fix: skip fallback PR creation when branch already merged into main

The 'Ensure PR exists' fallback step in execute-handoff.yml was creating
duplicate PRs after auto-merge fired. With allow_auto_merge enabled, the
Claude-created PR merges in ~5-10s, so the fallback step finds no open
PR and creates a second stale one pointing to commits already in main.

Fix: check if branch tip is already an ancestor of origin/main before
attempting fallback PR creation. If merged, exit 0 silently.

Root cause identified after 5 duplicate PRs (#95, #100, #105, #107, #109)
were created in a single day, each requiring manual closure and work item
state correction."
git push origin fix/ensure-pr-exists-duplicate-pr-bug
gh pr create \
  --title "fix: skip fallback PR creation when branch already merged into main" \
  --body "## Problem

The 'Ensure PR exists (fallback)' step in \`execute-handoff.yml\` creates a new PR when no open PR exists on the execution branch. With \`allow_auto_merge: true\` enabled, the Claude-created PR auto-merges in 5-10 seconds. The fallback step then creates a second stale PR on the same branch pointing to commits already in \`main\`.

This created 5 duplicate PRs today alone (#95, #100, #105, #107, #109), each requiring manual closure and work item state correction.

## Fix

Added a merged-branch guard at the start of the fallback step:
\`\`\`bash
git fetch origin main --quiet
BRANCH_TIP=\$(git rev-parse \"origin/\${BRANCH_NAME}\" 2>/dev/null || echo \"\")
if [ -n \"\$BRANCH_TIP\" ]; then
  if git merge-base --is-ancestor \"\$BRANCH_TIP\" origin/main 2>/dev/null; then
    echo \"Branch already merged — skipping fallback PR creation\"
    exit 0
  fi
fi
\`\`\`

## Risk

Low — only affects the fallback step. Genuine fallback case (branch not yet merged, no open PR) is unchanged.

## Acceptance Criteria
- [x] When branch is already merged, fallback step exits without creating PR
- [x] When branch is not merged and no open PR exists, fallback step still creates PR
- [x] YAML syntax valid" \
  --base main
```

## Session Abort Protocol

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/ensure-pr-exists-duplicate-pr-bug
FILES CHANGED: .github/workflows/execute-handoff.yml
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
