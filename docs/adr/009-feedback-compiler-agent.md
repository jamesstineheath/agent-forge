# ADR-009: Feedback Compiler Agent

**Date:** 2026-03-14
**Status:** Accepted

## Context

Agent Forge has a complete observation layer: the Outcome Tracker classifies merged PR results into a universal taxonomy (Correct, Reversed, Caused Issues, Missed, Premature) and maintains `docs/tlm-memory.md` with Hot Patterns, Lessons Learned, and Stats. All three TLM agents (Code Reviewer, Spec Reviewer, Outcome Tracker) read this memory on every run.

What's missing is the step between observation and adaptation. Nothing today reads accumulated outcome data, identifies failure patterns, and translates those into concrete changes to agent behavior. The connection between "Code Reviewer missed dependency issues in 3 of the last 5 PRs" and "add a dependency-check instruction to the Code Reviewer's system prompt" requires a human to notice the pattern, open the prompt file, and make the edit.

The current `tlm-memory.md` already shows this gap in practice. There are 3 "caused_issues" out of 6 total assessed PRs (50% failure rate), with specific patterns around high-churn files (lib/atc.ts), CI workflow robustness, and missing error logging. These patterns are documented in Hot Patterns but have not been translated into prompt changes for the agents. The system observes its own mistakes but cannot act on them.

## Decision

Add a fourth TLM agent: the **Feedback Compiler**. It runs on a weekly schedule, reads outcome data from `docs/tlm-memory.md` and GitHub PR history, detects failure patterns across all three existing agents, and proposes concrete changes to agent prompts, thresholds, or configuration. All changes are delivered as PRs, gated by the existing Code Reviewer and human approval flow.

### How it works

1. **Gather context.** Read `docs/tlm-memory.md` (outcomes, patterns, lessons, stats). Read the system prompt files for all three agents (`review-prompt.ts`, spec review prompt, `outcome-prompt.ts`). Fetch recent merged PR history from GitHub API. Load its own previous change records from `docs/feedback-compiler-history.json`.

2. **Detect patterns via Claude.** Send all gathered context to Claude with a structured analysis prompt. Claude identifies:
   - Elevated failure rates per agent compared to historical baseline
   - Repeated failure modes (same file paths, categories, or issue types across multiple negative outcomes)
   - Cross-agent misalignment (Spec Reviewer approves specs that lead to PRs the Code Reviewer flags; Code Reviewer approves PRs the Outcome Tracker later classifies as "caused_issues")
   - Stale Hot Patterns (entries >30 days old with no recent supporting evidence)
   - Prompt gaps (categories of issues in outcome data that no agent's prompt addresses)
   - Effectiveness of previous Feedback Compiler changes (did the targeted pattern recur?)

3. **Propose changes.** For each actionable pattern, Claude generates:
   - Exact find-and-replace text for the target file (prompt amendment, memory update, or threshold adjustment)
   - Description of what pattern it addresses and what evidence supports it
   - Expected impact
   - Or an escalation flag for patterns too complex for automated fixes

4. **Deliver via PR.** Create a branch (`feedback-compiler/YYYY-MM-DD`), apply proposed changes, open a PR with structured description including evidence and expected impact. The existing Code Reviewer evaluates the PR. James approves or rejects.

5. **Track effectiveness.** Store change records in `docs/feedback-compiler-history.json`. On subsequent runs, check whether targeted failure patterns recurred after changes were merged. If a previous change was ineffective (pattern recurred) or harmful (failure rate increased), propose a revert.

### Pipeline position

```
Spec Reviewer -> Execute Handoff -> Code Reviewer -> (merge) -> Outcome Tracker -> Feedback Compiler
                                                                      ^                      |
                                                                      |  (proposes prompt     |
                                                                      |   changes via PR)     |
                                                                      +----------------------+
```

The Feedback Compiler is the only agent that modifies other agents' prompts. This makes it the system's adaptation mechanism: the Outcome Tracker is the sensor, the Feedback Compiler is the actuator.

### What it does NOT do

- It does not modify agent behavior directly. All changes go through PRs with Code Reviewer + human approval.
- It does not depend on Vercel Blob. The current TLM pipeline stores everything in the repo (memory file, prompt files, PR history via GitHub API). The Feedback Compiler works with what exists.
- It does not run evals. Eval infrastructure would complement this agent but is not a prerequisite. Effectiveness is measured by whether targeted patterns recur, not by running test suites.
- It does not replace the Outcome Tracker. The Outcome Tracker classifies individual actions. The Feedback Compiler identifies patterns across many classified actions.

### Implementation

The Feedback Compiler follows the same implementation pattern as the other TLM agents:
- GitHub Actions composite action (`.github/actions/tlm-feedback-compiler/`)
- node20 runtime, ncc-bundled TypeScript
- Direct Claude API calls (fetch to `api.anthropic.com`, not SDK)
- Weekly cron trigger (Sunday 10pm UTC) plus manual dispatch
- `GH_PAT` token (not `GITHUB_TOKEN`) because it creates branches and PRs that must trigger downstream workflows

A lightweight dashboard page (`app/dashboard/feedback-compiler/page.tsx`) provides visibility into Feedback Compiler activity: past PRs, effectiveness tracking, and agent health scores.

## Consequences

**Positive:**
- Closes the self-improvement loop. Agent behavior improves based on observed outcomes without manual intervention (beyond PR approval).
- Every prompt evolution is a PR with evidence and rationale, fully auditable in git history.
- Reuses existing safety infrastructure (Code Reviewer gates, human approval). No new trust boundaries.
- Effectiveness tracking creates a second-order loop: the system knows whether its own fixes work, and can revert them if they don't.
- Cross-agent analysis catches systemic issues that per-agent evaluation misses.
- Weekly cadence keeps operational overhead low (one PR per week to review, at most).

**Negative:**
- Fourth agent in the TLM pipeline. Increases system complexity, token cost, and the surface area of things that can break.
- Weekly cadence means a full improvement cycle (detect, propose, merge, observe results) takes at minimum two weeks. Fast-moving regressions still need the human escalation path.
- Pattern detection quality depends on outcome data density. With only 6 assessed PRs currently, signal is thin. The agent handles this with a minimum-data threshold (at least 3 non-premature assessments) to avoid overreacting to sparse data.
- Risk of prompt drift over many iterations. Mitigated by: Code Reviewer gate, human approval, effectiveness tracking with revert capability, and git history showing the full evolution.
- Claude may propose changes based on pattern misinterpretation. The find-and-replace approach (exact `original_section`/`replacement_section`) limits blast radius: a bad proposal either fails to match (and is skipped) or makes a targeted change that's easy to revert.

## Open Questions

- Should the Feedback Compiler have the ability to modify its own prompt? This would make it truly self-improving but creates a recursive trust problem. Deferring this for now.
- What's the right minimum-data threshold before the compiler starts proposing changes? Starting with 3 non-premature assessments, but may need tuning.
- Should cross-agent pattern detection be part of v1 or deferred? Including it in v1 since the data is already available and it's the most differentiated capability.
