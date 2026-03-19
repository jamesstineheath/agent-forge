# Agent Forge -- Supervisor Low-Urgency Task Throttling and PM Agent Early-Exit

## Metadata
- **Branch:** `feat/supervisor-throttling-pm-early-exit`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/supervisor.ts, lib/pm-agent.ts

## Context

The Supervisor agent (`lib/atc/supervisor.ts`) runs on a 10-minute cron cadence. Some of its sub-tasks (branch cleanup, stale PR monitoring) are low-urgency and don't need to run every cycle — running them every 10 minutes wastes API quota and compute. The fix is to persist last-run timestamps to Vercel Blob and gate those tasks with cooldown checks.

The PM Agent (`lib/pm-agent.ts`) makes expensive LLM calls on every 15-minute cron tick regardless of whether there's anything to act on. If the backlog is empty and no projects need decomposition, those calls are pure waste. The fix is an early-exit guard that checks work item and project state before invoking Claude.

**Storage:** Timestamps will be stored in Vercel Blob at `af-data/supervisor-task-timestamps.json` as a simple JSON object:
```json
{
  "branchCleanup": "2024-01-15T10:00:00.000Z",
  "stalePrMonitoring": "2024-01-15T10:00:00.000Z"
}
```

**Cooldowns:**
- Branch cleanup: 60 minutes
- Stale PR monitoring: 30 minutes

**Concurrent work note:** The concurrent branch `fix/health-monitor-early-exit-optimization` only touches `lib/atc/health-monitor.ts`. This work item only touches `lib/atc/supervisor.ts` and `lib/pm-agent.ts`. No overlap.

**Existing patterns to follow:**
- Storage access uses `lib/storage.ts` (Vercel Blob wrappers — look for `getJson`, `putJson`, or similar helpers already in that file)
- The `lib/atc/types.ts` file has shared types — do not add types there unless already appropriate
- Early-exit in agents follows the pattern: check state, log reason, return structured result

## Requirements

1. Supervisor reads `af-data/supervisor-task-timestamps.json` from Vercel Blob at the start of each cycle (gracefully defaulting to `{}` if not found)
2. Branch cleanup is skipped if fewer than 60 minutes have elapsed since its last recorded timestamp
3. Stale PR monitoring is skipped if fewer than 30 minutes have elapsed since its last recorded timestamp
4. When either task runs, its timestamp in the JSON is updated and written back to Vercel Blob immediately after the task completes
5. Agent health monitoring and escalation management are NOT throttled — they run every cycle as before
6. PM Agent checks for active projects (states: `active`, `in_progress`, `decomposing`, or any non-terminal state used in the codebase) AND work items needing attention before making any LLM calls
7. If PM Agent finds no active projects and no work items needing attention, it returns early with a structured log message (no LLM calls made)
8. All changes compile successfully with `npm run build`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/supervisor-throttling-pm-early-exit
```

### Step 1: Understand existing code structure

Read the relevant files before making changes:

```bash
cat lib/atc/supervisor.ts
cat lib/pm-agent.ts
cat lib/storage.ts
cat lib/work-items.ts
cat lib/projects.ts
cat lib/atc/types.ts
```

Key things to identify:
- How `supervisor.ts` is structured: what functions exist, how sub-tasks are invoked, what the main exported function/handler looks like
- What storage utility functions exist in `lib/storage.ts` (e.g., `getJson`, `putJson`, `getBlob`, `putBlob`, or direct `@vercel/blob` imports)
- How `lib/pm-agent.ts` invokes LLM calls: find the entry-point function and where Claude is first called
- What "active" project states are used in `lib/projects.ts` or `lib/types.ts` (look for state enums/literals like `'active'`, `'in_progress'`, `'decomposing'`, `'planning'`)
- How work items are listed/queried in `lib/work-items.ts` — find a function that lists all work items or lists by status

### Step 2: Add timestamp throttling to Supervisor

In `lib/atc/supervisor.ts`, implement the following pattern:

**2a. Add a timestamp blob key constant near the top of the file:**
```typescript
const SUPERVISOR_TIMESTAMPS_KEY = 'af-data/supervisor-task-timestamps.json';
```

**2b. Add a type for the timestamps object:**
```typescript
interface SupervisorTaskTimestamps {
  branchCleanup?: string;   // ISO timestamp string
  stalePrMonitoring?: string; // ISO timestamp string
}
```

**2c. Add helper functions to load and save timestamps.** Use whatever storage primitive exists in `lib/storage.ts`. If there's a `getJson`/`putJson` pattern, use it. If storage uses raw `@vercel/blob` imports, follow that pattern. Example using a hypothetical `getJson`/`putJson`:

```typescript
async function loadTaskTimestamps(): Promise<SupervisorTaskTimestamps> {
  try {
    const data = await getJson<SupervisorTaskTimestamps>(SUPERVISOR_TIMESTAMPS_KEY);
    return data ?? {};
  } catch {
    return {};
  }
}

async function saveTaskTimestamps(timestamps: SupervisorTaskTimestamps): Promise<void> {
  await putJson(SUPERVISOR_TIMESTAMPS_KEY, timestamps);
}
```

If `lib/storage.ts` uses different function names, adapt accordingly. If it wraps `@vercel/blob` directly, use `list`/`put`/`head` as appropriate.

**2d. Add a cooldown check helper:**
```typescript
function isThrottled(lastRan: string | undefined, cooldownMinutes: number): boolean {
  if (!lastRan) return false;
  const elapsed = Date.now() - new Date(lastRan).getTime();
  return elapsed < cooldownMinutes * 60 * 1000;
}
```

**2e. In the main supervisor cycle function** (wherever branch cleanup and stale PR monitoring are called), load timestamps at the start and gate each task:

```typescript
// Load timestamps at start of cycle
const timestamps = await loadTaskTimestamps();
const updatedTimestamps: SupervisorTaskTimestamps = { ...timestamps };

// Branch cleanup — throttled to once per hour
if (isThrottled(timestamps.branchCleanup, 60)) {
  console.log('[Supervisor] Skipping branch cleanup: ran recently');
} else {
  // ... existing branch cleanup logic ...
  updatedTimestamps.branchCleanup = new Date().toISOString();
  await saveTaskTimestamps(updatedTimestamps);
}

// Stale PR monitoring — throttled to once per 30 minutes
if (isThrottled(timestamps.stalePrMonitoring, 30)) {
  console.log('[Supervisor] Skipping stale PR monitoring: ran recently');
} else {
  // ... existing stale PR monitoring logic ...
  updatedTimestamps.stalePrMonitoring = new Date().toISOString();
  await saveTaskTimestamps(updatedTimestamps);
}
```

**Important:** The timestamp is saved immediately after each task runs (not batched at the end), so if one task crashes the other's timestamp is still preserved.

**Agent health monitoring and escalation management must NOT be wrapped in any throttle check** — leave those exactly as-is.

### Step 3: Add early-exit guard to PM Agent

In `lib/pm-agent.ts`, find the main exported entry-point function (likely something like `runPmAgent`, `pmAgentCycle`, or the handler exported from the route). Identify exactly where the first LLM/Claude call happens.

**3a. Before any LLM calls, add an early-exit guard:**

First, identify:
- The function in `lib/projects.ts` that lists all projects (probably `listProjects` or `getAllProjects`)
- The function in `lib/work-items.ts` that lists all work items (probably `listWorkItems` or `getAllWorkItems`)
- The terminal project states (probably `'completed'`, `'failed'`, `'cancelled'` — look at the `Project` type in `lib/types.ts`)
- The work item states that need attention (probably `'ready'`, `'filed'`, `'blocked'`, `'parked'`, `'executing'`, `'generating'` — anything non-terminal)

**3b. Add the guard:**
```typescript
// Early-exit: skip LLM calls if there's nothing to act on
const [allProjects, allWorkItems] = await Promise.all([
  listProjects(),      // use actual function name from lib/projects.ts
  listWorkItems(),     // use actual function name from lib/work-items.ts
]);

const TERMINAL_PROJECT_STATES = ['completed', 'failed', 'cancelled']; // verify against actual types
const activeProjects = allProjects.filter(p => !TERMINAL_PROJECT_STATES.includes(p.status));

const TERMINAL_WORK_ITEM_STATES = ['merged', 'cancelled']; // verify against actual types
const actionableWorkItems = allWorkItems.filter(wi => !TERMINAL_WORK_ITEM_STATES.includes(wi.status));

if (activeProjects.length === 0 && actionableWorkItems.length === 0) {
  console.log('[PM Agent] Early exit: no active projects or actionable work items');
  return { skipped: true, reason: 'no active projects or actionable work items' };
}
```

**Important:** Use the actual state string literals from the codebase — read `lib/types.ts` first to find the exact values. Don't guess at state names.

**3c. Ensure the return type is compatible.** If the function has a declared return type, make sure returning `{ skipped: true, reason: string }` is compatible (either the return type is `any`/`unknown`, or you need to add this shape to a union, or the type already has an optional `skipped` field). Look at the existing return type and adapt accordingly — don't break the TypeScript types.

### Step 4: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- Return type mismatch on the PM Agent early-exit path — check what the function's declared return type is and ensure `{ skipped: true, reason: string }` is assignable
- The `SupervisorTaskTimestamps` interface may need to be placed before functions that reference it
- If `lib/storage.ts` doesn't have a `getJson`/`putJson` helper and uses raw blob operations, the pattern needs to match exactly

### Step 5: Build verification

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 6: Smoke-test review

Manually review the diff to confirm:
- [ ] `branchCleanup` and `stalePrMonitoring` tasks are gated by `isThrottled()`
- [ ] Agent health monitoring and escalation management have NO throttle gate
- [ ] Timestamps are saved after each task runs (not at the end of the cycle only)
- [ ] PM Agent early-exit returns before any `anthropic` / `claude` / `generateText` / `streamText` call
- [ ] No existing logic has been accidentally removed from either file

```bash
git diff main -- lib/atc/supervisor.ts lib/pm-agent.ts
```

### Step 7: Commit, push, open PR

```bash
git add lib/atc/supervisor.ts lib/pm-agent.ts
git commit -m "feat: supervisor task throttling and PM agent early-exit

- Branch cleanup throttled to once per hour (was every 10min)
- Stale PR monitoring throttled to once per 30min (was every 10min)  
- Timestamps persisted to af-data/supervisor-task-timestamps.json in Vercel Blob
- Agent health monitoring and escalation management unchanged (run every cycle)
- PM Agent returns early if no active projects or actionable work items"

git push origin feat/supervisor-throttling-pm-early-exit

gh pr create \
  --title "feat: supervisor task throttling and PM agent early-exit" \
  --body "## Summary

Reduces unnecessary compute and API quota usage by throttling low-urgency supervisor tasks and short-circuiting the PM Agent when there's nothing to act on.

## Changes

### lib/atc/supervisor.ts
- Added \`SupervisorTaskTimestamps\` interface and \`SUPERVISOR_TIMESTAMPS_KEY\` constant
- Added \`loadTaskTimestamps()\` and \`saveTaskTimestamps()\` helpers (Vercel Blob)
- Added \`isThrottled()\` cooldown check helper
- Branch cleanup: throttled to once per hour (60-min cooldown)
- Stale PR monitoring: throttled to once per 30 minutes
- Agent health monitoring and escalation management: unchanged, run every cycle
- Timestamps saved immediately after each task completes

### lib/pm-agent.ts
- Added early-exit guard before first LLM call
- Checks active projects and actionable work items via existing list functions
- Returns early with \`{ skipped: true, reason: ... }\` if nothing to act on

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes

## Risk
Low — additive changes only. Throttled tasks still run when cooldown expires. PM Agent early-exit only fires when state is genuinely empty." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: partial supervisor throttling and PM agent early-exit"
git push origin feat/supervisor-throttling-pm-early-exit
```

2. Open the PR with partial status:
```bash
gh pr create --title "wip: supervisor throttling and PM agent early-exit (partial)" --body "Partial implementation — see ISSUES below" --base main
```

3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/supervisor-throttling-pm-early-exit
FILES CHANGED: [lib/atc/supervisor.ts, lib/pm-agent.ts — list which were modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was blocked]
NEXT STEPS: [what remains — e.g., "PM Agent return type needs resolving", "storage helper pattern unclear"]
```

## Escalation

If blocked by an unresolvable ambiguity (e.g., the storage module has no usable read primitive, the PM Agent's return type is a complex union that can't accept the early-exit shape, or the supervisor's sub-tasks are not cleanly separated):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "supervisor-throttling-pm-early-exit",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker>",
      "filesChanged": ["lib/atc/supervisor.ts", "lib/pm-agent.ts"]
    }
  }'
```