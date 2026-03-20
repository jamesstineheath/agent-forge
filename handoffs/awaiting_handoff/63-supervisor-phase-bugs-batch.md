# Handoff 63: supervisor-phase-bugs-batch

## Metadata
- Branch: `fix/supervisor-phase-bugs-batch`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $5
- Risk Level: medium
- Complexity: moderate
- Depends On: None
- Date: 2026-03-20
- Executor: Claude Code (GitHub Actions)

## Context

Three Supervisor phase bugs observed in the 23:00 UTC cycle (March 20, 2026). All are in phase route handlers under app/api/agents/supervisor/phases/.

**Bug A: criteria-import over-aggressive cleanup (MEDIUM, data integrity risk)**
The criteria-import phase has stale criteria cleanup logic that deletes Blob-stored criteria and architecture plans for PRDs it considers "completed." In the last two cycles, it cleaned up criteria for PRDs that are NOT complete: Vercel Spend Monitoring (Backlog, Rank 475), Model Routing (Partially Executed, Rank 800), Priority-Aware Dispatch Queue (Backlog, Rank 900), Structured Episodic Memory (Paused), PA Travel Agent (Partially Executed), and Debate-Based TLM Review (Partially Executed). The cleanup was added in PR #394 to delete criteria/plans for Complete/Paused/Obsolete PRDs. The bug is either: (1) the status check is wrong (matching Partially Executed or Backlog as "completed"), or (2) the PRD status lookup is stale/incorrect. This is silently destroying work the pipeline needs.

**Bug B: pm-sweep Opus timeout (LOW, housekeeping)**
The pm-sweep phase was migrated to routedAnthropicCall in PR #395, which fixed the stale model string error. But routedAnthropicCall now routes to Opus by default, and the Opus call takes 55s+ causing a timeout. pm-sweep is a housekeeping-tier phase that reviews stale work items and does lightweight backlog triage. It should explicitly use Sonnet (either by passing a model override to routedAnthropicCall, or by calling the Anthropic API directly with a Sonnet model string). The phase timeout in the coordinator manifest may also need a bump from whatever it currently is, but routing to Sonnet is the real fix since Sonnet will respond in 5-10s.

**Bug C: spend-monitoring 404 (LOW, informational)**
The spend-monitoring phase calls the Vercel billing API and gets a 404: {"error":{"code":"not_found","message":"Not Found"}}. VERCEL_TEAM_ID is set (the phase runs instead of skipping). The issue is likely the API endpoint URL or how the team ID is used in the request. The Vercel billing/usage API may require a different endpoint path, or the team ID format may be wrong. Check the actual fetch URL in the phase handler and compare against the Vercel REST API docs (https://vercel.com/docs/rest-api). If the API endpoint genuinely doesn't exist for Pro plans, the phase should detect that and skip gracefully with an informational message instead of reporting a failure.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm criteria-import phase handler exists under app/api/agents/supervisor/phases/criteria-import/
- [ ] Confirm pm-sweep phase handler exists under app/api/agents/supervisor/phases/pm-sweep/
- [ ] Confirm spend-monitoring phase handler exists under app/api/agents/supervisor/phases/spend-monitoring/
- [ ] Read the criteria-import handler to find the stale cleanup logic added in PR #394

## Step 0: Branch, commit handoff, push

Create branch `fix/supervisor-phase-bugs-batch` from `main`. Commit this handoff file. Push.

## Step 1: **Bug A (criteria-import cleanup):** Read the criteria-import phase handler. Find the stale criteria cleanup logic. It should ONLY delete Blob-stored criteria and architecture plans for PRDs with status Complete or Obsolete. Currently it appears to also match Partially Executed, Paused, and possibly Backlog. Fix the status filter to be an exact match on ['Complete', 'Obsolete'] only. Paused PRDs should retain their criteria (they may resume). Partially Executed PRDs definitely need their criteria (remaining items still need to execute).

## Step 2: **Bug A verification:** After fixing the filter, add a log line that lists which PRDs were cleaned up and their statuses, so the phase log decisions array shows exactly what happened and why. This makes future debugging easier.

## Step 3: **Bug B (pm-sweep Opus routing):** Read the pm-sweep phase handler. Find where it calls routedAnthropicCall or the Anthropic API. Override the model to use Sonnet explicitly. If routedAnthropicCall accepts a model parameter or options, pass 'claude-sonnet-4-20250514' (or whatever the current Sonnet model string is in the codebase, check lib/model-routing.ts or similar). If it doesn't accept an override, call the Anthropic SDK directly with the Sonnet model. pm-sweep is lightweight triage and does not need Opus reasoning.

## Step 4: **Bug C (spend-monitoring 404):** Read the spend-monitoring phase handler. Find the Vercel API fetch call. Check the URL it constructs. The Vercel REST API for usage/billing may be at /v1/usage or /v6/usage/billing, not wherever it currently points. If you can determine the correct endpoint from the code's imports or comments, fix it. If the correct endpoint is unclear, make the phase skip gracefully when a 404 is returned: set phase status to 'skipped' (not 'failure') with a message like 'Vercel billing API returned 404, skipping spend check'. A 404 should not count as a phase failure in the Supervisor log.

## Step 5: Run tsc --noEmit to verify no type errors across all three fixes.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: supervisor-phase-bugs-batch (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/supervisor-phase-bugs-batch",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```

## Post-merge Note

After merge and deploy, monitor the next 2 Supervisor cycles via get_pipeline_health. Expected: (A) criteria-import should NOT clean up any active PRDs (only truly Complete/Obsolete ones), (B) pm-sweep should succeed in under 15s, (C) spend-monitoring should either succeed or skip gracefully with an info message instead of "failure" status.