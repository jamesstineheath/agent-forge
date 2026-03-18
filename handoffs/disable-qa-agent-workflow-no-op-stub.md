<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Disable QA Agent Workflow (No-Op Stub)

## Metadata
- **Branch:** `fix/disable-qa-agent-stub`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/workflows/tlm-qa-agent.yml

## Context

The QA Agent workflow (`tlm-qa-agent.yml`) has accumulated 327 runs as a pure no-op stub. The entry point `run-qa.ts` logs "stub — no tests to run yet" and exits 0 — it never executes any smoke tests, never posts PR comments, and never catches any issues. This wastes CI minutes and creates noise in the workflow run history.

The scaffolding code (smoke-test.ts, format-comment.ts, parse-criteria.ts, system-prompt.md) should be preserved for future completion. Only the workflow trigger needs to be disabled.

This is a surgical, low-risk change: add `if: false` to the workflow's job(s) so GitHub Actions skips execution entirely, while keeping the workflow file in place for easy re-enablement when the actual implementation is ready.

No files from concurrent work items (`lib/debate/types.ts`, `lib/debate/config.ts`) overlap with this change.

## Requirements

1. The `tlm-qa-agent.yml` workflow must no longer execute any steps when triggered.
2. The disable mechanism must be `if: false` on the job level (not file rename, not deleting the workflow) so it can be re-enabled by a one-line edit.
3. A comment must be added near the `if: false` explaining why it is disabled and what needs to happen before re-enabling.
4. All scaffolding files (`smoke-test.ts`, `format-comment.ts`, `parse-criteria.ts`, `system-prompt.md`, `run-qa.ts`) must remain untouched.
5. No other files are modified.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/disable-qa-agent-stub
```

### Step 1: Inspect the current workflow file

```bash
cat .github/workflows/tlm-qa-agent.yml
```

Note the job name(s) defined in the workflow. There may be one or more jobs. Identify each top-level job key under the `jobs:` block.

### Step 2: Add `if: false` to each job

For **every job** defined under `jobs:` in `.github/workflows/tlm-qa-agent.yml`, add an `if: false` condition with an explanatory comment. The edit should look like this pattern:

```yaml
jobs:
  qa-agent:  # (replace with actual job name)
    # DISABLED: This workflow is a no-op stub (327 runs, 0 tests executed).
    # Re-enable once smoke-test.ts, format-comment.ts, parse-criteria.ts, and
    # system-prompt.md are wired up to actually run tests.
    # See self-learning audit 2026-03-18 and plan misty-greeting-wreath.md.
    if: false
    runs-on: ubuntu-latest
    # ... rest of job unchanged ...
```

Do **not** modify the `on:` triggers block, the workflow name, any `env:` blocks, or any step definitions. Only insert the `if: false` line (and comment) immediately after each job name line.

### Step 3: Verify the file is valid YAML

```bash
python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/tlm-qa-agent.yml')); print('YAML valid')"
```

If Python is not available, use:
```bash
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/tlm-qa-agent.yml','utf8')); console.log('YAML valid')"
```

### Step 4: Confirm no other files were modified

```bash
git diff --name-only
```

Expected output: only `.github/workflows/tlm-qa-agent.yml`

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

TypeScript and build checks should pass (this change touches no TypeScript files).

### Step 6: Commit, push, open PR

```bash
git add .github/workflows/tlm-qa-agent.yml
git commit -m "fix: disable QA agent workflow stub (327 no-op runs)

The tlm-qa-agent workflow has run 327 times as a pure stub.
run-qa.ts logs 'stub - no tests to run yet' and exits 0.
Zero tests executed, zero PR comments posted.

Disable by adding \`if: false\` to the job. Scaffolding code
(smoke-test.ts, format-comment.ts, parse-criteria.ts,
system-prompt.md) is preserved for future implementation.

Part of self-learning audit 2026-03-18."

git push origin fix/disable-qa-agent-stub

gh pr create \
  --title "fix: disable QA agent workflow stub (327 no-op runs)" \
  --body "## Summary

Disables the \`tlm-qa-agent.yml\` workflow by adding \`if: false\` to the job. The workflow has run 327 times as a pure no-op stub — \`run-qa.ts\` logs 'stub — no tests to run yet' and exits 0.

## Changes

- \`.github/workflows/tlm-qa-agent.yml\`: Added \`if: false\` with explanatory comment to the job definition

## What's preserved

All scaffolding code is untouched:
- \`smoke-test.ts\`
- \`format-comment.ts\`
- \`parse-criteria.ts\`
- \`system-prompt.md\`
- \`run-qa.ts\`

## Re-enabling

Remove the \`if: false\` line once the scaffolding modules are wired up to actually execute smoke tests.

## Risk

Low — no TypeScript changes, no logic changes, only disables a workflow that currently does nothing.

Part of self-learning audit 2026-03-18."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/disable-qa-agent-stub
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```