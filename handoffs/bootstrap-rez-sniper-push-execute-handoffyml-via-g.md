<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Bootstrap rez-sniper: push execute-handoff.yml via GitHub API

## Metadata
- **Branch:** `feat/bootstrap-rez-sniper-workflows`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `handoffs/bootstrap-rez-sniper-workflows.md`

## Context

The `jamesstineheath/rez-sniper` repository is missing the core GitHub Actions workflow files required to participate in the Agent Forge pipeline. When the dispatcher attempts to trigger work items against rez-sniper, it calls `workflow_dispatch` on `execute-handoff.yml` — which doesn't exist in that repo — resulting in 404 errors for all queued work items (including `ed4c524e` and `52380e5a`).

The fix is to copy three workflow files from `jamesstineheath/agent-forge` (this repo) into `jamesstineheath/rez-sniper` via the GitHub Contents API:
1. `.github/workflows/execute-handoff.yml` — the main execution workflow
2. `.github/workflows/tlm-spec-review.yml` — handoff spec review before execution
3. `.github/workflows/tlm-review.yml` — TLM code review on PRs

This task runs entirely via `gh` CLI API calls — no source files in agent-forge are modified (other than committing the handoff record). There is no overlap with the concurrent work item on `.github/actions/tlm-review/src/index.ts`.

After pushing the workflows, work items `ed4c524e` and `52380e5a` need to be reset to `ready` status so the dispatcher can re-attempt them.

**Important caveat:** The workflow files may contain agent-forge-specific references (repo names in `repository_dispatch`, hardcoded paths, etc.). Step 1 includes a check for this. If the workflows are not portable as-is, escalate rather than pushing broken workflows.

## Requirements

1. Read each of the three workflow files from `jamesstineheath/agent-forge` main branch via `gh api`.
2. Write each file to `jamesstineheath/rez-sniper` main branch at the identical path via `gh api` PUT (create or update).
3. Each commit message follows the pattern: `chore: bootstrap <filename> workflow`.
4. Verify all three files exist in rez-sniper after push by re-reading them via `gh api`.
5. Reset work items `ed4c524e` and `52380e5a` to `ready` status via the Agent Forge work items API.
6. No modifications to `.github/actions/tlm-review/src/index.ts` or any files touched by the concurrent work item.

## Escalation Record

**Status:** ESCALATED — workflows are not portable as-is
**Date:** 2026-03-18
**Executor:** Claude Code (execute-handoff pipeline)

### Findings

1. **`execute-handoff.yml` already exists in rez-sniper.** The original 404 error described in the Context section may have been resolved by a prior manual push. No action needed for this file.

2. **`tlm-spec-review.yml` is NOT portable.** It references a local composite action at `./.github/actions/tlm-spec-review` (line 34: `uses: ./.github/actions/tlm-spec-review`). This composite action is a multi-file TypeScript package (`action.yml`, `src/index.ts`, `src/spec-review-prompt.ts`, `dist/index.js`, `package.json`, `tsconfig.json`) that does not exist in rez-sniper.

3. **`tlm-review.yml` is NOT portable.** It references a local composite action at `./.github/actions/tlm-review` (line 31: `uses: ./.github/actions/tlm-review`). This composite action is similarly a multi-file TypeScript package (`action.yml`, `src/index.ts`, `src/review-prompt.ts`, `dist/index.js`, `package.json`, `tsconfig.json`) that does not exist in rez-sniper.

### Recommended Resolution

To make rez-sniper a full pipeline participant, one of these approaches is needed:

- **Option A (recommended):** Also push the composite actions (`.github/actions/tlm-spec-review/` and `.github/actions/tlm-review/` with all their files) to rez-sniper. This requires pushing ~12 additional files.
- **Option B:** Refactor the workflows to use a centralized/reusable workflow pattern (`uses: jamesstineheath/agent-forge/.github/workflows/...@main`) so target repos don't need local copies of composite actions.
- **Option C:** Create a bootstrap script/action that copies both workflows AND their composite action dependencies to target repos.

### Work Items

Work items `ed4c524e` and `52380e5a` were NOT reset to `ready` status because the original 404 issue may already be resolved (`execute-handoff.yml` exists in rez-sniper). The dispatcher should be checked to confirm whether these work items can now be dispatched successfully.

## Execution Steps (not executed — escalated)

### Step 0: Pre-flight checks
