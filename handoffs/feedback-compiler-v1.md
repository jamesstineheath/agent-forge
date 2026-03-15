# Feedback Compiler Agent: TLM Self-Improvement Loop

## Metadata
- **ID(s):** feedback-compiler-v1
- **Type:** feature
- **Priority:** high
- **Risk:** low (all changes delivered via PR with Code Reviewer gate, no direct mutations)
- **Complexity:** high
- **Model:** claude-opus-4-6
- **Estimated files:** .github/workflows/tlm-feedback-compiler.yml, .github/actions/tlm-feedback-compiler/action.yml, .github/actions/tlm-feedback-compiler/src/index.ts, .github/actions/tlm-feedback-compiler/src/compiler-prompt.ts, .github/actions/tlm-feedback-compiler/src/pattern-detector.ts, .github/actions/tlm-feedback-compiler/src/change-proposer.ts, .github/actions/tlm-feedback-compiler/src/types.ts, .github/actions/tlm-feedback-compiler/package.json, .github/actions/tlm-feedback-compiler/tsconfig.json, app/dashboard/feedback-compiler/page.tsx, docs/adr/009-feedback-compiler-agent.md
- **Execution mode:** Autonomous
- **Depends on:** Outcome Tracker (merged), Code Reviewer (merged), Spec Reviewer (merged)
- **Max Budget:** $10

## Step 0: Branch and Orient

1. Create branch `feedback-compiler-v1` from `main`.
2. Read these files thoroughly before writing any code. The Feedback Compiler must match established patterns exactly:
   - `.github/workflows/tlm-outcome-tracker.yml` (workflow structure, permissions, concurrency, commit pattern)
   - `.github/actions/tlm-outcome-tracker/action.yml` (action.yml input/output schema)
   - `.github/actions/tlm-outcome-tracker/src/index.ts` (Claude API call pattern, memory read/write, GitHub API usage)
   - `.github/actions/tlm-outcome-tracker/src/outcome-prompt.ts` (prompt structure, JSON output schema)
   - `.github/actions/tlm-outcome-tracker/package.json` (dependencies: `@actions/core`, `@actions/github`, `@vercel/ncc`, `typescript`)
   - `.github/actions/tlm-outcome-tracker/tsconfig.json` (compiler options: ES2022, commonjs, strict)
   - `.github/actions/tlm-review/src/review-prompt.ts` (the `buildSystemPrompt()` function and `BASE_SYSTEM_PROMPT` constant that the Feedback Compiler will propose changes to)
   - `.github/actions/tlm-review/src/index.ts` (how Code Reviewer loads memory and builds context)
   - `.github/actions/tlm-spec-review/` (Spec Reviewer structure, its prompt files)
   - `docs/tlm-memory.md` (current memory format with Hot Patterns, Recent Outcomes, Lessons Learned, Stats)
   - `docs/SYSTEM_MAP.md` (understand what the system looks like for dashboard placement)
   - `docs/adr/000-conventions.md` (ADR naming/format conventions for this repo)
3. Commit this handoff file and the ADR to the branch and push.

## Step 1: Add ADR-009

Create `docs/adr/009-feedback-compiler-agent.md`. Content should cover:

- **Context:** The TLM pipeline has observation (Action Ledger, Outcome Tracker) but no closed loop between observed failure patterns and agent behavior changes. Humans must manually notice patterns in `tlm-memory.md` and edit agent prompts. This is the gap between evaluation and self-improvement.
- **Decision:** Add a fourth TLM agent (Feedback Compiler) that runs weekly, reads outcome data from `docs/tlm-memory.md` and GitHub PR history, detects failure patterns across all three existing agents, and proposes concrete changes (prompt diffs, memory updates, threshold adjustments) delivered as PRs gated by the existing Code Reviewer and human approval.
- **Key design choices:**
  - Changes delivered via PR only, never applied directly. Code Reviewer gates everything.
  - Effectiveness tracking: the Feedback Compiler tags its own changes and checks on subsequent runs whether the targeted failure pattern recurred.
  - Cross-agent analysis: reads all three agents' prompts and memory to detect systemic patterns (e.g., "Spec Reviewer approves specs that Code Reviewer then flags" indicates misalignment).
  - Revert capability: if a previous Feedback Compiler change didn't improve outcomes (or made them worse), propose a revert PR.
  - Starts with repo-based data only (tlm-memory.md, GitHub PR history). No Blob dependency.
- **Consequences:** Positive: closes the self-improvement loop, all changes auditable in git, reuses safety infrastructure. Negative: adds pipeline complexity, weekly cadence means 2-week minimum improvement cycle, risk of prompt drift over many iterations (mitigated by revert capability).

Follow the format in `docs/adr/000-conventions.md`.

## Step 2: Create the GitHub Actions workflow

Create `.github/workflows/tlm-feedback-compiler.yml`. Mirror `tlm-outcome-tracker.yml` exactly for structure:

```yaml
name: TLM Feedback Compiler

on:
  schedule:
    - cron: '0 22 * * 0'  # Weekly, Sunday 10pm UTC
  workflow_dispatch: {}

concurrency:
  group: tlm-feedback-compiler
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write
  issues: write
  checks: read

jobs:
  compile-feedback:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          token: ${{ secrets.GH_PAT }}
          fetch-depth: 0  # Need full history for PR analysis

      - name: Run TLM Feedback Compiler
        uses: ./.github/actions/tlm-feedback-compiler
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GH_PAT }}
          model: "claude-opus-4-6"
          lookback-days: "7"
```

Notes:
- Uses `GH_PAT` (not `GITHUB_TOKEN`) because it needs to create branches and PRs that trigger other workflows (Code Reviewer).
- `fetch-depth: 0` because the compiler needs to analyze PR history and file diffs.
- No commit step in the workflow (unlike Outcome Tracker). The Feedback Compiler creates PRs, not direct commits.
- `permissions: issues: write` because escalation items become GitHub issues.
- 15-minute timeout because it does more analysis than the Outcome Tracker.

## Step 3: Create the composite action scaffold

Create `.github/actions/tlm-feedback-compiler/` with:

**`action.yml`:**
```yaml
name: "TLM Feedback Compiler"
description: "Analyzes outcome patterns across TLM agents and proposes prompt/config improvements via PRs"
inputs:
  anthropic-api-key:
    description: "Anthropic API key"
    required: true
  github-token:
    description: "GitHub token with repo write + PR create permissions"
    required: true
  model:
    description: "Claude model for analysis"
    required: false
    default: "claude-opus-4-6"
  lookback-days:
    description: "How many days of outcome history to analyze"
    required: false
    default: "7"
outputs:
  patterns-detected:
    description: "Number of actionable patterns detected"
  changes-proposed:
    description: "Number of changes proposed via PR"
  pr-number:
    description: "PR number if changes were proposed, empty otherwise"
runs:
  using: "node20"
  main: "dist/index.js"
```

**`package.json`:** Match the Outcome Tracker exactly:
```json
{
  "name": "tlm-feedback-compiler",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "ncc build src/index.ts --out dist --minify",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@actions/core": "^1.10.1",
    "@actions/github": "^6.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@vercel/ncc": "^0.38.0",
    "typescript": "^5.3.0"
  }
}
```

**`tsconfig.json`:** Same as other actions (ES2022, commonjs, strict).

## Step 4: Define types

Create `src/types.ts` with shared interfaces:

```typescript
// Pattern detection
export interface DetectedPattern {
  id: string;                    // unique, for traceability
  agentType: 'code-reviewer' | 'spec-reviewer' | 'outcome-tracker' | 'cross-agent';
  patternType: 'elevated-reversal' | 'repeated-failure' | 'stale-lesson' | 'cross-agent-misalignment' | 'missed-category' | 'regression';
  severity: 'info' | 'warning' | 'action-needed';
  description: string;
  evidence: PatternEvidence[];
}

export interface PatternEvidence {
  source: 'memory' | 'pr-history' | 'ci-status';
  detail: string;               // human-readable summary
  prNumbers?: number[];          // relevant PR numbers
  dates?: string[];              // relevant dates
}

// Change proposals
export type ChangeType = 'memory-update' | 'prompt-amendment' | 'threshold-adjustment' | 'revert-previous' | 'escalation';

export interface ProposedChange {
  id: string;
  sourcePatternId: string;       // links back to DetectedPattern
  changeType: ChangeType;
  targetFile: string;            // relative path in repo
  description: string;           // what and why
  diff: FileDiff;                // the actual change
  expectedImpact: string;        // what should improve
}

export interface FileDiff {
  originalContent: string;
  proposedContent: string;
}

// Effectiveness tracking
export interface ChangeRecord {
  changeId: string;
  prNumber: number;
  patternId: string;
  targetAgent: string;
  targetFile: string;
  proposedAt: string;            // ISO date
  mergedAt: string | null;
  effectivenessCheck: {
    checkedAt: string | null;
    patternRecurred: boolean | null;
    verdict: 'effective' | 'ineffective' | 'inconclusive' | null;
  };
}

// Compiler output (Claude's response)
export interface CompilerAnalysis {
  patterns: Array<{
    agent: string;
    patternType: string;
    severity: 'info' | 'warning' | 'action-needed';
    description: string;
    evidence: string;
    recommendation: string;
  }>;
  proposed_changes: Array<{
    target_file: string;
    change_type: string;
    description: string;
    original_section: string;    // exact text to find
    replacement_section: string; // exact text to replace with
    expected_impact: string;
  }>;
  effectiveness_checks: Array<{
    previous_change_id: string;
    pattern_recurred: boolean;
    verdict: 'effective' | 'ineffective' | 'inconclusive';
    reasoning: string;
  }>;
  summary: string;
}
```

## Step 5: Implement pattern detection

Create `src/pattern-detector.ts`:

This module gathers all the input data the compiler prompt needs. It does NOT do AI-based analysis itself. Instead, it prepares a structured context bundle that gets sent to Claude.

**Data gathering functions:**

1. **`loadMemory(workspace)`**: Reuse the Outcome Tracker's `parseMemoryFile` logic (copy it, don't import from another action). Read `docs/tlm-memory.md`. Extract Hot Patterns, Recent Outcomes, Lessons Learned, Stats.

2. **`loadAgentPrompts(workspace)`**: Read the system prompt files for all three agents:
   - `.github/actions/tlm-review/src/review-prompt.ts` (extract `BASE_SYSTEM_PROMPT` string)
   - `.github/actions/tlm-spec-review/src/` (find and extract the spec review system prompt)
   - `.github/actions/tlm-outcome-tracker/src/outcome-prompt.ts` (extract `OUTCOME_SYSTEM_PROMPT`)

   These are TypeScript files. Parse them pragmatically: read the file content as a string, regex-extract the prompt constants (look for template literal or string assignments to known variable names). Don't try to eval or compile them.

3. **`fetchRecentPRHistory(octokit, owner, repo, lookbackDays)`**: Fetch merged PRs from the lookback window. For each PR, get:
   - PR number, title, merged_at
   - TLM review decision (from PR reviews, look for "TLM Review:" in review body, same pattern as Outcome Tracker)
   - Whether the PR was a Feedback Compiler PR (check if branch name starts with `feedback-compiler/`)
   - Whether the PR was reverted

4. **`loadPreviousChanges(workspace)`**: Read a tracking file `docs/feedback-compiler-history.json` (create if doesn't exist). This stores previous `ChangeRecord` entries so the compiler can check effectiveness.

5. **`buildAnalysisContext(memory, prompts, prHistory, previousChanges)`**: Assemble all of the above into a single structured string for the Claude prompt.

## Step 6: Implement the compiler prompt

Create `src/compiler-prompt.ts`:

**System prompt (`COMPILER_SYSTEM_PROMPT`):**

You are the TLM Feedback Compiler, the self-improvement engine for the Agent Forge TLM pipeline. You analyze accumulated outcome data from the TLM Code Reviewer, Spec Reviewer, and Outcome Tracker and propose concrete changes to improve their performance.

The prompt must include:

- **Role and purpose:** Close the loop between observation and adaptation. The Outcome Tracker logs what happened. You determine what to change so it doesn't happen again.
- **Analysis framework:**
  1. Look for elevated failure rates per agent compared to their historical baseline in the Stats section.
  2. Look for repeated failure modes: same file paths, same categories, same types of issues appearing across multiple Reversed/Caused Issues outcomes.
  3. Look for cross-agent misalignment: did the Spec Reviewer approve a spec that led to a PR the Code Reviewer flagged? Did the Code Reviewer approve a PR the Outcome Tracker later classified as "caused_issues"?
  4. Check effectiveness of previous Feedback Compiler changes: did the targeted pattern recur after the fix was merged?
  5. Check for stale Hot Patterns in the memory file (>30 days with no supporting recent evidence).
  6. Check for prompt gaps: are there categories of issues in the outcome data that no agent's prompt addresses?
- **Change proposal rules:**
  - Every proposed change must include exact `original_section` and `replacement_section` strings so the change can be applied programmatically (like a find-and-replace).
  - Changes to prompt files must be minimal and targeted. One pattern, one change. Don't rewrite entire prompts.
  - Memory updates (Hot Patterns, Lessons Learned) should follow the existing format exactly.
  - If a previous Feedback Compiler change was ineffective, propose a revert (use `change_type: "revert-previous"`).
  - If a pattern is too complex or ambiguous for an automated fix, use `change_type: "escalation"` with a clear description of what needs human attention.
- **Output format:** JSON matching the `CompilerAnalysis` schema (defined in types.ts). Include the exact schema in the prompt.

**User prompt builder (`buildCompilerUserPrompt`):**

Takes the analysis context from Step 5 and formats it into sections:
- Current TLM Memory (full content of tlm-memory.md)
- Agent Prompts (the extracted system prompt strings for all three agents)
- Recent PR History (table of merged PRs with TLM decisions and outcomes)
- Previous Feedback Compiler Changes (from history.json, with effectiveness status)
- Instructions to analyze and respond with JSON

## Step 7: Implement change proposer and PR delivery

Create `src/change-proposer.ts` and wire everything together in `src/index.ts`:

**`change-proposer.ts`:**

1. `applyChanges(analysis: CompilerAnalysis, workspace: string)`: For each proposed_change in the analysis:
   - Read the target file from the workspace.
   - Find `original_section` in the file content. If not found, skip with a warning (Claude hallucinated the section).
   - Replace with `replacement_section`.
   - Write the updated file.
   - Track which files were modified.

2. `updateHistory(analysis: CompilerAnalysis, previousChanges: ChangeRecord[], workspace: string)`: Update `docs/feedback-compiler-history.json`:
   - Add new ChangeRecord entries for each proposed change.
   - Update effectiveness check results for previous changes based on Claude's analysis.

**`src/index.ts` (main entry point):**

Follow the Outcome Tracker's `run()` function pattern exactly for error handling, core.getInput, core.setOutput, and octokit setup.

Flow:
1. Load memory, agent prompts, PR history, previous changes (Steps 5's functions).
2. If memory has fewer than 3 assessed outcomes (not premature), log "Insufficient data for pattern analysis" and exit early. Don't waste API calls when there's nothing to analyze.
3. Build the compiler prompt and call Claude API (reuse the exact `callClaudeAPI` pattern from Outcome Tracker, with JSON extraction via regex).
4. Parse the CompilerAnalysis response.
5. If no `action-needed` patterns, post a `core.notice()` annotation and exit.
6. For non-escalation changes:
   a. Create a new branch: `feedback-compiler/YYYY-MM-DD` using octokit's git refs API.
   b. Apply proposed changes to files in the workspace.
   c. For each modified file, use octokit to create/update the file on the new branch (using the GitHub Contents API, same pattern as the Spec Reviewer uses to commit improvements).
   d. Update `docs/feedback-compiler-history.json` on the branch.
   e. Open a PR from the branch to `main` with a structured description:

   ```
   ## Feedback Compiler: Proposed Agent Improvements

   **Analysis window:** {start_date} to {end_date}
   **Outcomes analyzed:** {count from memory stats}
   **Patterns detected:** {count} ({count} action-needed)
   **Changes proposed:** {count}
   **Previous changes effectiveness:** {effective}/{total checked}

   ### Changes

   #### 1. {change description}
   **Target:** `{target_file}`
   **Pattern:** {pattern description}
   **Evidence:** {evidence summary}
   **Expected impact:** {expected impact}

   [repeat for each change]

   ### Effectiveness Review
   {summary of previous change effectiveness checks, or "No previous changes to evaluate" if first run}

   ---
   Generated by TLM Feedback Compiler ([ADR-009](../docs/adr/009-feedback-compiler-agent.md))
   ```

7. For escalation items: create a GitHub issue labeled `feedback-compiler` and `needs-human-review`, with the pattern description and evidence.
8. Set outputs: `patterns-detected`, `changes-proposed`, `pr-number`.

## Step 8: Add dashboard page

Create `app/dashboard/feedback-compiler/page.tsx`:

A simple dashboard page that shows:
- Last Feedback Compiler run date and summary
- List of all Feedback Compiler PRs (fetch via GitHub API, filter by branch prefix `feedback-compiler/`) with status (open/merged/closed)
- Effectiveness tracking: for merged PRs, show whether the targeted pattern recurred
- Current agent health scores derived from `tlm-memory.md` Stats (correct rate = correct / total assessed)
- Link to `docs/feedback-compiler-history.json` for detailed records

Use the same UI patterns as the existing dashboard pages (shadcn/ui components, Tailwind). This page should be server-rendered and fetch data at request time (no caching needed since it's an internal dashboard).

Check existing dashboard pages for layout and component patterns before building.

## Step 9: Update SYSTEM_MAP.md

Add the Feedback Compiler to `docs/SYSTEM_MAP.md`:
- Add it to the TLM Agents section as the fourth agent
- Document its trigger (weekly cron), inputs (memory, prompts, PR history), and outputs (PRs, issues)
- Show the feedback loop: Outcome Tracker writes memory -> Feedback Compiler reads memory + prompts -> proposes prompt changes via PR -> Code Reviewer gates -> merge -> agents read updated prompts

## Step 10: Build and verify

1. `cd .github/actions/tlm-feedback-compiler && npm install && npm run build` to produce `dist/index.js`.
2. `npm run typecheck` to verify no type errors.
3. Verify the workflow YAML is valid.
4. Verify `docs/feedback-compiler-history.json` is created with an empty initial state: `{ "changes": [], "lastRun": null }`.
5. Verify the dashboard page builds without errors: `npx next build` from the repo root (or at minimum `npx tsc --noEmit`).
6. Verify the SYSTEM_MAP.md update is accurate.
7. Verify the ADR follows the format from `docs/adr/000-conventions.md`.

## Pre-flight Self-Check

Before opening a PR, verify ALL of the following:
- [ ] The Feedback Compiler workflow uses `GH_PAT` (not `GITHUB_TOKEN`) for branch creation and PR opening.
- [ ] The action uses the same Claude API call pattern as the Outcome Tracker (direct fetch to `https://api.anthropic.com/v1/messages`, not the SDK).
- [ ] The compiler prompt instructs Claude to produce exact `original_section`/`replacement_section` strings (not vague descriptions).
- [ ] The `parseMemoryFile` logic is copied from the Outcome Tracker (not imported from it, since they're separate actions with separate builds).
- [ ] The workflow has `concurrency: { group: tlm-feedback-compiler, cancel-in-progress: false }`.
- [ ] The PR description template includes the effectiveness review section.
- [ ] Error handling exists for: empty memory, no outcomes to analyze, Claude API failure, file not found for proposed changes, branch already exists, PR creation failure.
- [ ] No secrets are logged or included in PR descriptions.
- [ ] The `dist/` directory is committed (required for composite actions using `node20`).
- [ ] The dashboard page imports are correct and don't reference non-existent components.
- [ ] `docs/feedback-compiler-history.json` initial state is committed.

## Session Abort Protocol

If execution cannot complete:
1. Commit all work in progress to the branch with a clear message indicating partial completion.
2. Push the branch.
3. Output structured status to stdout:
```
ABORT: feedback-compiler-v1
COMPLETED: [list of completed steps with specifics]
REMAINING: [list of remaining steps]
BLOCKER: [description of what prevented completion]
PARTIAL_PR_POSSIBLE: [yes/no -- whether enough is done to open a draft PR]
```
