# Agent Forge -- Add GitHub Actions Workflow for Context Snapshot

## Metadata
- **Branch:** `feat/add-context-snapshot-workflow`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/workflows/update-context-snapshot.yml

## Context

The agent-forge repo has a context snapshot generation script at `scripts/generate-context-snapshot.sh` that was added in a recent PR. This script generates a snapshot of the repository context (directory structure, key files, recent PRs, etc.) and uploads it to Notion via the Notion API.

Currently, the script must be run manually. This work item automates it by adding a GitHub Actions workflow that triggers on every push to `main`, ensuring the Notion context page stays up to date automatically after every merge.

The workflow is straightforward: install system dependencies (`tree`, `jq`), then run the bash script with the required environment variables injected from GitHub secrets and the built-in `github.token`.

## Requirements

1. File `.github/workflows/update-context-snapshot.yml` must exist with valid YAML syntax
2. Workflow must trigger on `push` to `main` branch only (not PRs, not other branches)
3. Workflow must install `tree` and `jq` via `apt-get` before running the script
4. Workflow must pass `NOTION_API_KEY` (from repo secret), `NOTION_CONTEXT_PAGE_ID` (from repo secret), and `GH_TOKEN` (from `github.token`) as environment variables to the script step
5. Workflow must run `bash scripts/generate-context-snapshot.sh` as its main step
6. No build or compile step is needed — this is pure bash

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-context-snapshot-workflow
```

### Step 1: Create the workflow directory if it doesn't exist
```bash
mkdir -p .github/workflows
```

### Step 2: Create the workflow file

Create `.github/workflows/update-context-snapshot.yml` with exactly this content:

```yaml
name: Update Context Snapshot
on:
  push:
    branches: [main]
jobs:
  update-snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq tree jq
      - name: Generate and upload context snapshot
        env:
          NOTION_API_KEY: ${{ secrets.NOTION_API_KEY }}
          NOTION_CONTEXT_PAGE_ID: ${{ secrets.NOTION_CONTEXT_PAGE_ID }}
          GH_TOKEN: ${{ github.token }}
        run: bash scripts/generate-context-snapshot.sh
```

### Step 3: Validate the YAML syntax
```bash
# Use python to validate YAML if available
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/update-context-snapshot.yml'))" && echo "YAML valid"
# Or use yq if available
# yq e '.github/workflows/update-context-snapshot.yml' > /dev/null && echo "YAML valid"
```

If neither is available, visually inspect the file for correct indentation and structure.

### Step 4: Verify the script exists
```bash
ls -la scripts/generate-context-snapshot.sh
```

If the script does not exist, escalate — do not proceed without confirming the script is present, as the workflow would fail on every run.

### Step 5: Verification
```bash
# Confirm file exists
cat .github/workflows/update-context-snapshot.yml

# Confirm no TypeScript errors (unrelated to this change, but good hygiene)
npx tsc --noEmit 2>/dev/null || true
```

### Step 6: Commit, push, open PR
```bash
git add .github/workflows/update-context-snapshot.yml
git commit -m "feat: add GitHub Actions workflow for context snapshot"
git push origin feat/add-context-snapshot-workflow
gh pr create \
  --title "feat: add GitHub Actions workflow for context snapshot" \
  --body "## Summary

Adds \`.github/workflows/update-context-snapshot.yml\` to automate context snapshot generation on every push to \`main\`.

## What This Does

Triggers \`scripts/generate-context-snapshot.sh\` automatically after each merge to \`main\`, keeping the Notion context page up to date without manual intervention.

## Setup Required (One-Time)

Two repository secrets must be configured for this workflow to succeed:

| Secret | Description |
|--------|-------------|
| \`NOTION_API_KEY\` | Notion integration token (already used by other workflows) |
| \`NOTION_CONTEXT_PAGE_ID\` | ID of the Notion page to update with the context snapshot |

To add secrets: **Settings → Secrets and variables → Actions → New repository secret**

## Changes

- \`.github/workflows/update-context-snapshot.yml\` — new workflow file

## Acceptance Criteria
- [x] File exists with valid YAML syntax
- [x] Triggers on \`push\` to \`main\` only
- [x] Passes \`NOTION_API_KEY\`, \`NOTION_CONTEXT_PAGE_ID\`, and \`GH_TOKEN\` as env vars
- [x] Installs \`tree\` and \`jq\` before running the script
- [x] Runs \`bash scripts/generate-context-snapshot.sh\` as main step"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-context-snapshot-workflow
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If `scripts/generate-context-snapshot.sh` does not exist in the repo, escalate before creating the workflow:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "agent-forge-add-context-snapshot-workflow",
    "reason": "scripts/generate-context-snapshot.sh does not exist in repo — workflow would fail on every run",
    "confidenceScore": 0.1,
    "contextSnapshot": {
      "step": "Step 4",
      "error": "Target script missing from repository",
      "filesChanged": [".github/workflows/update-context-snapshot.yml"]
    }
  }'
```