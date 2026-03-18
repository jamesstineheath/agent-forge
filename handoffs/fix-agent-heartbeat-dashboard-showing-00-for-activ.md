<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix Agent Heartbeat Dashboard Showing 0/0 for Active Agents

## Metadata
- **Branch:** `fix/agent-heartbeat-dashboard`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/dispatcher.ts, lib/atc/health-monitor.ts, lib/atc/types.ts, app/api/agents/atc-metrics/route.ts, app/(app)/agents/page.tsx, lib/hooks.ts

## Context

The agent heartbeat dashboard (shipped in PR #279) shows "0/0 never run" for the Dispatcher and possibly other agents, despite Vercel logs confirming they fire every 5 minutes with 200 responses. The root cause is that the agents don't write heartbeat records to Vercel Blob — they run, log to Vercel function logs, and exit without persisting any state the dashboard can read.

Additionally, the Health Monitor displays "0/37 succeeded" which is alarming-looking but actually means "checked 37 items, 0 needed recovery" — the label is semantically backwards.

The fix has three parts:
1. Each agent writes a heartbeat blob on every cron run: `af-data/agent-heartbeats/{agent-name}/latest.json`
2. The `atc-metrics` API endpoint (or a new `/api/agents/heartbeats` route) reads these blobs to return last-run data
3. The dashboard UI is updated to show correct labels and consume the heartbeat data

**Existing patterns to follow:**
- Storage is via `lib/storage.ts` which wraps Vercel Blob (`put`, `get`, `del`)
- Agent cron routes live at `app/api/agents/{name}/cron/route.ts`
- Dashboard hooks use SWR via `lib/hooks.ts`
- The agents page is at `app/(app)/agents/page.tsx`
- Existing ATC metrics API: `app/api/agents/atc-metrics/route.ts`

**Concurrent work:** `fix/dashboard-qa-results-section-api-route` touches `app/api/qa-results/route.ts` — no overlap with this work.

## Requirements

1. Each cron agent (Dispatcher, Health Monitor, and optionally Supervisor/PM) writes a heartbeat record to `af-data/agent-heartbeats/{agent-name}/latest.json` at the end of every successful cron run. The record must include: `agentName`, `lastRunAt` (ISO timestamp), `durationMs`, `status` (`"ok"` or `"error"`), `itemsProcessed` (count of items the agent acted on), and `notes` (optional free-text summary string).
2. A new API route `GET /api/agents/heartbeats` reads all heartbeat blobs and returns them as a JSON array. It must be authenticated (session-gated like other app API routes).
3. The `useAgentHeartbeats` SWR hook is added to `lib/hooks.ts` to fetch from `/api/agents/heartbeats`.
4. The agents dashboard page (`app/(app)/agents/page.tsx`) displays last-run timestamp, status, and items processed per agent, sourced from the heartbeat API.
5. Health Monitor label is fixed: wherever "X/Y succeeded" appears in the UI, change it to "Y checked, X issues found" (or equivalent accurate phrasing).
6. Dispatcher shows its actual dispatched-items count sourced from its heartbeat record, not a hardcoded 0/0.
7. No existing agent logic is broken — heartbeat writes are appended after the existing run logic and failures in heartbeat write must not crash the cron (wrap in try/catch).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/agent-heartbeat-dashboard
```

### Step 1: Add heartbeat types to `lib/atc/types.ts`

Open `lib/atc/types.ts` and add the `AgentHeartbeat` interface. Find where other shared types are defined and append:

```typescript
export interface AgentHeartbeat {
  agentName: string;
  lastRunAt: string;       // ISO 8601 timestamp
  durationMs: number;
  status: 'ok' | 'error';
  itemsProcessed: number;
  notes?: string;
}
```

Also export a constant for the blob key pattern:
```typescript
export const HEARTBEAT_BLOB_PREFIX = 'af-data/agent-heartbeats';
```

### Step 2: Add heartbeat write helper to `lib/atc/utils.ts`

Open `lib/atc/utils.ts`. Import `AgentHeartbeat`, `HEARTBEAT_BLOB_PREFIX` from `./types` and the storage `put` function from `lib/storage`. Add a helper at the bottom:

```typescript
import { put } from '../storage';
import type { AgentHeartbeat } from './types';
import { HEARTBEAT_BLOB_PREFIX } from './types';

export async function writeAgentHeartbeat(heartbeat: AgentHeartbeat): Promise<void> {
  const key = `${HEARTBEAT_BLOB_PREFIX}/${heartbeat.agentName}/latest.json`;
  await put(key, JSON.stringify(heartbeat));
}
```

> Note: Check whether `lib/storage.ts` exposes `put` by that name or differently (it may be `saveBlob` or similar). Read the file first and use the correct export.

### Step 3: Instrument the Dispatcher agent

Open `app/api/agents/dispatcher/cron/route.ts`. Read its existing structure carefully.

At the start of the handler, record `const startedAt = Date.now()`.

After the main dispatch logic completes (just before returning the response), add a heartbeat write wrapped in try/catch. You'll need to capture how many items were dispatched — look for any existing counter variable (e.g., `dispatched`, `itemsDispatched`, or similar). If no counter exists, add one that increments whenever the dispatcher successfully dispatches a work item.

```typescript
import { writeAgentHeartbeat } from '@/lib/atc/utils';

// ...existing handler code...

// At the end, before return:
try {
  await writeAgentHeartbeat({
    agentName: 'dispatcher',
    lastRunAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: 'ok',
    itemsProcessed: itemsDispatched, // use actual counter name
    notes: `Dispatched ${itemsDispatched} items`,
  });
} catch (heartbeatErr) {
  console.error('[Dispatcher] Failed to write heartbeat:', heartbeatErr);
}
```

### Step 4: Instrument the Health Monitor agent

Open `app/api/agents/health-monitor/cron/route.ts`. Apply the same pattern:

1. Record `const startedAt = Date.now()` at the top of the handler.
2. Identify what counts the Health Monitor tracks (items checked, items recovered, etc.). Look for variables like `checked`, `recovered`, `stalled`, or similar.
3. After the main logic, write heartbeat:

```typescript
import { writeAgentHeartbeat } from '@/lib/atc/utils';

// At the end, before return:
try {
  await writeAgentHeartbeat({
    agentName: 'health-monitor',
    lastRunAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: 'ok',
    itemsProcessed: totalChecked, // use actual counter name
    notes: `Checked ${totalChecked} items, ${issuesFound} needed recovery`,
  });
} catch (heartbeatErr) {
  console.error('[HealthMonitor] Failed to write heartbeat:', heartbeatErr);
}
```

### Step 5: Instrument Supervisor and Project Manager (if their cron routes exist)

Check whether these routes exist:
- `app/api/agents/supervisor/cron/route.ts`
- `app/api/pm-agent/route.ts` (PM may not be a cron in the same pattern)

If a supervisor cron exists, apply the same heartbeat write pattern with `agentName: 'supervisor'`.

For PM agent, only instrument if there's a clear cron entrypoint. If the PM agent is triggered on-demand rather than cron, skip it or write with `agentName: 'pm-agent'` if there's a suitable endpoint.

### Step 6: Create the heartbeats API route

Create `app/api/agents/heartbeats/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { get, list } from '@/lib/storage'; // adjust imports to match storage.ts exports
import { HEARTBEAT_BLOB_PREFIX } from '@/lib/atc/types';
import type { AgentHeartbeat } from '@/lib/atc/types';

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // List all heartbeat blobs under the prefix
    const agentNames = ['dispatcher', 'health-monitor', 'supervisor', 'pm-agent'];
    const heartbeats: AgentHeartbeat[] = [];

    for (const agentName of agentNames) {
      const key = `${HEARTBEAT_BLOB_PREFIX}/${agentName}/latest.json`;
      try {
        const data = await get(key);
        if (data) {
          heartbeats.push(JSON.parse(data) as AgentHeartbeat);
        }
      } catch {
        // Agent has never run — return a placeholder
        heartbeats.push({
          agentName,
          lastRunAt: '',
          durationMs: 0,
          status: 'ok',
          itemsProcessed: 0,
          notes: 'Never run',
        });
      }
    }

    return NextResponse.json({ heartbeats });
  } catch (err) {
    console.error('[heartbeats API] Error:', err);
    return NextResponse.json({ error: 'Failed to load heartbeats' }, { status: 500 });
  }
}
```

> **Important:** Read `lib/storage.ts` first to confirm the correct function names and signatures for reading a blob by key. The functions may be named `getBlob`/`putBlob` or `get`/`put` — use whatever is exported.

### Step 7: Add SWR hook to `lib/hooks.ts`

Open `lib/hooks.ts`. Find the existing hook pattern (they likely use `useSWR`). Add:

```typescript
export function useAgentHeartbeats() {
  const { data, error, isLoading } = useSWR<{ heartbeats: AgentHeartbeat[] }>(
    '/api/agents/heartbeats',
    fetcher,
    { refreshInterval: 30_000 }
  );
  return {
    heartbeats: data?.heartbeats ?? [],
    isLoading,
    error,
  };
}
```

Import `AgentHeartbeat` from `@/lib/atc/types` at the top of the file.

### Step 8: Update the agents dashboard page

Open `app/(app)/agents/page.tsx`. Read its full current contents carefully before editing.

**8a. Import the new hook:**
```typescript
import { useAgentHeartbeats } from '@/lib/hooks';
```

**8b. Call the hook in the component:**
```typescript
const { heartbeats, isLoading: heartbeatsLoading } = useAgentHeartbeats();
```

**8c. Create a helper to look up a heartbeat by agent name:**
```typescript
const getHeartbeat = (name: string) =>
  heartbeats.find((h) => h.agentName === name);
```

**8d. Update the Health Monitor display.** Find wherever the UI renders something like "0/37 succeeded" or "X/Y succeeded" for the Health Monitor. Replace the label with:
```
{itemsProcessed} checked, {issuesFound} issues found
```
Since the heartbeat `notes` field contains `"Checked N items, M needed recovery"`, you can display it directly as the subtitle or parse `itemsProcessed` and extract issue count from `notes`.

Pattern to look for (search for `succeeded` or the fraction display):
```tsx
// Before (example):
<span>{agent.succeeded}/{agent.total} succeeded</span>

// After:
<span>{heartbeat?.notes ?? `${heartbeat?.itemsProcessed ?? 0} checked`}</span>
```

**8e. Update the last-run timestamp display.** Find where agent cards show last-run time. Replace static/empty values with:
```tsx
const hb = getHeartbeat('dispatcher'); // or 'health-monitor', etc.
// Display:
<span>{hb?.lastRunAt ? new Date(hb.lastRunAt).toLocaleString() : 'Never'}</span>
```

**8f. Update items processed display.** Replace hardcoded 0/0 with:
```tsx
<span>{hb?.itemsProcessed ?? 0} processed</span>
```

> The exact JSX structure depends on what's in `agents/page.tsx`. Read the file carefully and make targeted edits to the relevant sections rather than rewriting the whole page.

### Step 9: Verification

```bash
# Type check
npx tsc --noEmit

# Build check
npm run build

# Run any existing tests
npm test -- --passWithNoTests
```

Fix any TypeScript errors before proceeding. Common issues:
- Storage function names don't match (read `lib/storage.ts` and adjust)
- Import paths wrong (use `@/` prefix consistently)
- `AgentHeartbeat` not exported from the right place

### Step 10: Smoke-test the API locally (optional, if dev server works)

```bash
npm run dev &
# In another terminal:
curl http://localhost:3000/api/agents/heartbeats
# Expect: {"heartbeats": [...]} with "Never run" placeholders until agents run
```

### Step 11: Commit, push, open PR

```bash
git add -A
git commit -m "fix: write agent heartbeats to blob so dashboard shows live data

- Add AgentHeartbeat type and HEARTBEAT_BLOB_PREFIX to lib/atc/types.ts
- Add writeAgentHeartbeat() helper to lib/atc/utils.ts
- Instrument Dispatcher and Health Monitor cron routes with heartbeat writes
- Add GET /api/agents/heartbeats route to read latest heartbeat per agent
- Add useAgentHeartbeats SWR hook to lib/hooks.ts
- Update agents dashboard to display last-run timestamp, itemsProcessed from heartbeats
- Fix Health Monitor label: 'X checked, Y issues found' instead of '0/37 succeeded'"

git push origin fix/agent-heartbeat-dashboard

gh pr create \
  --title "fix: agent heartbeat dashboard shows live data (not 0/0 never run)" \
  --body "## Problem
The agent heartbeat dashboard showed '0/0 never run' for all agents (including the Dispatcher which runs every 5 min with 200 OK). Agents weren't writing any persistent state — they logged to Vercel function logs only.

Additionally, the Health Monitor showed '0/37 succeeded' which reads as alarming but means '37 checked, 0 needed recovery'.

## Solution
1. Added \`AgentHeartbeat\` type and \`writeAgentHeartbeat()\` helper
2. Instrumented Dispatcher and Health Monitor cron routes to write \`af-data/agent-heartbeats/{name}/latest.json\` after each run
3. New \`GET /api/agents/heartbeats\` route reads these blobs and returns all agent statuses
4. New \`useAgentHeartbeats\` SWR hook (30s refresh) feeds the dashboard
5. Dashboard updated to show real last-run timestamps and counts
6. Health Monitor label fixed to 'X checked, Y issues found'

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- After deploy, agents will write heartbeats on next cron tick and dashboard will update

## Files changed
- \`lib/atc/types.ts\` — AgentHeartbeat type + HEARTBEAT_BLOB_PREFIX
- \`lib/atc/utils.ts\` — writeAgentHeartbeat() helper
- \`app/api/agents/dispatcher/cron/route.ts\` — heartbeat write
- \`app/api/agents/health-monitor/cron/route.ts\` — heartbeat write
- \`app/api/agents/heartbeats/route.ts\` — new API route (NEW FILE)
- \`lib/hooks.ts\` — useAgentHeartbeats hook
- \`app/(app)/agents/page.tsx\` — dashboard UI updates"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/agent-heartbeat-dashboard
FILES CHANGED: [list what was actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "dashboard page not updated, only API and hooks done"]
```

## Notes for Executor

- **Read `lib/storage.ts` first** before writing any storage calls. The function names (`put`/`get` vs `putBlob`/`getBlob` vs something else) must match what's actually exported.
- **Read `app/(app)/agents/page.tsx` fully** before editing it — the current structure determines exactly where to inject heartbeat data. Don't rewrite the whole file.
- **Read the cron routes fully** before adding heartbeat writes — capture the existing counter/result variable names accurately rather than guessing.
- **Heartbeat write failures must not crash cron routes** — always wrap in `try/catch`.
- The concurrent work item (`fix/dashboard-qa-results-section-api-route`) touches `app/api/qa-results/route.ts` only — no conflict with any files in this handoff.