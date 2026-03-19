<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Re-enable QA Agent Workflow with Increased Warmup

## Metadata
- **Branch:** `feat/re-enable-qa-agent-warmup`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `.github/workflows/tlm-qa-agent.yml`, `.github/actions/tlm-qa-agent/action.yml`

## Context

The QA Agent workflow was previously disabled with an `if: false` guard (added in a prior PR: "feat: enable QA Agent workflow for Vercel preview deployments"). Now that the QA Agent Orchestrator work item has been merged, the guard needs to be removed and the warmup parameters need to be increased to give the deployment adequate time to become healthy before QA tests begin.

The current warmup is insufficient for production/preview deployments. Increasing to 6 retries at 15s intervals gives a 90s total warmup window, which is more robust. A `timeout-minutes: 5` cap prevents runaway executions.

Additionally, the action's `repo` input should be made optional (defaulting to `github.repository`) so it can be called without explicitly passing the repo in all contexts.

## Requirements

1. Remove `if: false` guard from `.github/workflows/tlm-qa-agent.yml` so the workflow runs on triggered events.
2. Add `repo` input to the "Run QA Agent" step in `.github/workflows/tlm-qa-agent.yml`.
3. Increase warmup to 6 retries at 15s intervals (90s total) in `.github/workflows/tlm-qa-agent.yml`.
4. Add `timeout-minutes: 5` to the "Run QA Agent" step in `.github/workflows/tlm-qa-agent.yml`.
5. Make the `repo` input optional with default `${{ github.repository }}` in `.github/actions/tlm-qa-agent/action.yml`.
6. No other logic changes — this is a targeted configuration update only.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/re-enable-qa-agent-warmup
```

### Step 1: Inspect current state of both files

Read the files to understand the exact current structure before making changes:

```bash
cat .github/workflows/tlm-qa-agent.yml
cat .github/actions/tlm-qa-agent/action.yml
```

Note the exact location of:
- The `if: false` guard (likely on the job or a step)
- The current warmup retry/interval configuration
- The existing inputs block in `action.yml`

### Step 2: Update `.github/workflows/tlm-qa-agent.yml`

Make the following targeted changes:

1. **Remove `if: false`** — Delete the line entirely wherever it appears (job-level or step-level).

2. **Increase warmup parameters** — Find the warmup configuration (likely environment variables or `with:` inputs passed to the action). Change to:
   - Retries: `6`
   - Interval: `15` (seconds)

   Example of what the updated section should look like if passed as `with:` inputs:
   ```yaml
   with:
     warmup-retries: '6'
     warmup-interval: '15'
     repo: ${{ github.repository }}
   ```
   Or if set as env vars, update to match `WARMUP_RETRIES=6` and `WARMUP_INTERVAL=15`.

3. **Add `repo` input** to the "Run QA Agent" step's `with:` block:
   ```yaml
   repo: ${{ github.repository }}
   ```

4. **Add `timeout-minutes: 5`** to the "Run QA Agent" step:
   ```yaml
   - name: Run QA Agent
     timeout-minutes: 5
     uses: ./.github/actions/tlm-qa-agent
     with:
       repo: ${{ github.repository }}
       # ... other existing inputs ...
   ```

### Step 3: Update `.github/actions/tlm-qa-agent/action.yml`

In the `inputs:` block, find or add the `repo` input and make it optional with a default:

```yaml
inputs:
  repo:
    description: 'Repository in owner/repo format'
    required: false
    default: ${{ github.repository }}
  # ... keep all other existing inputs unchanged ...
```

If `repo` input doesn't exist yet, add it. If it exists and is `required: true`, change to `required: false` and add `default: ${{ github.repository }}`.

### Step 4: Verify YAML syntax

```bash
# Check for basic YAML parse errors (if python is available)
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/tlm-qa-agent.yml'))" && echo "workflow OK"
python3 -c "import yaml; yaml.safe_load(open('.github/actions/tlm-qa-agent/action.yml'))" && echo "action OK"
```

If `python3` is unavailable, carefully review the indentation by eye — GitHub Actions YAML is whitespace-sensitive.

### Step 5: Verify no TypeScript or build issues (sanity check)

```bash
npx tsc --noEmit 2>/dev/null || echo "No TS changes, skip"
```

Since these are YAML-only changes, TypeScript compilation is not affected but run as a sanity check.

### Step 6: Commit, push, open PR

```bash
git add .github/workflows/tlm-qa-agent.yml .github/actions/tlm-qa-agent/action.yml
git commit -m "fix: re-enable QA Agent workflow with increased warmup (6x15s=90s)"
git push origin feat/re-enable-qa-agent-warmup
gh pr create \
  --title "fix: re-enable QA Agent workflow with increased warmup" \
  --body "## Summary

Re-enables the QA Agent workflow after QA Agent Orchestrator was merged.

## Changes

### \`.github/workflows/tlm-qa-agent.yml\`
- Removed \`if: false\` guard that was disabling the workflow
- Added \`repo\` input to the Run QA Agent step
- Increased warmup to 6 retries × 15s intervals = 90s total (up from previous lower values)
- Added \`timeout-minutes: 5\` to the Run QA Agent step

### \`.github/actions/tlm-qa-agent/action.yml\`
- Made \`repo\` input optional with default \`\${{ github.repository }}\`

## Risk
Low — YAML config changes only. No logic changes. Increases robustness of deployment warmup window."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/re-enable-qa-agent-warmup
FILES CHANGED: [.github/workflows/tlm-qa-agent.yml, .github/actions/tlm-qa-agent/action.yml]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If the `if: false` guard is not found where expected, or the warmup configuration is structured differently than anticipated (e.g., hardcoded in the action script rather than passed as inputs), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "re-enable-qa-agent-warmup",
    "reason": "Warmup configuration not found in expected location — may be hardcoded in action shell script rather than YAML inputs",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "2",
      "error": "Could not locate warmup retry/interval parameters in YAML files",
      "filesChanged": [".github/workflows/tlm-qa-agent.yml", ".github/actions/tlm-qa-agent/action.yml"]
    }
  }'
```