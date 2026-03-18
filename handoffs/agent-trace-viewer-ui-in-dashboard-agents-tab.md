<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Agent Trace Viewer UI in Dashboard Agents Tab

## Metadata
- **Branch:** `feat/agent-trace-viewer-ui`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/(app)/agents/page.tsx`, `components/agent-trace-viewer.tsx`, `components/agent-trace-detail.tsx`, `lib/hooks.ts`, `app/api/agents/traces/route.ts`

## Context

Agent traces are being recorded and exposed at `/api/agents/traces` (shipped in PR #273). The existing Agents tab at `app/(app)/agents/page.tsx` was recently updated in PR #279 to show an agent heartbeat dashboard (component: `components/agent-dashboard.tsx`, data via `app/api/agents/dashboard/route.ts`, hook in `lib/hooks.ts`).

There is currently no visual inspector for agent traces in the dashboard. This work item adds a trace viewer below the existing heartbeat section, using the same patterns established by PR #279.

**No files conflict with concurrent work items:**
- `fix/bootstrap-rez-sniper-*` touches only `handoffs/` and ephemeral scripts
- `fix/daily-email-digest-*` touches `app/api/agents/digest/cron/route.ts`, `lib/digest.ts`, `vercel.json`

None overlap with the files changed here.

### Existing patterns to follow

From PR #279 and the codebase:
- SWR hooks live in `lib/hooks.ts` — add new `useAgentTraces` hook there
- Dashboard components live in `components/` — create `agent-trace-viewer.tsx`
- The Agents page (`app/(app)/agents/page.tsx`) imports and composes dashboard components
- Tailwind CSS v4 + shadcn/ui for styling — use existing `components/ui/` primitives
- Auto-refresh via SWR `refreshInterval` option (see existing hooks pattern)
- Responsive layout with `sm:` / `md:` breakpoints

### API contract for `/api/agents/traces`

Based on PR #273, each trace object has at minimum:
```typescript
interface AgentTrace {
  id: string;
  agentName: 'Dispatcher' | 'Health Monitor' | 'Project Manager' | 'Supervisor';
  startedAt: string;   // ISO 8601
  endedAt: string;     // ISO 8601
  durationMs: number;
  status: 'success' | 'error';
  phases: Array<{
    name: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
  }>;
  decisions: Array<{
    type: string;
    description: string;
    workItemId?: string;
    prNumber?: number;
    branch?: string;
    reason?: string;
  }>;
  errors: Array<{
    message: string;
    stack?: string;
    phase?: string;
  }>;
  itemsTouched?: Array<{
    type: 'work-item' | 'pr' | 'branch';
    id: string;
    label: string;
  }>;
  triggerEvents?: string[];
}

interface TracesResponse {
  traces: AgentTrace[];
}
```

If the actual `/api/agents/traces` route returns a different shape, adapt accordingly when you inspect the file.

## Requirements

1. A `useAgentTraces` SWR hook is added to `lib/hooks.ts` that fetches `/api/agents/traces`, returns the 50 most recent traces, and auto-refreshes every 30 seconds.
2. A `AgentTraceViewer` component (`components/agent-trace-viewer.tsx`) renders a sortable, filterable table of traces with columns: timestamp, agent name, duration, status, and decision/action count.
3. Clicking a trace row expands or navigates to a detail panel showing: timeline of phases with durations, decisions list, items touched, errors with stack traces, and triggering events.
4. The trace list is filterable by agent name (Dispatcher, Health Monitor, Project Manager, Supervisor) via a dropdown or tab row.
5. The trace list is sortable by timestamp (default: newest first).
6. Auto-refresh occurs every 30 seconds without a full page reload.
7. The component is integrated into `app/(app)/agents/page.tsx` below the existing heartbeat dashboard section.
8. Decision chain visualization: if a trace has decisions forming a CI remediation chain (failure detected → classified → retry triggered → outcome), render them in sequence with connecting arrows or a numbered step indicator.
9. Responsive layout consistent with the rest of the dashboard.
10. If `/api/agents/traces` returns an empty array or errors, show a graceful empty/error state.
11. The `/api/agents/traces` GET route must exist and be auth-protected. If it doesn't already exist or needs updating, create/update it to return `{ traces: AgentTrace[] }` limited to 50 most recent.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/agent-trace-viewer-ui
```

### Step 1: Inspect existing code

Examine these files to understand current patterns before writing any code:

```bash
# Understand the existing Agents page
cat app/(app)/agents/page.tsx

# Understand the heartbeat component (pattern to match)
cat components/agent-dashboard.tsx

# Understand existing hooks (SWR patterns, auto-refresh)
cat lib/hooks.ts

# Check the existing traces API route
cat app/api/agents/traces/route.ts 2>/dev/null || echo "FILE NOT FOUND"

# Check what shadcn/ui components are available
ls components/ui/

# Check Tailwind config
cat tailwind.config.ts 2>/dev/null || cat tailwind.config.js 2>/dev/null || echo "No tailwind config"
```

### Step 2: Ensure `/api/agents/traces` route exists and returns correct shape

Check whether `app/api/agents/traces/route.ts` already exists from PR #273. 

- If it **exists**: verify it returns `{ traces: AgentTrace[] }` and is auth-protected. Make minimal changes if the shape differs.
- If it **does not exist**: create it. The route should read trace data from Vercel Blob (under `af-data/traces/*` or similar) or fall back to returning an empty array. Pattern to follow:

```typescript
// app/api/agents/traces/route.ts
import { auth } from '@/lib/auth';
import { NextResponse } from 'next/server';
// import storage or blob client as needed

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Read traces from storage — adapt to actual storage pattern
    // e.g., list blobs under af-data/traces/, parse, sort by startedAt desc, limit 50
    const traces: AgentTrace[] = []; // populate from storage
    return NextResponse.json({ traces: traces.slice(0, 50) });
  } catch (error) {
    console.error('Failed to fetch traces:', error);
    return NextResponse.json({ traces: [] });
  }
}
```

> **Important**: look at how other agent API routes (e.g., `app/api/agents/dashboard/route.ts`) read from storage to match the exact pattern used in this codebase.

### Step 3: Add `useAgentTraces` hook to `lib/hooks.ts`

Add the following hook to the existing `lib/hooks.ts` file (do **not** replace the file — append or insert):

```typescript
// Add near the other agent hooks

export interface AgentTracePhase {
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface AgentTraceDecision {
  type: string;
  description: string;
  workItemId?: string;
  prNumber?: number;
  branch?: string;
  reason?: string;
}

export interface AgentTraceError {
  message: string;
  stack?: string;
  phase?: string;
}

export interface AgentTraceItemTouched {
  type: 'work-item' | 'pr' | 'branch';
  id: string;
  label: string;
}

export interface AgentTrace {
  id: string;
  agentName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: 'success' | 'error';
  phases: AgentTracePhase[];
  decisions: AgentTraceDecision[];
  errors: AgentTraceError[];
  itemsTouched?: AgentTraceItemTouched[];
  triggerEvents?: string[];
}

export function useAgentTraces() {
  const { data, error, isLoading, mutate } = useSWR<{ traces: AgentTrace[] }>(
    '/api/agents/traces',
    fetcher,
    { refreshInterval: 30_000 }
  );
  return {
    traces: data?.traces ?? [],
    isLoading,
    error,
    refresh: mutate,
  };
}
```

> Check what `fetcher` function and `useSWR` import pattern existing hooks use — match exactly. Do not introduce new imports if they already exist in the file.

### Step 4: Create `components/agent-trace-viewer.tsx`

Create a new file. This is the main component — a trace list with filter, sort, and inline detail expansion.

```typescript
'use client';

import { useState, useMemo } from 'react';
import { useAgentTraces, AgentTrace } from '@/lib/hooks';
import { AgentTraceDetail } from './agent-trace-detail';
// Import shadcn/ui components as available — check components/ui/ first
// Likely available: Badge, Button, Select, Table (or use plain Tailwind table)

const AGENT_NAMES = ['All', 'Dispatcher', 'Health Monitor', 'Project Manager', 'Supervisor'];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString();
}

export function AgentTraceViewer() {
  const { traces, isLoading, error } = useAgentTraces();
  const [filterAgent, setFilterAgent] = useState<string>('All');
  const [sortDesc, setSortDesc] = useState(true); // newest first by default
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = filterAgent === 'All'
      ? traces
      : traces.filter(t => t.agentName === filterAgent);
    result = [...result].sort((a, b) => {
      const diff = new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      return sortDesc ? -diff : diff;
    });
    return result.slice(0, 50);
  }, [traces, filterAgent, sortDesc]);

  const selectedTrace = useMemo(
    () => filtered.find(t => t.id === selectedTraceId) ?? null,
    [filtered, selectedTraceId]
  );

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load agent traces. Will retry automatically.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agent Traces</h2>
        <span className="text-xs text-muted-foreground">Auto-refreshes every 30s</span>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2">
        {AGENT_NAMES.map(name => (
          <button
            key={name}
            onClick={() => setFilterAgent(name)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filterAgent === name
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {name}
          </button>
        ))}
        <button
          onClick={() => setSortDesc(d => !d)}
          className="ml-auto rounded-full px-3 py-1 text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80"
        >
          {sortDesc ? '↓ Newest first' : '↑ Oldest first'}
        </button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading traces…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">
          No traces recorded yet{filterAgent !== 'All' ? ` for ${filterAgent}` : ''}.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-left text-xs font-medium text-muted-foreground">
                <th className="px-3 py-2">Timestamp</th>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Decisions</th>
                <th className="px-3 py-2">Phases</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(trace => (
                <>
                  <tr
                    key={trace.id}
                    onClick={() => setSelectedTraceId(
                      selectedTraceId === trace.id ? null : trace.id
                    )}
                    className={`cursor-pointer border-b transition-colors hover:bg-muted/30 ${
                      selectedTraceId === trace.id ? 'bg-muted/50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                      {formatTimestamp(trace.startedAt)}
                    </td>
                    <td className="px-3 py-2 font-medium">{trace.agentName}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDuration(trace.durationMs)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        trace.status === 'success'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {trace.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{trace.decisions.length}</td>
                    <td className="px-3 py-2 tabular-nums">{trace.phases.length}</td>
                  </tr>
                  {selectedTraceId === trace.id && selectedTrace && (
                    <tr key={`${trace.id}-detail`}>
                      <td colSpan={6} className="bg-muted/20 px-3 py-3">
                        <AgentTraceDetail trace={selectedTrace} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

> **Note on JSX fragments in table**: Some React versions need explicit `<React.Fragment key={...}>` instead of `<>` inside `.map()` when the fragment contains multiple `<tr>` elements. If you get a lint/compile error, replace `<>...</>` with `<React.Fragment key={trace.id}>...</React.Fragment>` and remove the duplicate `key` props from the child `<tr>` elements.

### Step 5: Create `components/agent-trace-detail.tsx`

```typescript
'use client';

import { AgentTrace } from '@/lib/hooks';

interface Props {
  trace: AgentTrace;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// Detect CI remediation decision chain
function isCIRemediationChain(decisions: AgentTrace['decisions']): boolean {
  const types = decisions.map(d => d.type.toLowerCase());
  return (
    types.some(t => t.includes('failure') || t.includes('ci')) &&
    types.some(t => t.includes('retry') || t.includes('rebase'))
  );
}

export function AgentTraceDetail({ trace }: Props) {
  const hasErrors = trace.errors.length > 0;
  const hasCIChain = isCIRemediationChain(trace.decisions);

  return (
    <div className="space-y-4 text-sm">

      {/* Phase timeline */}
      {trace.phases.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Phase Timeline
          </h3>
          <ol className="space-y-1">
            {trace.phases.map((phase, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center font-medium flex-shrink-0">
                  {i + 1}
                </span>
                <span className="flex-1 font-medium">{phase.name}</span>
                <span className="tabular-nums text-xs text-muted-foreground">
                  {formatDuration(phase.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Decisions */}
      {trace.decisions.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Decisions ({trace.decisions.length})
            {hasCIChain && (
              <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-normal text-blue-700 normal-case tracking-normal">
                CI Remediation Chain
              </span>
            )}
          </h3>
          {hasCIChain ? (
            // Decision chain visualization for CI remediation
            <ol className="relative space-y-2">
              {trace.decisions.map((decision, i) => (
                <li key={i} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs flex items-center justify-center font-bold flex-shrink-0">
                      {i + 1}
                    </span>
                    {i < trace.decisions.length - 1 && (
                      <div className="w-px flex-1 bg-blue-200 mt-1 min-h-[1rem]" />
                    )}
                  </div>
                  <div className="pb-2">
                    <span className="font-medium text-xs text-blue-800">{decision.type}</span>
                    <p className="text-muted-foreground mt-0.5">{decision.description}</p>
                    {decision.reason && (
                      <p className="text-xs text-muted-foreground italic mt-0.5">
                        Reason: {decision.reason}
                      </p>
                    )}
                    {decision.workItemId && (
                      <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                        work-item: {decision.workItemId}
                      </span>
                    )}
                    {decision.prNumber && (
                      <span className="mt-1 inline-block rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                        PR #{decision.prNumber}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            // Standard decision list
            <ul className="space-y-1">
              {trace.decisions.map((decision, i) => (
                <li key={i} className="rounded-md bg-muted/40 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-xs">{decision.type}</span>
                    {(decision.workItemId || decision.prNumber) && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono flex-shrink-0">
                        {decision.workItemId
                          ? `wi:${decision.workItemId}`
                          : `PR#${decision.prNumber}`}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">{decision.description}</p>
                  {decision.reason && (
                    <p className="mt-0.5 text-xs text-muted-foreground italic">
                      Reason: {decision.reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Items touched */}
      {trace.itemsTouched && trace.itemsTouched.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Items Touched
          </h3>
          <div className="flex flex-wrap gap-2">
            {trace.itemsTouched.map((item, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs"
              >
                <span className="text-muted-foreground">{item.type}</span>
                <span className="font-medium">{item.label}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Trigger events */}
      {trace.triggerEvents && trace.triggerEvents.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Trigger Events
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {trace.triggerEvents.map((evt, i) => (
              <span key={i} className="rounded bg-muted px-2 py-0.5 text-xs font-mono">
                {evt}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Errors */}
      {hasErrors && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-600">
            Errors ({trace.errors.length})
          </h3>
          <div className="space-y-2">
            {trace.errors.map((err, i) => (
              <div key={i} className="rounded-md border border-red-200 bg-red-50 p-3">
                {err.phase && (
                  <p className="mb-1 text-xs font-medium text-red-500">Phase: {err.phase}</p>
                )}
                <p className="font-medium text-red-700">{err.message}</p>
                {err.stack && (
                  <pre className="mt-2 overflow-x-auto rounded bg-red-100 p-2 text-xs text-red-800 whitespace-pre-wrap break-all">
                    {err.stack}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Empty state for a healthy, minimal trace */}
      {trace.decisions.length === 0 && trace.phases.length === 0 && !hasErrors && (
        <p className="text-xs text-muted-foreground italic">No detailed trace data recorded for this run.</p>
      )}
    </div>
  );
}
```

### Step 6: Integrate into the Agents tab page

Edit `app/(app)/agents/page.tsx` to import and render `AgentTraceViewer` below the existing heartbeat section. The exact location depends on the current structure of the file — place the trace viewer in a new section with appropriate heading and spacing.

Add the import at the top:
```typescript
import { AgentTraceViewer } from '@/components/agent-trace-viewer';
```

Add the component below the heartbeat section (look for the existing `AgentDashboard` component or equivalent):
```tsx
{/* Agent Traces */}
<section className="mt-8">
  <AgentTraceViewer />
</section>
```

If the page uses a different layout pattern (e.g., cards, containers), match that pattern exactly rather than inserting a raw `<section>`.

### Step 7: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build

# Lint check (if configured)
npm run lint 2>/dev/null || true

# Run tests if any exist
npm test 2>/dev/null || true
```

If TypeScript errors appear:
- If the `AgentTrace` interface in `lib/hooks.ts` conflicts with an existing type, rename the exported interface to `AgentTraceRecord` and update all references.
- If `useSWR` or `fetcher` don't match the existing hook pattern in `lib/hooks.ts`, adapt to match exactly (some codebases use a custom `fetcher`, others use `fetch().then(r => r.json())`).
- If React JSX key errors appear in the table rows with inline detail, use explicit `React.Fragment` with keys.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add agent trace viewer UI to dashboard Agents tab"
git push origin feat/agent-trace-viewer-ui
gh pr create \
  --title "feat: agent trace viewer UI in dashboard Agents tab" \
  --body "## Summary

Adds a trace viewer UI to the Agents tab dashboard, below the existing agent heartbeat section (PR #279).

## Changes

- \`lib/hooks.ts\` — Added \`useAgentTraces\` hook with 30s auto-refresh via SWR
- \`components/agent-trace-viewer.tsx\` — Trace list table with agent filter, timestamp sort, and inline row expansion
- \`components/agent-trace-detail.tsx\` — Detail panel showing phase timeline, decisions, items touched, errors, trigger events, and CI remediation chain visualization
- \`app/(app)/agents/page.tsx\` — Integrated \`AgentTraceViewer\` below heartbeat section
- \`app/api/agents/traces/route.ts\` — Created/updated route to return \`{ traces: AgentTrace[] }\` (top 50, auth-protected)

## Acceptance Criteria

- [x] Trace list shows up to 50 most recent traces across all agents
- [x] Filterable by agent name (Dispatcher, Health Monitor, Project Manager, Supervisor)
- [x] Clicking a trace row expands inline detail with timeline, decisions, and errors
- [x] Auto-refreshes every 30 seconds without page reload (SWR refreshInterval)
- [x] CI remediation decision chains rendered with step connector visualization
- [x] Responsive layout using Tailwind breakpoints consistent with existing dashboard
- [x] Empty and error states handled gracefully

Closes #[issue number if any]"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
   ```bash
   git add -A
   git commit -m "feat: agent trace viewer UI (partial)"
   git push origin feat/agent-trace-viewer-ui
   ```
2. Open the PR with partial status:
   ```bash
   gh pr create --title "feat: agent trace viewer UI (partial)" --body "Partial implementation — see ISSUES below"
   ```
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/agent-trace-viewer-ui
FILES CHANGED: [list modified files]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [e.g., "AgentTraceDetail component not yet created", "API route shape differs from expected — needs adapter"]
```

## Escalation Protocol

If you hit a blocker that cannot be resolved autonomously (e.g., `/api/agents/traces` doesn't exist and the storage pattern is unclear, or the `AgentTrace` type from PR #273 is fundamentally different from what's expected here):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "agent-trace-viewer-ui",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/hooks.ts", "components/agent-trace-viewer.tsx", "components/agent-trace-detail.tsx", "app/(app)/agents/page.tsx", "app/api/agents/traces/route.ts"]
    }
  }'
```