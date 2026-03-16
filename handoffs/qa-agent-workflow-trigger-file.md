# Agent Forge -- QA Agent Workflow Trigger File

## Metadata
- **Branch:** `feat/tlm-qa-agent-workflow`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/workflows/tlm-qa-agent.yml

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams across multiple repositories. The data plane in each target repo includes several TLM (Team Lead Machine) agents implemented as GitHub Actions composite actions and workflow files.

A QA Agent is being added to the data plane. This task creates the GitHub Actions workflow file (`.github/workflows/tlm-qa-agent.yml`) that triggers the QA Agent composite action (`.github/actions/tlm-qa-agent`, created separately) on deployment events.

The workflow must handle two trigger paths:
1. **Primary**: `deployment_status` event — fires when Vercel posts a preview deployment success, giving us a live preview URL to test against.
2. **Fallback**: `check_suite` completion — for repos that don't use Vercel preview deploys, so the QA agent can still run (though it will skip with a comment if no preview URL is available).

Pattern reference from existing workflows in this repo: look at `.github/workflows/tlm-review.yml` and `.github/workflows/execute-handoff.yml` for permission blocks, secret passing, and job structure conventions.

## Requirements

1. Create `.github/workflows/tlm-qa-agent.yml` with `deployment_status`, `check_suite`, and `workflow_dispatch` triggers.
2. The `deployment_status` trigger must only proceed when `github.event.deployment_status.state == 'success'` (enforced via `if:` condition on the job or a step).
3. Extract preview URL from `github.event.deployment_status.environment_url` for `deployment_status` events, or from `github.event.inputs.preview-url` for `workflow_dispatch`.
4. Find the associated PR number via GitHub API (`gh pr list --search <SHA>`) when triggered by `deployment_status`; use `github.event.inputs.pr-number` for `workflow_dispatch`.
5. Warmup step: `curl` the preview URL root up to 3 times with 10-second intervals between retries, failing gracefully if still unavailable.
6. Call the composite action `.github/actions/tlm-qa-agent` with `preview-url` and `pr-number` inputs.
7. Graceful skip: if triggered by `check_suite` and no preview URL is found, post a PR comment saying "No preview deployment available, QA checks skipped" and exit successfully.
8. Permissions block: `pull-requests: write`, `deployments: read`, `contents: read`.
9. Concurrency group: `qa-agent-${{ github.event.pull_request.number || github.sha }}` with `cancel-in-progress: true`.
10. Pass `ANTHROPIC_API_KEY` and `QA_BYPASS_SECRET` from repo secrets as environment variables to the composite action step.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tlm-qa-agent-workflow
```

### Step 1: Ensure .github/workflows directory exists
```bash
mkdir -p .github/workflows
```

### Step 2: Create the workflow file

Create `.github/workflows/tlm-qa-agent.yml` with the following content:

```yaml
name: TLM QA Agent

on:
  deployment_status:
  check_suite:
    types: [completed]
  workflow_dispatch:
    inputs:
      preview-url:
        description: 'Preview URL to test against'
        required: false
        type: string
      pr-number:
        description: 'Pull request number'
        required: false
        type: string

permissions:
  pull-requests: write
  deployments: read
  contents: read

concurrency:
  group: qa-agent-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: true

jobs:
  qa-agent:
    name: QA Agent
    runs-on: ubuntu-latest
    # For deployment_status: only run on successful preview deployments
    # For check_suite: always run (graceful skip handled in steps)
    # For workflow_dispatch: always run
    if: |
      github.event_name == 'workflow_dispatch' ||
      github.event_name == 'check_suite' ||
      (github.event_name == 'deployment_status' &&
       github.event.deployment_status.state == 'success')

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Extract preview URL and PR number
        id: context
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          PREVIEW_URL=""
          PR_NUMBER=""

          if [[ "${{ github.event_name }}" == "deployment_status" ]]; then
            PREVIEW_URL="${{ github.event.deployment_status.environment_url }}"
            DEPLOY_SHA="${{ github.event.deployment.sha }}"
            echo "Deployment SHA: $DEPLOY_SHA"
            echo "Preview URL from deployment: $PREVIEW_URL"

            # Find associated PR number from the deployment SHA
            if [[ -n "$DEPLOY_SHA" ]]; then
              PR_NUMBER=$(gh pr list \
                --search "$DEPLOY_SHA" \
                --state open \
                --json number \
                --jq '.[0].number // ""' 2>/dev/null || true)
              echo "Found PR number: $PR_NUMBER"
            fi

          elif [[ "${{ github.event_name }}" == "workflow_dispatch" ]]; then
            PREVIEW_URL="${{ github.event.inputs.preview-url }}"
            PR_NUMBER="${{ github.event.inputs.pr-number }}"
            echo "Manual trigger — Preview URL: $PREVIEW_URL, PR: $PR_NUMBER"

          elif [[ "${{ github.event_name }}" == "check_suite" ]]; then
            # For check_suite fallback: attempt to find a recent deployment for the HEAD SHA
            HEAD_SHA="${{ github.event.check_suite.head_sha }}"
            echo "check_suite trigger — HEAD SHA: $HEAD_SHA"

            # Try to get PR number from check_suite pull_requests
            PR_NUMBER=$(echo '${{ toJson(github.event.check_suite.pull_requests) }}' \
              | jq -r '.[0].number // ""' 2>/dev/null || true)
            echo "PR number from check_suite: $PR_NUMBER"

            # No preview URL available for check_suite fallback
            PREVIEW_URL=""
          fi

          echo "preview-url=$PREVIEW_URL" >> $GITHUB_OUTPUT
          echo "pr-number=$PR_NUMBER" >> $GITHUB_OUTPUT
          echo "has-preview=$([ -n "$PREVIEW_URL" ] && echo 'true' || echo 'false')" >> $GITHUB_OUTPUT

      - name: Skip — no preview deployment available
        if: steps.context.outputs.has-preview == 'false' && github.event_name == 'check_suite'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          PR_NUMBER="${{ steps.context.outputs.pr-number }}"
          if [[ -n "$PR_NUMBER" ]]; then
            gh pr comment "$PR_NUMBER" \
              --body "🤖 **TLM QA Agent**: No preview deployment available, QA checks skipped." \
              --repo ${{ github.repository }}
          else
            echo "No PR number found and no preview URL — skipping QA agent with no comment."
          fi
          echo "Skipping QA agent — no preview URL for check_suite trigger."

      - name: Warmup — wait for preview URL to be ready
        if: steps.context.outputs.has-preview == 'true'
        run: |
          PREVIEW_URL="${{ steps.context.outputs.preview-url }}"
          echo "Warming up preview URL: $PREVIEW_URL"

          MAX_RETRIES=3
          RETRY_INTERVAL=10
          SUCCESS=false

          for i in $(seq 1 $MAX_RETRIES); do
            echo "Attempt $i of $MAX_RETRIES..."
            if curl --silent --fail --max-time 15 "$PREVIEW_URL" > /dev/null 2>&1; then
              echo "Preview URL is ready."
              SUCCESS=true
              break
            else
              echo "Preview URL not ready yet."
              if [[ $i -lt $MAX_RETRIES ]]; then
                echo "Waiting ${RETRY_INTERVAL}s before retry..."
                sleep $RETRY_INTERVAL
              fi
            fi
          done

          if [[ "$SUCCESS" != "true" ]]; then
            echo "Warning: Preview URL did not respond after $MAX_RETRIES attempts. Proceeding anyway."
          fi

      - name: Run QA Agent
        if: steps.context.outputs.has-preview == 'true'
        uses: ./.github/actions/tlm-qa-agent
        with:
          preview-url: ${{ steps.context.outputs.preview-url }}
          pr-number: ${{ steps.context.outputs.pr-number }}
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          QA_BYPASS_SECRET: ${{ secrets.QA_BYPASS_SECRET }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Step 3: Verify YAML syntax

```bash
# Install yamllint if available, otherwise use python
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/tlm-qa-agent.yml'))" && echo "YAML is valid"
```

If `python3` is not available or has no yaml module:
```bash
# Basic check — ensure file was created and is non-empty
wc -l .github/workflows/tlm-qa-agent.yml
cat .github/workflows/tlm-qa-agent.yml
```

### Step 4: Verify no TypeScript compilation issues (unrelated to this change but required)

```bash
npx tsc --noEmit 2>&1 | head -30 || true
```

This is a YAML-only change; TypeScript errors here are pre-existing and not introduced by this task.

### Step 5: Commit, push, open PR

```bash
git add .github/workflows/tlm-qa-agent.yml
git commit -m "feat: add TLM QA Agent workflow trigger (deployment_status + check_suite)"
git push origin feat/tlm-qa-agent-workflow

gh pr create \
  --title "feat: add TLM QA Agent workflow trigger file" \
  --body "## Summary

Creates \`.github/workflows/tlm-qa-agent.yml\` — the GitHub Actions workflow that triggers the QA Agent composite action on deployment events.

## Triggers
- **\`deployment_status\`** (primary): Fires on Vercel preview deploy success, extracts preview URL from \`github.event.deployment_status.environment_url\`
- **\`check_suite\` completed** (fallback): Runs for repos without Vercel preview deploys; posts a skip comment if no preview URL is available
- **\`workflow_dispatch\`** (manual): Accepts \`preview-url\` and \`pr-number\` inputs

## Behavior
- Extracts preview URL and PR number from event payload or GitHub API (gh pr list --search SHA)
- Warmup step: curls the preview URL root up to 3 times with 10s intervals
- Calls \`.github/actions/tlm-qa-agent\` composite action with resolved inputs
- Graceful skip: posts comment on PR when check_suite fires with no preview deployment
- Passes \`ANTHROPIC_API_KEY\` and \`QA_BYPASS_SECRET\` secrets to the composite action

## Permissions
\`pull-requests: write\`, \`deployments: read\`, \`contents: read\`

## Concurrency
Group: \`qa-agent-\${{ github.event.pull_request.number || github.sha }}\` with cancel-in-progress

## Notes
- Requires \`.github/actions/tlm-qa-agent\` composite action to exist (separate work item)
- \`QA_BYPASS_SECRET\` and \`ANTHROPIC_API_KEY\` must be added to repo secrets
" \
  --base main \
  --head feat/tlm-qa-agent-workflow
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/tlm-qa-agent-workflow
FILES CHANGED: .github/workflows/tlm-qa-agent.yml
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If encountering a blocker that cannot be resolved autonomously (e.g., unclear how the composite action `.github/actions/tlm-qa-agent` is structured and what inputs it expects, or GitHub Actions YAML parsing errors that can't be diagnosed):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "qa-agent-workflow-trigger",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": [".github/workflows/tlm-qa-agent.yml"]
    }
  }'
```