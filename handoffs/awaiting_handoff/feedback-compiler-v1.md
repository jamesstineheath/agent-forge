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

Create `docs/adr/009-feedback-compiler-agent.md` documenting the decision to add a self-improvement loop via a fourth TLM agent that reads outcome data, detects failure patterns, and proposes prompt/config changes via PRs gated by Code Reviewer. Follow the format in `docs/adr/000-conventions.md`.

## Step 2: Create the GitHub Actions workflow

Create `.github/workflows/tlm-feedback-compiler.yml`. Weekly cron (Sunday 10pm UTC), uses GH_PAT for branch/PR creation, fetch-depth 0 for PR history analysis. 15-minute timeout.

## Step 3: Create the composite action scaffold

Create `.github/actions/tlm-feedback-compiler/` with action.yml, package.json, tsconfig.json matching the Outcome Tracker patterns exactly.

## Step 4: Define types

Create `src/types.ts` with DetectedPattern, PatternEvidence, ProposedChange, FileDiff, ChangeRecord, CompilerAnalysis interfaces.

## Step 5: Implement pattern detection

Create `src/pattern-detector.ts` — data gathering (loadMemory, loadAgentPrompts, fetchRecentPRHistory, loadPreviousChanges, buildAnalysisContext). Prepares structured context for Claude.

## Step 6: Implement the compiler prompt

Create `src/compiler-prompt.ts` with COMPILER_SYSTEM_PROMPT and buildCompilerUserPrompt. Analysis framework: elevated failure rates, repeated failure modes, cross-agent misalignment, effectiveness checks, stale patterns, prompt gaps. Output: CompilerAnalysis JSON.

## Step 7: Implement change proposer and PR delivery

Create `src/change-proposer.ts` and wire in `src/index.ts`. Apply find-and-replace changes, update history.json, create branch, open PR with structured description, create GitHub issues for escalation items.

## Step 8: Add dashboard page

Create `app/dashboard/feedback-compiler/page.tsx` showing last run, PR list, effectiveness tracking, agent health scores.

## Step 9: Update SYSTEM_MAP.md

Add Feedback Compiler to TLM Agents section with feedback loop diagram.

## Step 10: Build and verify

npm install, npm run build, typecheck, verify workflow YAML, verify history.json created, verify dashboard builds, verify ADR format.

## Pre-flight Self-Check

- [ ] Workflow uses `GH_PAT` (not `GITHUB_TOKEN`) for branch creation and PR opening
- [ ] Action uses same Claude API call pattern as Outcome Tracker (direct fetch, not SDK)
- [ ] Compiler prompt requires exact `original_section`/`replacement_section` strings
- [ ] `parseMemoryFile` logic copied from Outcome Tracker (not imported)
- [ ] Concurrency group set, cancel-in-progress false
- [ ] Error handling for: empty memory, no outcomes, API failure, file not found, branch exists, PR failure
- [ ] No secrets logged or in PR descriptions
- [ ] `dist/` directory committed
- [ ] `docs/feedback-compiler-history.json` initial state committed

## Session Abort Protocol

If execution cannot complete:
1. Commit all work in progress to the branch.
2. Push the branch.
3. Output structured status to stdout:
```
ABORT: feedback-compiler-v1
COMPLETED: [list of completed steps]
REMAINING: [list of remaining steps]
BLOCKER: [description]
PARTIAL_PR_POSSIBLE: [yes/no]
```