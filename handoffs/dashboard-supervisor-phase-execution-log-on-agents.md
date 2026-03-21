<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard: Supervisor Phase Execution Log on Agents Page

## Metadata
- **Branch:** `feat/supervisor-phase-log`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/(app)/agents/page.tsx`, `components/agent-dashboard.tsx`, `lib/atc/supervisor.ts`, `app/api/telemetry/route.ts`, `components/supervisor-phase-log.tsx`

## Context

PRD-53 Dashboard UI Alignment, AC-2. The Agents page currently shows agent cards with health metrics but lacks visibility into which Supervisor phases actually ran during the last cycle. After the phase decomposition refactor (March 18), the Supervisor coordinator stopped writing trace data to Blob storage, so there's no durable log to query.

This task:
1. **Restores Supervisor trace writing** to Blob storage in `lib/atc/supervisor.ts` (the coordinator), writing a structured phase execution log after each cycle completes.
2. **Adds a Supervisor Phase Log UI section** to the Agents page that reads and displays phase execution history: which phases ran, their tier (critical/standard/housekeeping), duration, success/failure, and any deferred phases.

### Existing patterns to follow

- **Supervisor phases** are defined in `lib/atc/supervisor-manifest.ts`. Each phase has a `tier` (critical/standard/housekeeping) and runs via `supervisor.ts`.
- **Telemetry API** at `app/api/telemetry/route.ts` accepts `action` query params and returns structured data. Agents page already polls this endpoint.
- **Blob storage** pattern: `lib/storage.ts` wraps Vercel Blob. Existing trace/state blobs live under `af-data/` prefix (e.g., `af-data/atc/`, `pm-agent/`).
- **Agent Dashboard component** at `components/agent-dashboard.tsx` renders agent cards. The Agents page at `app/(app)/agents/page.tsx` composes the dashboard and agent-trigger-button components.
- **SWR hooks** in `lib/hooks.ts` — new data fetching follows the same `useSWR` pattern.
- Dashboard uses Tailwind CSS + shadcn/ui components (Card, Badge, etc.).

### Key files to read before implementing
- `lib/atc/supervisor.ts` — find where the main cycle loop ends; that's where trace writing goes
- `lib/atc/supervisor-manifest.ts` — phase definitions, tier enum, PhaseResult types
- `app/api/telemetry/route.ts` — existing action handlers to add a new `supervisorPhaseLog` action
- `app/(app)/agents/page.tsx` — where to mount the new component
- `components/agent-dashboard.tsx` — existing UI patterns
- `lib/storage.ts` — `putBlob`, `getBlob` helpers

## Requirements

1. Define a `SupervisorPhaseTrace` type (in `lib/atc/supervisor.ts` or a shared types file) with fields: `cycleId`, `startedAt`, `completedAt`, `phases: PhaseExecution[]`, where `PhaseExecution` has `name`, `tier`, `durationMs`, `status: 'success'|'failure'|'skipped'|'deferred'`, `error?: string`.
2. At the end of each Supervisor coordinator cycle in `lib/atc/supervisor.ts`, write a `SupervisorPhaseTrace` blob to `af-data/supervisor/phase-trace-latest.json` (always overwrite) AND append to a rolling log `af-data/supervisor/phase-trace-history.json` capped at the last 10 cycles.
3. Add a `supervisorPhaseLog` action to `app/api/telemetry/route.ts` that reads `af-data/supervisor/phase-trace-latest.json` and `af-data/supervisor/phase-trace-history.json` from Blob and returns them (with graceful fallback if blobs don't exist yet).
4. Create `components/supervisor-phase-log.tsx` — a React component that:
   - Fetches `/api/telemetry?action=supervisorPhaseLog` via SWR (30s refresh)
   - Shows the most recent cycle's phases in a table/list: phase name, tier badge (color-coded: critical=red, standard=blue, housekeeping=gray), duration, status badge (success=green, failure=red, skipped=gray, deferred=yellow)
   - Shows a "Deferred phases" section if any phases were deferred
   - Shows cycle timestamp and total duration
   - Graceful empty state: "No supervisor trace data yet. Will populate after next cycle."
5. Mount `<SupervisorPhaseLog />` in `app/(app)/agents/page.tsx` below the existing agent cards, in a clearly labeled section "Supervisor Phase Log".
6. The telemetry endpoint must be authenticated (follow existing auth pattern in that route).
7. TypeScript must compile with no errors (`npx tsc --noEmit`).
8. `npm run build` must pass.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/supervisor-phase-log
```

### Step 1: Read existing files for context

Before writing any code, read these files to understand current structure:

```bash
cat lib/atc/supervisor.ts
cat lib/atc/supervisor-manifest.ts
cat app/api/telemetry/route.ts
cat app/(app)/agents/page.tsx
cat components/agent-dashboard.tsx
cat lib/hooks.ts
cat lib/storage.ts
```

Pay attention to:
- How `supervisor.ts` iterates phases and collects results (look for the cycle loop, `CycleContext`, phase result collection)
- The `tier` field on phase definitions in the manifest
- How existing telemetry actions are structured (the `action` switch/if-else pattern)
- Existing auth check pattern in telemetry route
- What Blob read/write helpers are available in `lib/storage.ts`

### Step 2: Define SupervisorPhaseTrace types

In `lib/atc/supervisor.ts` (or `lib/atc/types.ts` if that's where shared types live — check the file), add near the top:

```typescript
export interface PhaseExecution {
  name: string;
  tier: 'critical' | 'standard' | 'housekeeping';
  durationMs: number;
  status: 'success' | 'failure' | 'skipped' | 'deferred';
  error?: string;
}

export interface SupervisorPhaseTrace {
  cycleId: string;           // e.g., new Date().toISOString()
  startedAt: string;         // ISO timestamp
  completedAt: string;       // ISO timestamp
  totalDurationMs: number;
  phases: PhaseExecution[];
  deferredPhases: string[];  // names of phases that were deferred this cycle
}
```

If tier is already typed in the manifest, import and reuse that type rather than redefining.

### Step 3: Instrument supervisor.ts to write phase traces

In `lib/atc/supervisor.ts`, find the main cycle execution function (likely `runSupervisorCycle` or similar). 

**3a.** Record `cycleStartedAt = new Date()` at the start of the cycle.

**3b.** Wherever phases execute and results are collected, capture per-phase timing:
- Before each phase: `const phaseStart = Date.now()`
- After each phase: compute `durationMs = Date.now() - phaseStart`
- Collect into a `PhaseExecution[]` array, inferring `status` from whether the phase threw/returned an error vs succeeded, and whether it was skipped (concurrency limit, feature flag) or deferred.

**3c.** After the cycle completes (in the `finally` block or after the phase loop), write the trace:

```typescript
import { putBlob, getBlob } from '../storage'; // adjust import path

async function writeSupervisorTrace(trace: SupervisorPhaseTrace): Promise<void> {
  try {
    // Always overwrite latest
    await putBlob('af-data/supervisor/phase-trace-latest.json', JSON.stringify(trace));
    
    // Rolling history capped at 10
    let history: SupervisorPhaseTrace[] = [];
    try {
      const raw = await getBlob('af-data/supervisor/phase-trace-history.json');
      if (raw) history = JSON.parse(raw);
    } catch {
      // First run, no history yet
    }
    history.unshift(trace);
    if (history.length > 10) history = history.slice(0, 10);
    await putBlob('af-data/supervisor/phase-trace-history.json', JSON.stringify(history));
  } catch (err) {
    // Never let trace writing crash the supervisor
    console.error('[supervisor] Failed to write phase trace:', err);
  }
}
```

Call `writeSupervisorTrace(trace)` at the end of the cycle, wrapped in try/catch so it never disrupts the supervisor if Blob is unavailable.

> **Important:** Check the actual Blob API in `lib/storage.ts`. If the helpers are named differently (e.g., `blobPut`, `writeBlobJson`), use those exact names. Don't invent new storage functions — use what exists.

### Step 4: Add telemetry API action

In `app/api/telemetry/route.ts`, add a handler for `action=supervisorPhaseLog`:

```typescript
if (action === 'supervisorPhaseLog') {
  try {
    let latest = null;
    let history: unknown[] = [];
    
    try {
      const rawLatest = await getBlob('af-data/supervisor/phase-trace-latest.json');
      if (rawLatest) latest = JSON.parse(rawLatest);
    } catch {
      // Not yet written
    }
    
    try {
      const rawHistory = await getBlob('af-data/supervisor/phase-trace-history.json');
      if (rawHistory) history = JSON.parse(rawHistory);
    } catch {
      // Not yet written
    }
    
    return NextResponse.json({ latest, history });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch supervisor phase log' }, { status: 500 });
  }
}
```

Follow the exact auth pattern already in that route (check for session or Bearer token before processing).

### Step 5: Create SupervisorPhaseLog component

Create `components/supervisor-phase-log.tsx`:

```typescript
'use client';

import useSWR from 'swr';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SupervisorPhaseTrace, PhaseExecution } from '@/lib/atc/supervisor'; // adjust path

const fetcher = (url: string) => fetch(url).then(r => r.json());

const tierColors: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  standard: 'bg-blue-100 text-blue-800 border-blue-200',
  housekeeping: 'bg-gray-100 text-gray-700 border-gray-200',
};

const statusColors: Record<string, string> = {
  success: 'bg-green-100 text-green-800',
  failure: 'bg-red-100 text-red-800',
  skipped: 'bg-gray-100 text-gray-600',
  deferred: 'bg-yellow-100 text-yellow-800',
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SupervisorPhaseLog() {
  const { data, error, isLoading } = useSWR(
    '/api/telemetry?action=supervisorPhaseLog',
    fetcher,
    { refreshInterval: 30_000 }
  );

  const latest: SupervisorPhaseTrace | null = data?.latest ?? null;
  
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">Supervisor Phase Log</CardTitle>
        {latest && (
          <p className="text-xs text-muted-foreground mt-1">
            Last cycle: {new Date(latest.startedAt).toLocaleString()} · 
            Total: {formatDuration(latest.totalDurationMs)}
          </p>
        )}
      </CardHeader>
      <CardContent>
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {error && (
          <p className="text-sm text-red-600">Failed to load phase log.</p>
        )}
        {!isLoading && !error && !latest && (
          <p className="text-sm text-muted-foreground">
            No supervisor trace data yet. Will populate after next cycle.
          </p>
        )}
        {latest && (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b">
                    <th className="text-left py-1 pr-3 font-medium">Phase</th>
                    <th className="text-left py-1 pr-3 font-medium">Tier</th>
                    <th className="text-left py-1 pr-3 font-medium">Duration</th>
                    <th className="text-left py-1 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.phases.map((phase: PhaseExecution) => (
                    <tr key={phase.name} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-xs">{phase.name}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs border ${tierColors[phase.tier] ?? tierColors.housekeeping}`}>
                          {phase.tier}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                        {formatDuration(phase.durationMs)}
                      </td>
                      <td className="py-1.5">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs ${statusColors[phase.status] ?? ''}`}>
                          {phase.status}
                        </span>
                        {phase.error && (
                          <span className="ml-1 text-xs text-red-500 truncate max-w-32" title={phase.error}>
                            {phase.error.slice(0, 40)}{phase.error.length > 40 ? '…' : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {latest.deferredPhases.length > 0 && (
              <div className="mt-3 p-2 bg-yellow-50 rounded text-xs">
                <span className="font-medium text-yellow-800">Deferred: </span>
                <span className="text-yellow-700">{latest.deferredPhases.join(', ')}</span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

Adjust import paths based on actual project structure. If `@/components/ui/card` or `@/components/ui/badge` don't exist, use equivalent existing UI primitives from the codebase.

### Step 6: Mount component in Agents page

In `app/(app)/agents/page.tsx`, import and render the new component:

```typescript
import { SupervisorPhaseLog } from '@/components/supervisor-phase-log';
```

Add it below the existing agent cards section:

```tsx
{/* existing agent dashboard / cards */}
<AgentDashboard ... />

{/* Supervisor Phase Log */}
<div className="mt-6">
  <SupervisorPhaseLog />
</div>
```

Look at the actual page structure before inserting — find the natural end of the agent cards section and insert after it.

### Step 7: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build
```

Fix any TypeScript errors before proceeding. Common issues:
- Import path mismatches (check actual export names in `lib/storage.ts`)
- Type mismatches on `tier` if the manifest already defines a `Tier` enum — reuse it
- Missing `async` on functions that call Blob APIs
- `SupervisorPhaseTrace` / `PhaseExecution` not exported from their definition file

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: supervisor phase execution log on agents page (PRD-53 AC-2)"
git push origin feat/supervisor-phase-log
gh pr create \
  --title "feat: Supervisor phase execution log on Agents page (PRD-53 AC-2)" \
  --body "## Summary
Implements PRD-53 Dashboard UI Alignment AC-2.

### Changes
- **\`lib/atc/supervisor.ts\`**: Instruments the cycle loop to collect per-phase timing and status, writes \`SupervisorPhaseTrace\` to \`af-data/supervisor/phase-trace-latest.json\` (latest) and \`phase-trace-history.json\` (rolling 10-cycle history) after each cycle.
- **\`app/api/telemetry/route.ts\`**: Adds \`supervisorPhaseLog\` action that reads both Blob keys and returns \`{ latest, history }\`.
- **\`components/supervisor-phase-log.tsx\`**: New React component — polls telemetry every 30s, displays phase table with tier/status/duration badges, deferred phase list, graceful empty state.
- **\`app/(app)/agents/page.tsx\`**: Mounts \`<SupervisorPhaseLog />\` below agent cards.

### Why
After the March 18 phase decomposition refactor, the Supervisor stopped writing trace data to Blob, making it impossible to inspect phase execution without Vercel logs. This restores that observability.

### Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Empty state renders correctly before first cycle runs
- After a supervisor cron fires, phase log populates with tier/status/duration per phase
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/supervisor-phase-log
FILES CHANGED: [list what was modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "telemetry route done, component not yet mounted"]
```

## Notes for the Executing Agent

- **Read before writing**: The supervisor phase loop may already collect some result data — instrument what exists rather than adding a second parallel loop.
- **Never let trace writing crash the supervisor**: All Blob writes in the supervisor must be in try/catch. The supervisor is a critical cron; trace observability is secondary.
- **Storage API**: Check `lib/storage.ts` for exact function signatures before calling. Don't assume `putBlob`/`getBlob` — they may be `set`/`get` or have different signatures.
- **Tier type**: If `supervisor-manifest.ts` already defines `type Tier = 'critical' | 'standard' | 'housekeeping'`, import and reuse it — don't duplicate.
- **Auth in telemetry**: The telemetry route may already have a session check or API key check at the top — the new action must be inside that guard, not before it.
- **Component UI primitives**: If shadcn Badge/Card aren't present, replicate the visual style with plain Tailwind `div`s matching the existing dashboard aesthetic.