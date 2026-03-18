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

## Execution Steps

### Step 0: Pre-flight checks
