# Agent Forge -- Create Workflow Template Storage and Template Reader

## Metadata
- **Branch:** `feat/workflow-template-storage`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** templates/workflows/execute-handoff.yml, templates/workflows/tlm-review.yml, templates/workflows/tlm-spec-review.yml, templates/workflows/tlm-outcome-tracker.yml, templates/actions/tlm-review/action.yml, templates/actions/tlm-spec-review/action.yml, templates/actions/tlm-outcome-tracker/action.yml, lib/templates.ts

## Context

Agent Forge is a dev orchestration control plane that coordinates autonomous agent teams across multiple repositories. When a target repo is bootstrapped, Agent Forge needs to push GitHub Actions workflow files and composite actions into the target repo's `.github/` directory.

The current codebase has:
- `lib/types.ts` which contains `PipelineLevel` type (either `'execute-only'` or `'full-tlm'`)
- The actual `execute-handoff.yml` workflow lives at `.github/workflows/execute-handoff.yml` in this repo as the working reference
- TLM actions live at `.github/actions/tlm-review/`, `.github/actions/tlm-spec-review/` (if present) in the working repo

The goal is to create canonical template versions of these files in a `templates/` directory, and expose them via `lib/templates.ts` so the bootstrap/provisioning code can call `getTemplateFiles(pipelineLevel)` and get back all the file contents ready to push to a target repo.

The `PipelineLevel` type is already defined in `lib/types.ts` as part of the bootstrap types PR. It is either `'execute-only'` (just the execute-handoff workflow) or `'full-tlm'` (all workflows + all composite actions).

## Requirements

1. Create directory `templates/workflows/` with four valid GitHub Actions workflow YAML files
2. `templates/workflows/execute-handoff.yml` — triggers on `workflow_dispatch` with a `handoff_file` input, checks out the repo, and runs Claude Code to execute the handoff. Must be valid YAML with a `workflow_dispatch` trigger.
3. `templates/workflows/tlm-review.yml` — triggers on `pull_request`, runs the TLM code review action
4. `templates/workflows/tlm-spec-review.yml` — triggers on `push` to `handoffs/**`, runs the TLM spec review action
5. `templates/workflows/tlm-outcome-tracker.yml` — triggers on `schedule` (daily cron), runs the TLM outcome tracker action
6. Create directory `templates/actions/` with three composite action YAML files
7. `templates/actions/tlm-review/action.yml` — composite action that reviews PRs using Claude
8. `templates/actions/tlm-spec-review/action.yml` — composite action that reviews/improves handoff spec files using Claude
9. `templates/actions/tlm-outcome-tracker/action.yml` — composite action that tracks daily outcomes
10. Create `lib/templates.ts` with exported `TemplateFile` interface and `getTemplateFiles(pipelineLevel)` async function
11. `getTemplateFiles('execute-only')` returns exactly 1 `TemplateFile` with `path: '.github/workflows/execute-handoff.yml'`
12. `getTemplateFiles('full-tlm')` returns exactly 7 `TemplateFile` entries: 4 workflows + 3 actions, all with paths prefixed `.github/`
13. `lib/templates.ts` uses Node.js `fs/promises` and `path` to read template files at runtime using `process.cwd()` as the base
14. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/workflow-template-storage
```

### Step 1: Inspect existing types and reference workflows

Check the existing `PipelineLevel` type to confirm its shape:
```bash
cat lib/types.ts | grep -A5 "PipelineLevel"
```

Check the existing execute-handoff workflow as the canonical reference:
```bash
cat .github/workflows/execute-handoff.yml
```

Also check if TLM action files already exist in this repo:
```bash
ls .github/actions/ 2>/dev/null || echo "no actions dir"
ls .github/workflows/ 2>/dev/null
```

### Step 2: Create template directory structure

```bash
mkdir -p templates/workflows
mkdir -p templates/actions/tlm-review
mkdir -p templates/actions/tlm-spec-review
mkdir -p templates/actions/tlm-outcome-tracker
```

### Step 3: Create `templates/workflows/execute-handoff.yml`

Copy the existing `.github/workflows/execute-handoff.yml` as the canonical base, then save it to `templates/workflows/execute-handoff.yml`. If it doesn't fully match the template shape needed, create it as:

```yaml
name: Execute Handoff

on:
  workflow_dispatch:
    inputs:
      handoff_file:
        description: 'Path to handoff markdown file (e.g. handoffs/my-task.md)'
        required: true
        type: string

jobs:
  execute:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Claude Code
        run: npm install -g @anthropic-ai/claude-code

      - name: Execute handoff
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AGENT_FORGE_URL: ${{ secrets.AGENT_FORGE_URL }}
          AGENT_FORGE_API_SECRET: ${{ secrets.AGENT_FORGE_API_SECRET }}
        run: |
          claude --dangerously-skip-permissions \
            "Read and execute the handoff file at ${{ github.event.inputs.handoff_file }}. Follow all steps exactly as written."
```

### Step 4: Create `templates/workflows/tlm-review.yml`

```yaml
name: TLM Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run TLM Code Review
        uses: ./.github/actions/tlm-review
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          pr_number: ${{ github.event.pull_request.number }}
```

### Step 5: Create `templates/workflows/tlm-spec-review.yml`

```yaml
name: TLM Spec Review

on:
  push:
    paths:
      - 'handoffs/**'

jobs:
  spec-review:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run TLM Spec Review
        uses: ./.github/actions/tlm-spec-review
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Step 6: Create `templates/workflows/tlm-outcome-tracker.yml`

```yaml
name: TLM Outcome Tracker

on:
  schedule:
    - cron: '0 9 * * *'
  workflow_dispatch:

jobs:
  track-outcomes:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run TLM Outcome Tracker
        uses: ./.github/actions/tlm-outcome-tracker
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Step 7: Create `templates/actions/tlm-review/action.yml`

```yaml
name: TLM Code Review
description: Reviews pull requests using Claude AI, assesses risk, and auto-merges low-risk changes

inputs:
  github_token:
    description: GitHub token for PR interactions
    required: true
  anthropic_api_key:
    description: Anthropic API key for Claude
    required: true
  pr_number:
    description: Pull request number to review
    required: true

runs:
  using: composite
  steps:
    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install Claude Code
      shell: bash
      run: npm install -g @anthropic-ai/claude-code

    - name: Review PR
      shell: bash
      env:
        ANTHROPIC_API_KEY: ${{ inputs.anthropic_api_key }}
        GITHUB_TOKEN: ${{ inputs.github_token }}
        PR_NUMBER: ${{ inputs.pr_number }}
      run: |
        claude --dangerously-skip-permissions \
          "You are TLM Code Review. Review PR #${PR_NUMBER} in this repository. 
          Assess the changes for correctness, risk level (low/medium/high), and adherence to project conventions.
          Post a review comment summarizing your assessment.
          If risk is low and all checks pass, approve the PR.
          Read docs/tlm-memory.md for review patterns if it exists."
```

### Step 8: Create `templates/actions/tlm-spec-review/action.yml`

```yaml
name: TLM Spec Review
description: Reviews and improves handoff spec files before execution

inputs:
  github_token:
    description: GitHub token for commits
    required: true
  anthropic_api_key:
    description: Anthropic API key for Claude
    required: true

runs:
  using: composite
  steps:
    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install Claude Code
      shell: bash
      run: npm install -g @anthropic-ai/claude-code

    - name: Review and improve handoff specs
      shell: bash
      env:
        ANTHROPIC_API_KEY: ${{ inputs.anthropic_api_key }}
        GITHUB_TOKEN: ${{ inputs.github_token }}
      run: |
        claude --dangerously-skip-permissions \
          "You are TLM Spec Review. Find all new or modified handoff files in the handoffs/ directory from recent commits.
          For each handoff file, review it for clarity, completeness, and executability.
          Improve any ambiguous steps, missing context, or incomplete acceptance criteria.
          Commit any improvements directly to the current branch with message 'tlm-spec: improve handoff clarity'.
          Read docs/tlm-memory.md for spec review patterns if it exists."
```

### Step 9: Create `templates/actions/tlm-outcome-tracker/action.yml`

```yaml
name: TLM Outcome Tracker
description: Daily assessment of merged PR outcomes to improve future handoffs

inputs:
  github_token:
    description: GitHub token for reading PRs
    required: true
  anthropic_api_key:
    description: Anthropic API key for Claude
    required: true

runs:
  using: composite
  steps:
    - name: Set up Node.js
      uses: actions/setup-node@v4
      with:
        node-version: '20'

    - name: Install Claude Code
      shell: bash
      run: npm install -g @anthropic-ai/claude-code

    - name: Track outcomes
      shell: bash
      env:
        ANTHROPIC_API_KEY: ${{ inputs.anthropic_api_key }}
        GITHUB_TOKEN: ${{ inputs.github_token }}
      run: |
        claude --dangerously-skip-permissions \
          "You are TLM Outcome Tracker. Review PRs merged in the last 24 hours.
          For each merged PR, assess: did it achieve its stated goal? Were there regressions? What patterns led to success or failure?
          Update docs/tlm-memory.md with your findings, appending a dated entry.
          Create the file if it doesn't exist. Commit with message 'tlm-outcome: daily assessment $(date +%Y-%m-%d)'."
```

### Step 10: Create `lib/templates.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { PipelineLevel } from './types';

export interface TemplateFile {
  path: string;   // e.g. '.github/workflows/execute-handoff.yml'
  content: string;
}

const TEMPLATES_DIR = path.join(process.cwd(), 'templates');

async function readTemplate(relativePath: string): Promise<string> {
  const fullPath = path.join(TEMPLATES_DIR, relativePath);
  return fs.readFile(fullPath, 'utf-8');
}

export async function getTemplateFiles(pipelineLevel: PipelineLevel): Promise<TemplateFile[]> {
  const executeHandoff: TemplateFile = {
    path: '.github/workflows/execute-handoff.yml',
    content: await readTemplate('workflows/execute-handoff.yml'),
  };

  if (pipelineLevel === 'execute-only') {
    return [executeHandoff];
  }

  // full-tlm: all 4 workflows + 3 actions = 7 files
  const [
    tlmReviewWorkflow,
    tlmSpecReviewWorkflow,
    tlmOutcomeTrackerWorkflow,
    tlmReviewAction,
    tlmSpecReviewAction,
    tlmOutcomeTrackerAction,
  ] = await Promise.all([
    readTemplate('workflows/tlm-review.yml'),
    readTemplate('workflows/tlm-spec-review.yml'),
    readTemplate('workflows/tlm-outcome-tracker.yml'),
    readTemplate('actions/tlm-review/action.yml'),
    readTemplate('actions/tlm-spec-review/action.yml'),
    readTemplate('actions/tlm-outcome-tracker/action.yml'),
  ]);

  return [
    executeHandoff,
    {
      path: '.github/workflows/tlm-review.yml',
      content: tlmReviewWorkflow,
    },
    {
      path: '.github/workflows/tlm-spec-review.yml',
      content: tlmSpecReviewWorkflow,
    },
    {
      path: '.github/workflows/tlm-outcome-tracker.yml',
      content: tlmOutcomeTrackerWorkflow,
    },
    {
      path: '.github/actions/tlm-review/action.yml',
      content: tlmReviewAction,
    },
    {
      path: '.github/actions/tlm-spec-review/action.yml',
      content: tlmSpecReviewAction,
    },
    {
      path: '.github/actions/tlm-outcome-tracker/action.yml',
      content: tlmOutcomeTrackerAction,
    },
  ];
}
```

### Step 11: Verify `PipelineLevel` type is compatible

Check that `PipelineLevel` in `lib/types.ts` includes both `'execute-only'` and `'full-tlm'` as string literal values. If it's defined differently (e.g. an enum), update the comparison in `lib/templates.ts` accordingly.

```bash
grep -n "PipelineLevel" lib/types.ts
```

If `PipelineLevel` is not yet defined in `lib/types.ts`, add it:

```typescript
export type PipelineLevel = 'execute-only' | 'full-tlm';
```

### Step 12: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- If `PipelineLevel` is an enum rather than a string union, change the condition from `=== 'execute-only'` to the appropriate enum comparison
- If `process.cwd()` is wrong at runtime (e.g. in Next.js API routes), the `TEMPLATES_DIR` may need to be adjusted — but `process.cwd()` should resolve to the project root in the Next.js server context

### Step 13: Smoke-test the template reader (optional but recommended)

Create a quick test script to verify the function works:

```bash
cat > /tmp/test-templates.mjs << 'EOF'
import { getTemplateFiles } from './lib/templates.js';

const executeOnly = await getTemplateFiles('execute-only');
console.log('execute-only count:', executeOnly.length);
console.assert(executeOnly.length === 1, 'should return 1 file');
console.assert(executeOnly[0].path === '.github/workflows/execute-handoff.yml', 'path should match');

const fullTlm = await getTemplateFiles('full-tlm');
console.log('full-tlm count:', fullTlm.length);
console.assert(fullTlm.length === 7, 'should return 7 files');
console.assert(fullTlm.every(f => f.path.startsWith('.github/')), 'all paths should start with .github/');
console.log('All assertions passed');
EOF
```

Note: This test requires compiled JS. If the project doesn't have a standalone test runner, skip this step — TypeScript compilation check is sufficient.

### Step 14: Build verification

```bash
npm run build
```

Ensure Next.js build succeeds. The `templates/` directory contains static YAML files and will not be bundled by Next.js (it's server-side only via `fs`), so no build configuration changes should be needed.

### Step 15: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add workflow template storage and getTemplateFiles reader"
git push origin feat/workflow-template-storage
gh pr create \
  --title "feat: workflow template storage and template reader" \
  --body "## Summary

Adds canonical workflow/action template files and \`lib/templates.ts\` to support target repo bootstrapping.

## Changes

### New template files
- \`templates/workflows/execute-handoff.yml\` — canonical execute-handoff workflow (workflow_dispatch trigger)
- \`templates/workflows/tlm-review.yml\` — TLM code review workflow (pull_request trigger)
- \`templates/workflows/tlm-spec-review.yml\` — TLM spec review workflow (push to handoffs/**)
- \`templates/workflows/tlm-outcome-tracker.yml\` — TLM outcome tracker (daily cron)
- \`templates/actions/tlm-review/action.yml\` — composite action for code review
- \`templates/actions/tlm-spec-review/action.yml\` — composite action for spec review
- \`templates/actions/tlm-outcome-tracker/action.yml\` — composite action for outcome tracking

### New lib file
- \`lib/templates.ts\` — exports \`getTemplateFiles(pipelineLevel)\` which reads templates at runtime and returns \`TemplateFile[]\` with correct \`.github/\` paths

## Behavior
- \`getTemplateFiles('execute-only')\` → 1 file
- \`getTemplateFiles('full-tlm')\` → 7 files (4 workflows + 3 actions)

## Testing
- TypeScript compiles cleanly
- Next.js build passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/workflow-template-storage
FILES CHANGED: [list all created/modified files]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [remaining work — e.g. "tlm-outcome-tracker action.yml not yet created", "lib/templates.ts needs PipelineLevel import fix"]
```