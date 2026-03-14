# Agent Forge -- Phase 2c: Multi-Repo Support

## Metadata
- **Branch:** `feat/multi-repo-support`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** scripts/seed-repos.ts, .github/workflows/execute-handoff.yml (rez-sniper, via GitHub API), handoffs/README.md (rez-sniper, via GitHub API)

## Context

Agent Forge's data model already supports multiple target repos: `RepoConfig` in `lib/types.ts` has `fullName`, `shortName`, `concurrencyLimit`, `handoffDir`, `executeWorkflow`, etc. The `lib/repos.ts` module provides CRUD operations for repo configs stored in Vercel Blob. The orchestrator dispatches work items by looking up the target repo config, and the ATC enforces per-repo concurrency limits.

However, only one target repo (personal-assistant) has ever been registered, and the second target repo (rez-sniper) has no pipeline infrastructure installed. Phase 2c makes the multi-repo support real by:

1. Installing `execute-handoff.yml` in rez-sniper so it can receive and execute handoffs
2. Creating a `handoffs/` directory in rez-sniper as the landing zone
3. Registering rez-sniper in Agent Forge's repo store
4. Adding a seed script so repo registration is reproducible

**Rez-sniper repo details:**
- **GitHub:** `jamesstineheath/rez-sniper` (private)
- **Stack:** Next.js frontend in `web/` subdirectory + Python/FastAPI backend at root
- **No existing `.github/` directory** (no workflows, no actions)
- **No root `package.json`** (frontend deps in `web/package.json`)
- **CLAUDE.md** exists at repo root with project context
- **No TLM workflows** (spec review and code review are deferred, only execute-handoff for now)

**Key difference from PA:** Since rez-sniper has no TLM Spec Review workflow, the execute-handoff.yml needs to trigger directly on pushes to `handoffs/` on non-main branches (rather than chaining from spec review's `workflow_run`). The orchestrator's existing dispatch flow (push handoff file to branch) will automatically trigger execution.

**Prerequisites (manual, before this handoff runs):**
- GitHub repo secrets must be set on `jamesstineheath/rez-sniper`:
  - `ANTHROPIC_API_KEY` (same key as PA)
  - `GH_PAT` (fine-grained PAT with contents:write and pull-requests:write on rez-sniper)
- GitHub Actions must be enabled on the rez-sniper repo
- Repo settings: Actions > General > "Read and write permissions" enabled

## Requirements

1. A `scripts/seed-repos.ts` script in agent-forge that registers both PA and rez-sniper repos via the Agent Forge `/api/repos` endpoint. Idempotent (checks if repo already exists by fullName before creating).
2. `.github/workflows/execute-handoff.yml` installed in rez-sniper via GitHub API push. Adapted for rez-sniper's hybrid stack (Node.js for frontend in `web/`, Python for backend). Triggers on push to `handoffs/**` on non-main branches AND on `workflow_dispatch`.
3. `handoffs/README.md` created in rez-sniper explaining the handoff directory purpose.
4. Rez-sniper registered in Agent Forge's repo store with config: fullName `jamesstineheath/rez-sniper`, shortName `rez-sniper`, claudeMdPath `CLAUDE.md`, handoffDir `handoffs/`, executeWorkflow `execute-handoff.yml`, concurrencyLimit 1, defaultBudget 5.
5. `npx tsc --noEmit` and `npm run build` pass in agent-forge after changes.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/multi-repo-support
```

### Step 1: Create the repo seed script

Create `scripts/seed-repos.ts` in agent-forge. This script calls the Agent Forge repos API to register target repos. It should be runnable with `npx tsx scripts/seed-repos.ts`.

```typescript
// scripts/seed-repos.ts
// Registers target repos in Agent Forge. Idempotent.
// Usage: AGENT_FORGE_URL=http://localhost:3002 npx tsx scripts/seed-repos.ts

const AGENT_FORGE_URL = process.env.AGENT_FORGE_URL || "https://agent-forge-phi.vercel.app";

interface RepoSeed {
  fullName: string;
  shortName: string;
  claudeMdPath: string;
  systemMapPath?: string;
  adrPath?: string;
  handoffDir: string;
  executeWorkflow: string;
  concurrencyLimit: number;
  defaultBudget: number;
}

const REPOS: RepoSeed[] = [
  {
    fullName: "jamesstineheath/personal-assistant",
    shortName: "pa",
    claudeMdPath: "CLAUDE.md",
    systemMapPath: "docs/SYSTEM_MAP.md",
    adrPath: "docs/adr",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 2,
    defaultBudget: 8,
  },
  {
    fullName: "jamesstineheath/rez-sniper",
    shortName: "rez-sniper",
    claudeMdPath: "CLAUDE.md",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 1,
    defaultBudget: 5,
  },
];

async function main() {
  // Fetch existing repos
  const listRes = await fetch(`${AGENT_FORGE_URL}/api/repos`);
  if (!listRes.ok) {
    console.error("Failed to list repos:", listRes.status, await listRes.text());
    process.exit(1);
  }
  const existing = (await listRes.json()) as Array<{ fullName: string }>;
  const existingNames = new Set(existing.map((r) => r.fullName));

  for (const repo of REPOS) {
    if (existingNames.has(repo.fullName)) {
      console.log(`[skip] ${repo.fullName} already registered`);
      continue;
    }

    const createRes = await fetch(`${AGENT_FORGE_URL}/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(repo),
    });

    if (createRes.ok) {
      const created = await createRes.json();
      console.log(`[created] ${repo.fullName} (id: ${created.id})`);
    } else {
      console.error(`[error] ${repo.fullName}:`, createRes.status, await createRes.text());
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Step 2: Push execute-handoff.yml to rez-sniper

Use the GitHub API to create `.github/workflows/execute-handoff.yml` in the rez-sniper repo on the `main` branch. The workflow is adapted from the PA version with these changes:

- Triggers on `push` to `handoffs/**` on non-main branches (no spec-review chaining)
- Triggers on `workflow_dispatch` for manual runs
- Installs both Node.js and Python dependencies for rez-sniper's hybrid stack
- References `web/` for Node.js operations (npm ci runs in `web/`)
- Execution prompt references rez-sniper, not personal-assistant

Use `gh api` to push the file. Create the workflow content first:

```bash
cat > /tmp/rez-sniper-execute-handoff.yml <<'WORKFLOW_EOF'
name: Execute Handoff

on:
  push:
    branches-ignore:
      - main
    paths:
      - 'handoffs/**/*.md'
  workflow_dispatch:
    inputs:
      branch:
        description: 'Branch containing the handoff file'
        required: true
      handoff_file:
        description: 'Path to handoff file (e.g. handoffs/my-handoff.md)'
        required: true

concurrency:
  group: execute-handoff-${{ github.event.inputs.branch || github.ref_name }}
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  execute:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Determine branch and handoff file
        id: params
        run: |
          if [ "${{ github.event_name }}" == "workflow_dispatch" ]; then
            echo "branch=${{ github.event.inputs.branch }}" >> $GITHUB_OUTPUT
            echo "handoff_file=${{ github.event.inputs.handoff_file }}" >> $GITHUB_OUTPUT
          else
            BRANCH="${{ github.ref_name }}"
            echo "branch=$BRANCH" >> $GITHUB_OUTPUT
            echo "handoff_file=auto" >> $GITHUB_OUTPUT
          fi

      - name: Checkout branch
        uses: actions/checkout@v4
        with:
          ref: ${{ steps.params.outputs.branch }}
          fetch-depth: 0

      - name: Find handoff file
        id: handoff
        run: |
          if [ "${{ steps.params.outputs.handoff_file }}" != "auto" ]; then
            echo "file=${{ steps.params.outputs.handoff_file }}" >> $GITHUB_OUTPUT
          else
            HANDOFF=$(find handoffs -name '*.md' -not -name 'README*' 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
            if [ -z "$HANDOFF" ]; then
              echo "No handoff files found in handoffs/ directory"
              exit 1
            fi
            echo "file=$HANDOFF" >> $GITHUB_OUTPUT
          fi

      - name: Verify handoff file exists
        run: |
          if [ ! -f "${{ steps.handoff.outputs.file }}" ]; then
            echo "Handoff file not found: ${{ steps.handoff.outputs.file }}"
            exit 1
          fi
          echo "Executing handoff: ${{ steps.handoff.outputs.file }}"
          head -20 "${{ steps.handoff.outputs.file }}"

      - name: Parse budget from handoff metadata
        id: budget
        run: |
          BUDGET=$(grep -i 'max budget' "${{ steps.handoff.outputs.file }}" | head -1 | grep -oP '\$\K[0-9]+(\.[0-9]+)?' || echo "")
          if [ -z "$BUDGET" ]; then
            echo "No budget found in handoff metadata, using default: \$5"
            BUDGET="5"
          else
            echo "Budget from handoff: \$$BUDGET"
          fi
          echo "amount=$BUDGET" >> $GITHUB_OUTPUT

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install frontend dependencies
        run: |
          if [ -f web/package-lock.json ]; then
            cd web && npm ci
          fi

      - name: Install Python dependencies
        run: |
          if [ -f requirements.txt ]; then
            pip install -r requirements.txt
          fi

      - name: Configure git
        run: |
          git config user.name "claude[bot]"
          git config user.email "209825114+claude[bot]@users.noreply.github.com"

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Write execution prompt
        run: |
          cat > /tmp/execute-prompt.txt <<'ENDPROMPT'
          You are executing a handoff file for the rez-sniper project.

          Read and execute the handoff file at `${{ steps.handoff.outputs.file }}`.

          Follow the handoff file's own step numbering exactly. The handoff file is the
          single source of truth for what needs to happen. Do not assume any steps exist
          that are not written in the file.

          Important context:
          - Step 0 (branch setup) is already complete. The branch is checked out and
            dependencies are installed. Skip Step 0 entirely.
          - This is a hybrid repo: Next.js frontend in web/, Python/FastAPI backend at root.
          - For frontend builds: cd web && npm run build
          - For Python checks: python3 -m py_compile on changed .py files
          - Start from the Pre-flight Self-Check, then execute each numbered
            implementation step in order.
          - Do NOT skip verification steps.
          - If build fails after 3 attempts, follow the Session Abort Protocol in the
            handoff file.
          - After implementation and verification pass, commit all changes and push to
            this branch.
          - Open a PR against main using `gh pr create`. GITHUB_TOKEN is available in
            the environment for gh CLI operations.
          - Git is already configured. Use `gh pr create` for PRs.
          - If the handoff specifies auto-merge for low-risk items, run:
            gh pr merge --auto --squash
          ENDPROMPT

      - name: Execute handoff with Claude Code
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
        timeout-minutes: 25
        run: |
          echo "Using budget: \$${{ steps.budget.outputs.amount }}"
          claude -p "$(cat /tmp/execute-prompt.txt)" \
            --dangerously-skip-permissions \
            --model claude-sonnet-4-6 \
            --max-budget-usd ${{ steps.budget.outputs.amount }} \
            2>&1 | tee /tmp/claude-output.log

      - name: Parse execution cost
        id: cost
        if: always()
        run: |
          COST=""
          TOKENS=""
          if [ -f /tmp/claude-output.log ]; then
            COST=$(grep -i 'total cost' /tmp/claude-output.log | tail -1 | grep -oP '\$[\d.]+' || echo "")
            if [ -z "$COST" ]; then
              COST=$(grep -i 'cost:' /tmp/claude-output.log | tail -1 | grep -oP '\$[\d.]+' || echo "")
            fi
            TOKENS=$(grep -i 'token' /tmp/claude-output.log | tail -1 || echo "")
          fi
          echo "cost=${COST:-unknown}" >> $GITHUB_OUTPUT
          echo "tokens=${TOKENS:-unknown}" >> $GITHUB_OUTPUT

      - name: Comment cost on PR
        if: always()
        env:
          GITHUB_TOKEN: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}
        run: |
          PR_NUMBER=$(gh pr list --head "${{ steps.params.outputs.branch }}" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
          if [ -n "$PR_NUMBER" ] && [ "$PR_NUMBER" != "null" ]; then
            gh pr comment "$PR_NUMBER" --body "### Execution Cost
          - **Budget:** \$${{ steps.budget.outputs.amount }}
          - **Actual cost:** ${{ steps.cost.outputs.cost }}
          - **Model:** claude-sonnet-4-6"
            echo "Cost summary posted to PR #$PR_NUMBER"
          else
            echo "No open PR found, skipping cost comment"
          fi

      - name: Report results
        if: always()
        run: |
          echo "=== Post-execution status ==="
          echo "Branch: ${{ steps.params.outputs.branch }}"
          echo "Handoff: ${{ steps.handoff.outputs.file }}"
          echo "Budget: \$${{ steps.budget.outputs.amount }}"
          echo "Actual cost: ${{ steps.cost.outputs.cost }}"
          echo ""
          echo "Git log (last 3 commits):"
          git log --oneline -3
          echo ""
          echo "Open PRs from this branch:"
          gh pr list --head "${{ steps.params.outputs.branch }}" --state open || echo "No PRs found"
WORKFLOW_EOF
```

Then push to rez-sniper via the GitHub API. Use `gh api` to create or update the file:

```bash
# Encode the workflow file content as base64
CONTENT=$(base64 -w 0 /tmp/rez-sniper-execute-handoff.yml)

# Push to rez-sniper main branch
gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/execute-handoff.yml \
  -X PUT \
  -f message="ci: add execute-handoff workflow for Agent Forge pipeline" \
  -f content="$CONTENT" \
  -f branch="main"
```

### Step 3: Push handoffs/README.md to rez-sniper

Create a README for the handoffs directory in rez-sniper:

```bash
cat > /tmp/rez-sniper-handoffs-readme.md <<'README_EOF'
# Handoffs

This directory contains handoff files for the Agent Forge autonomous execution pipeline.

Handoff files are markdown documents that describe a unit of work for an AI agent (Claude Code) to execute. When a handoff file is pushed to a non-main branch, the `execute-handoff.yml` workflow automatically picks it up and runs it.

## How it works

1. Agent Forge generates a handoff file and pushes it to a branch in this repo
2. The `execute-handoff.yml` workflow triggers on the push
3. Claude Code reads and executes the handoff file
4. A PR is opened with the results
5. Agent Forge monitors the PR status and updates accordingly

## Manual execution

To manually trigger execution of a handoff:

```bash
gh workflow run execute-handoff.yml -f branch=feat/my-branch -f handoff_file=handoffs/my-handoff.md
```
README_EOF

CONTENT=$(base64 -w 0 /tmp/rez-sniper-handoffs-readme.md)

gh api repos/jamesstineheath/rez-sniper/contents/handoffs/README.md \
  -X PUT \
  -f message="docs: add handoffs directory for Agent Forge pipeline" \
  -f content="$CONTENT" \
  -f branch="main"
```

### Step 4: Register rez-sniper in Agent Forge

Run the seed script to register both repos. If running locally:

```bash
npx tsx scripts/seed-repos.ts
```

If the Agent Forge API requires authentication and we can't run the seed script from CI, manually call the API:

```bash
curl -X POST https://agent-forge-phi.vercel.app/api/repos \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "jamesstineheath/rez-sniper",
    "shortName": "rez-sniper",
    "claudeMdPath": "CLAUDE.md",
    "handoffDir": "handoffs/",
    "executeWorkflow": "execute-handoff.yml",
    "concurrencyLimit": 1,
    "defaultBudget": 5
  }'
```

Note: If the API is behind auth, the seed script should be run locally or as part of a deployment step. The important thing is that rez-sniper gets registered before any work items target it.

### Step 5: Verification
```bash
# Agent Forge builds clean
npx tsc --noEmit
npm run build

# Seed script is syntactically valid
npx tsx --eval "import('./scripts/seed-repos.ts')" 2>&1 | head -5

# Verify rez-sniper workflow was pushed
gh api repos/jamesstineheath/rez-sniper/contents/.github/workflows/execute-handoff.yml --jq '.name'

# Verify rez-sniper handoffs README was pushed
gh api repos/jamesstineheath/rez-sniper/contents/handoffs/README.md --jq '.name'
```

### Step 6: Commit, push, open PR
```bash
git add scripts/seed-repos.ts
git commit -m "feat: Phase 2c multi-repo support

Adds repo seed script for registering target repos in Agent Forge.
Installs execute-handoff.yml workflow in rez-sniper via GitHub API.
Creates handoffs/ directory in rez-sniper as the handoff landing zone.

Rez-sniper is now a valid target repo for Agent Forge work items.
No TLM review workflows installed yet (deferred to future phase)."

git push origin feat/multi-repo-support
gh pr create --title "feat: Phase 2c multi-repo support" --body "## Summary
- Adds \`scripts/seed-repos.ts\` for idempotent repo registration (PA + rez-sniper)
- Installs \`execute-handoff.yml\` in rez-sniper (adapted for hybrid Node.js + Python stack)
- Creates \`handoffs/\` directory in rez-sniper
- Rez-sniper triggers execute-handoff on push to \`handoffs/**\` on non-main branches

## Architecture
No TLM spec review or code review in rez-sniper yet. Handoffs pushed to rez-sniper trigger execution directly. TLM workflows can be added in a follow-up.

## Prerequisites (manual)
- [ ] ANTHROPIC_API_KEY secret set on rez-sniper repo
- [ ] GH_PAT secret set on rez-sniper repo
- [ ] GitHub Actions enabled on rez-sniper with read/write permissions

## Files Changed
- \`scripts/seed-repos.ts\` (new: repo registration seed script)
- \`jamesstineheath/rez-sniper:.github/workflows/execute-handoff.yml\` (new: cross-repo push)
- \`jamesstineheath/rez-sniper:handoffs/README.md\` (new: cross-repo push)

## Verification
- tsc --noEmit: pass
- npm run build: pass
- rez-sniper workflow file exists via GitHub API: confirmed
- rez-sniper handoffs README exists via GitHub API: confirmed

## Risk
Medium. Cross-repo pushes to rez-sniper main branch. The workflow and README are additive (no existing files modified). Rez-sniper secrets must be configured manually before the pipeline can execute handoffs there."
```

### Step 7: Auto-merge
If CI passes and TLM review approves:
```bash
gh pr merge --auto --squash
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/multi-repo-support
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```