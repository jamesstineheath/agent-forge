# Agent Forge -- Health Monitor Early-Exit Optimization

## Metadata
- **Branch:** `feat/health-monitor-early-exit`
- **Priority:** medium
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/health-monitor.ts

## Context

The Health Monitor agent (`lib/atc/health-monitor.ts`) runs on a 5-minute cron cadence and performs expensive operations on every invocation: acquiring a distributed lock, polling GitHub for workflow run statuses, checking PR states, detecting merge conflicts, and running CI checks. However, if there are no work items in active pipeline stages (`executing`, `generating`, `reviewing`, or `queued`), all of that work is wasted.

A nearly identical optimization was recently applied to the Dispatcher agent (`lib/atc/dispatcher.ts`) via the "Dispatcher early-exit optimization" PR. This task applies the same pattern to the Health Monitor.

The goal is to check for active-stage work items **before** acquiring the distributed lock or making any GitHub API calls. If no active items exist, return immediately with a log message. When active items do exist, all existing health monitoring behavior must be preserved exactly.

## Requirements

1. Before acquiring the distributed lock, load all work items and check if any are in `executing`, `generating`, `reviewing`, or `queued` status.
2. If no work items are in those active pipeline stages, log a brief observability message (e.g., `"Health Monitor: no active items, skipping cycle"`) and return early without acquiring the lock.
3. When at least one item IS in an active stage, proceed with all existing behavior unchanged: lock acquisition, stall detection, merge conflict recovery, auto-rebase, GitHub API polling, failed PR reconciliation, dependency re-evaluation, etc.
4. The early-exit check must happen before any GitHub API calls or lock acquisition.
5. The project must compile successfully with `npm run build`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/health-monitor-early-exit
```

### Step 1: Read the current Health Monitor implementation

Read the full file to understand its structure before making changes:
```bash
cat lib/atc/health-monitor.ts
```

Also check the Dispatcher for the early-exit pattern to mirror:
```bash
cat lib/atc/dispatcher.ts
```

And review shared types for status values:
```bash
cat lib/atc/types.ts
cat lib/work-items.ts
```

### Step 2: Implement the early-exit guard

Locate the main entry point function in `lib/atc/health-monitor.ts` (likely `runHealthMonitor` or similar). Before the distributed lock acquisition block, add an early-exit check.

The pattern to follow (mirroring the Dispatcher optimization):

```typescript
// Early-exit: skip expensive work if no items are in active pipeline stages
const allItems = await listWorkItems();
const activeStatuses = new Set(['executing', 'generating', 'reviewing', 'queued']);
const hasActiveItems = allItems.some(item => activeStatuses.has(item.status));

if (!hasActiveItems) {
  console.log('Health Monitor: no active items, skipping cycle');
  return { skipped: true, reason: 'no-active-items' };
}
```

**Important implementation notes:**
- Use whatever `listWorkItems` (or equivalent) import is already present in the file — do not add new imports unless necessary.
- Match the return type of the early-exit path to whatever the function already returns (e.g., if it returns `void`, just `return;` with the log; if it returns an object, return a compatible shape).
- Place the check **after** any necessary initialization (imports, logger setup) but **before** the lock acquisition call.
- Do not change any logic inside the lock-acquired section.

### Step 3: Verify types compile

```bash
npx tsc --noEmit
```

Fix any type errors that arise from the early return shape mismatch.

### Step 4: Verify full build

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "refactor: add early-exit guard to Health Monitor agent

Skip lock acquisition and GitHub API polling when no work items are in
active pipeline stages (executing/generating/reviewing/queued).

Mirrors the Dispatcher early-exit optimization. All existing recovery
and reconciliation behavior is preserved when active items exist."

git push origin feat/health-monitor-early-exit

gh pr create \
  --title "refactor: Health Monitor early-exit optimization" \
  --body "## Summary

Adds an early-exit guard to the Health Monitor agent (\`lib/atc/health-monitor.ts\`).

Before acquiring the distributed lock or making any GitHub API calls, the agent now checks whether any work items exist in active pipeline stages (\`executing\`, \`generating\`, \`reviewing\`, \`queued\`). If none do, it logs a brief message and returns immediately.

## Changes
- \`lib/atc/health-monitor.ts\`: early-exit check before lock acquisition

## Behavior
- **No active items**: returns immediately, no lock acquired, no GitHub API calls
- **Active items present**: all existing behavior unchanged

## Pattern
Mirrors the Dispatcher early-exit optimization merged in the prior PR.

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/health-monitor-early-exit
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., `listWorkItems` is not imported in health-monitor.ts and the import path is unclear, or the function signature makes early return type-incompatible in a non-obvious way):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "health-monitor-early-exit",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/health-monitor.ts"]
    }
  }'
```