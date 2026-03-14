# Agent Forge -- Air Traffic Controller

## Metadata
- **Branch:** `feat/air-traffic-controller`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts, app/api/atc/route.ts, app/api/atc/cron/route.ts

## Context

The Air Traffic Controller (ATC) is a monitoring agent that runs on a cron schedule. It checks on active executions, enforces concurrency limits per repo, detects stalled or failed runs, and updates work item statuses accordingly. Without the ATC, the system has no way to know when an execution finishes or fails after dispatch.

This handoff depends on the work item store (01), orchestrator (02), and GitHub helper (02) being merged first.

## Requirements

1. `lib/atc.ts` with the core monitoring logic
2. `/api/atc` GET endpoint returning current ATC state (active executions, queue depth, recent events)
3. `/api/atc/cron` POST endpoint called by Vercel cron every 5 minutes
4. Cron route protected by `CRON_SECRET` header verification
5. Monitors all work items in "executing" or "reviewing" status
6. Checks GitHub for workflow run status and PR status
7. Updates work item status based on observed state (executing -> reviewing when PR opens, reviewing -> merged when PR merges, any -> failed on timeout or workflow failure)
8. Enforces per-repo concurrency limits (from RepoConfig)
9. Detects stalled executions (no progress for 30+ minutes) and marks as failed
10. Logs all state transitions as ATC events in Vercel Blob
11. TypeScript compiles with zero errors

## Execution Steps

### Step 0: Branch setup

```bash
git checkout main && git pull
git checkout -b feat/air-traffic-controller
```

Verify `lib/work-items.ts`, `lib/repos.ts`, `lib/github.ts`, and `lib/orchestrator.ts` exist.

### Step 1: ATC types

Add to `lib/types.ts` (or create `lib/atc-types.ts` if types.ts is getting large):

```typescript
interface ATCEvent {
  id: string;
  timestamp: string;
  type: "status_change" | "timeout" | "concurrency_block" | "error";
  workItemId: string;
  details: string;
  previousStatus?: string;
  newStatus?: string;
}

interface ATCState {
  lastRunAt: string;
  activeExecutions: {
    workItemId: string;
    targetRepo: string;
    branch: string;
    status: string;
    startedAt: string;
    elapsedMinutes: number;
  }[];
  queuedItems: number;
  recentEvents: ATCEvent[];
}
```

### Step 2: ATC monitoring logic

Create `lib/atc.ts`:

```typescript
async function runATCCycle(): Promise<ATCState> {
  // 1. Load all work items with status "executing" or "reviewing"
  // 2. For each active item:
  //    a. Check GitHub workflow run status via getWorkflowRuns()
  //    b. Check if a PR exists via getPRByBranch()
  //    c. Determine state transitions:
  //       - Workflow completed + PR open = "reviewing"
  //       - PR merged = "merged" (set execution.completedAt, outcome = "merged")
  //       - PR closed without merge = "failed"
  //       - Workflow failed = "failed" (set error details)
  //       - No progress for 30+ min = "failed" (timeout)
  //    d. Update work item status if changed
  //    e. Log ATCEvent for each transition
  // 3. Check concurrency: for each repo, count active items. If at limit,
  //    any "ready" items for that repo stay queued (don't auto-dispatch,
  //    just track the constraint)
  // 4. Save ATC state to blob at af-data/atc/state
  // 5. Append events to af-data/atc/events (keep last 200)
  // 6. Return current state
}

async function getATCState(): Promise<ATCState> {
  // Load from af-data/atc/state
  // If no state exists, return empty state
}

async function getATCEvents(limit?: number): Promise<ATCEvent[]> {
  // Load from af-data/atc/events, return most recent N
}
```

State transition rules:
- `executing` -> `reviewing`: workflow run completed successfully AND a PR exists on the branch
- `executing` -> `failed`: workflow run failed OR 30+ minutes with no workflow run found
- `reviewing` -> `merged`: PR merged (check via GitHub API `merged_at` field)
- `reviewing` -> `failed`: PR closed without merge
- `reviewing` -> `failed`: PR open for 60+ minutes with no review activity (optional, may be too aggressive initially -- make this configurable)

When transitioning to `merged`: set `execution.completedAt` to now, `execution.outcome` to `"merged"`, `execution.prUrl` from the PR.

When transitioning to `failed`: store the failure reason in work item metadata. Possible reasons: "workflow_failed", "timeout", "pr_closed", "unknown".

### Step 3: Cron API route

Create `app/api/atc/cron/route.ts`:

```typescript
// POST handler
// 1. Verify Authorization header matches CRON_SECRET
//    - Header: "Authorization: Bearer ${CRON_SECRET}"
//    - Return 401 if missing or wrong
// 2. Call runATCCycle()
// 3. Return { success: true, state: <summary> }
// 4. Catch errors: return { success: false, error: message }
```

### Step 4: Status API route

Create `app/api/atc/route.ts`:

```typescript
// GET handler (auth-protected via auth())
// Returns current ATC state + recent events
// Combines getATCState() and getATCEvents(20)
```

### Step 5: Register cron in vercel.json

Create or update `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/atc/cron",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

### Step 6: Verification

```bash
npx tsc --noEmit      # zero errors
npm run build          # succeeds
```

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: air traffic controller for execution monitoring

Adds the ATC monitoring agent:
- Checks active executions against GitHub workflow/PR status
- Transitions work item status based on observed state
- Detects stalled/failed executions with timeout logic
- Enforces per-repo concurrency limits
- Logs all state transitions as ATC events
- Vercel cron runs every 5 minutes
- API endpoint for dashboard status display"
git push origin feat/air-traffic-controller
gh pr create --title "feat: air traffic controller" --body "## Summary
Monitoring agent that polls GitHub for execution status updates, transitions work item states, detects failures/timeouts, and enforces concurrency limits.

## Files Changed
- lib/atc.ts (monitoring logic + state management)
- lib/types.ts (ATC types)
- app/api/atc/route.ts (status endpoint)
- app/api/atc/cron/route.ts (cron handler)
- vercel.json (cron registration)

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Medium. Reads from GitHub API (rate limiting consideration). Writes only to Vercel Blob (ATC state) and work item status updates. No destructive operations.

## Dependencies
Requires 01-work-item-store and 02-orchestrator to be merged first."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/air-traffic-controller
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
