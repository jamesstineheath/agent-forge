# Handoff 133: atc-performance-metrics-widget

## Metadata
- Branch: `feat/atc-performance-metrics-widget`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $4
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-17
- Executor: Claude Code (GitHub Actions)

## Context

There is no visibility into ATC performance on the dashboard. The ATC logs its state to Vercel Blob (lastRunAt, activeExecutions, queuedItems, recentEvents) but this data is not exposed in the UI. The /api/atc/state endpoint may already exist. The MCP tool get_atc_state returns: { lastRunAt, activeExecutions[], queuedItems (count), recentEvents[] } where each event has { timestamp, type, workItemId, details }.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Dashboard shows ATC health indicator with last run time
- [ ] Queue depth and active executions are visible
- [ ] Recent events timeline renders
- [ ] npm run build passes

## Step 0: Branch, commit handoff, push

Create branch `feat/atc-performance-metrics-widget` from `main`. Commit this handoff file. Push.

## Step 1: Check if /api/atc/state route exists. If not, create it by reading the ATC state from Blob storage (see lib/atc.ts for how state is loaded)

## Step 2: Create a new component ATCMetricsPanel (in components/) that fetches /api/atc/state via SWR with 30s refresh interval

## Step 3: Display: (a) health indicator with last run time and green/red status, (b) queue depth and active execution count, (c) recent events timeline showing last 10 events with type icons and timestamps

## Step 4: Wire ATCMetricsPanel into the main dashboard page

## Step 5: Run npx tsc --noEmit and npm run build to verify

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: atc-performance-metrics-widget (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/atc-performance-metrics-widget",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```