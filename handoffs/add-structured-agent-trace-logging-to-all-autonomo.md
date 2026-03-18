<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Add Structured Agent Trace Logging to All Autonomous Agents

## Metadata
- **Branch:** `feat/agent-trace-logging`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/tracing.ts, lib/atc/dispatcher.ts, lib/atc/health-monitor.ts, lib/atc/project-manager.ts, lib/atc/supervisor.ts (or equivalent), app/api/agents/traces/route.ts

## Context

Agent Forge orchestrates autonomous agents (Dispatcher, Health Monitor, Project Manager, Supervisor) that each run on Vercel cron schedules. Currently there is no structured record of what decisions each agent made in a given run — making it very hard to debug "why did the pipeline do X?" questions.

The goal is to add lightweight structured JSON tracing to every agent run. Each trace captures timing, phases, decisions, and errors; is stored in Vercel Blob; and is queryable via a new API endpoint. The Supervisor agent should also be updated to read trace data so it can detect deteriorating agent health (e.g., increasing error rates).

**Key existing files to understand before implementing:**
- `lib/atc/dispatcher.ts` — Dispatcher agent. Look for the main exported function (likely `runDispatcher` or the default export called by the cron route).
- `lib/atc/health-monitor.ts` — Health Monitor agent.
- `lib/atc/project-manager.ts` — Project Manager agent.
- `lib/atc/types.ts` — Shared types (CycleContext, etc.). Do NOT introduce naming conflicts.
- `lib/storage.ts` — Vercel Blob CRUD helpers. Use these for persistence (do NOT call Vercel Blob SDK directly; use what's already abstracted here).
- `app/api/agents/dispatcher/cron/route.ts` — Dispatcher cron entry point.
- `app/api/agents/health-monitor/cron/route.ts` — Health Monitor cron entry point.
- `app/api/agents/supervisor/cron/route.ts` — Supervisor cron entry point.
- `app/api/agents/project-manager/cron/route.ts` — Project Manager cron entry point.

**Concurrent work to avoid:** `lib/event-bus.ts` is being modified by another branch (`fix/extend-event-bus-retention-from-7-days-to-30-days`). Do not touch that file.

**Vercel Blob path convention:** Existing data lives at `af-data/work-items/*`, `af-data/atc/*`, etc. Follow the same pattern — store traces at `af-data/agent-traces/{agent}/{ISO-timestamp}.json`.

## Requirements

1. Create `lib/atc/tracing.ts` with the following exported helpers:
   - `startTrace(agent: AgentName): AgentTrace` — initializes a trace object with `startedAt`, empty `phases`, `decisions`, `errors` arrays
   - `addPhase(trace: AgentTrace, phase: TracePhase): void` — pushes a phase (name + durationMs + optional metrics) onto `trace.phases`
   - `addDecision(trace: AgentTrace, decision: TraceDecision): void` — pushes a decision onto `trace.decisions`
   - `addError(trace: AgentTrace, error: string): void` — pushes to `trace.errors`
   - `completeTrace(trace: AgentTrace, status: 'success' | 'error'): void` — sets `completedAt`, `durationMs`, `status`, `summary`
   - `persistTrace(trace: AgentTrace): Promise<void>` — writes to Vercel Blob at `af-data/agent-traces/{agent}/{completedAt}.json`
   - `cleanupOldTraces(agent: AgentName, retentionDays?: number): Promise<void>` — lists blobs under `af-data/agent-traces/{agent}/`, deletes those older than `retentionDays` (default 30)
   - `listRecentTraces(agent?: AgentName, limit?: number): Promise<AgentTrace[]>` — lists and fetches recent traces for the query endpoint

2. Define TypeScript types for `AgentTrace`, `TracePhase`, `TraceDecision`, and `AgentName` (`'dispatcher' | 'health-monitor' | 'project-manager' | 'supervisor'`) in `lib/atc/tracing.ts`.

3. Instrument the **Dispatcher** agent (`lib/atc/dispatcher.ts`):
   - Call `startTrace('dispatcher')` at the top of the main run function
   - Wrap each logical phase (e.g., index reconciliation, conflict detection, dispatch) with timing and `addPhase`
   - Call `addDecision` for each work item dispatched, blocked, or skipped
   - Call `completeTrace` + `persistTrace` in a `finally` block
   - Call `cleanupOldTraces('dispatcher')` once per run (non-blocking — `await` but don't let it fail the agent)

4. Instrument the **Health Monitor** agent (`lib/atc/health-monitor.ts`) with the same pattern.

5. Instrument the **Project Manager** agent (`lib/atc/project-manager.ts`) with the same pattern, using agent name `'project-manager'`.

6. Instrument the **Supervisor** agent (find its implementation file — likely `lib/atc/supervisor.ts` or referenced from `app/api/agents/supervisor/cron/route.ts`) with the same pattern using agent name `'supervisor'`. Additionally, add a phase where the Supervisor reads recent traces from the other 3 agents and checks for elevated error rates (e.g., >50% of last 5 runs errored → log a warning decision).

7. Create `app/api/agents/traces/route.ts` — a GET endpoint that:
   - Requires auth (use the same auth pattern as other protected API routes in this codebase)
   - Accepts optional query params: `agent` (filter by agent name), `limit` (default 20, max 100)
   - Returns `{ traces: AgentTrace[], count: number }`
   - Uses `listRecentTraces` from `lib/atc/tracing.ts`

8. All tracing operations must be non-fatal: wrap `persistTrace` and `cleanupOldTraces` in try/catch inside agents so a tracing failure never crashes the agent.

9. No modifications to `lib/event-bus.ts`.

10. TypeScript must compile without errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/agent-trace-logging
```

### Step 1: Explore existing agent code

Before writing any code, read the agent files to understand:
- The shape of the main run function in each agent
- What "phases" already exist conceptually (e.g., index reconciliation, conflict detection, dispatch loop)
- How `lib/storage.ts` abstracts Vercel Blob (what functions are exported — likely `readBlob`, `writeBlob`, `listBlobs`, `deleteBlob` or similar)
- Auth pattern used in other `/api/agents/` routes

```bash
cat lib/atc/dispatcher.ts
cat lib/atc/health-monitor.ts
cat lib/atc/project-manager.ts
cat lib/atc/types.ts
cat lib/storage.ts
cat app/api/agents/dispatcher/cron/route.ts
cat app/api/agents/supervisor/cron/route.ts
cat app/api/agents/atc-metrics/route.ts  # for auth pattern reference
```

### Step 2: Create `lib/atc/tracing.ts`

Create the file with all types and helper functions. Use the storage abstraction from `lib/storage.ts` (do not import `@vercel/blob` directly unless storage.ts doesn't expose list/delete — in that case, import selectively from `@vercel/blob`).

Key implementation notes:
- The ISO timestamp used in blob paths should be URL-safe: use `new Date().toISOString().replace(/:/g, '-')` so colons don't cause issues in blob keys.
- `completeTrace` should generate `summary` as a human-readable string (agents can override this if they want a custom summary — accept an optional `summaryOverride` param).
- `listRecentTraces` should list blobs under `af-data/agent-traces/{agent}/` (or `af-data/agent-traces/` if no agent filter), sort descending by timestamp in blob name, fetch up to `limit` blobs, and parse each as `AgentTrace`. Handle fetch errors per-blob gracefully (skip and continue).
- `cleanupOldTraces` should compute the cutoff date, iterate listed blobs, parse the timestamp from the blob name, and delete if older than cutoff.

```typescript
// lib/atc/tracing.ts

export type AgentName = 'dispatcher' | 'health-monitor' | 'project-manager' | 'supervisor';

export interface TracePhase {
  name: string;
  durationMs: number;
  [key: string]: unknown; // allow arbitrary metrics like itemsTouched, itemsDispatched
}

export interface TraceDecision {
  workItemId?: string;
  action: string;
  reason: string;
  [key: string]: unknown;
}

export interface AgentTrace {
  agent: AgentName;
  startedAt: string;       // ISO timestamp
  completedAt?: string;    // ISO timestamp, set by completeTrace
  durationMs?: number;     // set by completeTrace
  status?: 'success' | 'error';
  phases: TracePhase[];
  decisions: TraceDecision[];
  errors: string[];
  summary?: string;
  _startMs: number;        // internal: Date.now() at start, for duration calc
}

export function startTrace(agent: AgentName): AgentTrace { ... }
export function addPhase(trace: AgentTrace, phase: TracePhase): void { ... }
export function addDecision(trace: AgentTrace, decision: TraceDecision): void { ... }
export function addError(trace: AgentTrace, error: string): void { ... }
export function completeTrace(trace: AgentTrace, status: 'success' | 'error', summaryOverride?: string): void { ... }
export async function persistTrace(trace: AgentTrace): Promise<void> { ... }
export async function cleanupOldTraces(agent: AgentName, retentionDays?: number): Promise<void> { ... }
export async function listRecentTraces(agent?: AgentName, limit?: number): Promise<AgentTrace[]> { ... }
```

Note: `_startMs` is used internally for duration calculation. Strip it or keep it — it's fine in the stored JSON as it's non-sensitive metadata.

### Step 3: Instrument the Dispatcher agent

Open `lib/atc/dispatcher.ts`. Find the main exported function. Add tracing around the existing logic:

```typescript
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from './tracing';

// At the start of the main function:
const trace = startTrace('dispatcher');
let phaseStart = Date.now();

try {
  // === Phase: index_reconciliation ===
  // [existing index reconciliation code]
  addPhase(trace, { name: 'index_reconciliation', durationMs: Date.now() - phaseStart, itemsTouched: N });
  phaseStart = Date.now();

  // === Phase: conflict_detection ===
  // [existing conflict detection code]
  addPhase(trace, { name: 'conflict_detection', durationMs: Date.now() - phaseStart });
  phaseStart = Date.now();

  // === Phase: dispatch ===
  // For each item dispatched/blocked, call addDecision
  addDecision(trace, { workItemId: item.id, action: 'dispatched', reason: '...' });
  addDecision(trace, { workItemId: item.id, action: 'blocked', reason: 'file overlap with ...' });
  addPhase(trace, { name: 'dispatch', durationMs: Date.now() - phaseStart, itemsDispatched: X, itemsBlocked: Y });

  completeTrace(trace, 'success', `Dispatched ${X} items, blocked ${Y}`);
} catch (err) {
  addError(trace, String(err));
  completeTrace(trace, 'error');
  throw err; // re-throw so the cron still fails loudly
} finally {
  try {
    await persistTrace(trace);
    await cleanupOldTraces('dispatcher');
  } catch (tracingErr) {
    console.error('[Dispatcher] Tracing failed (non-fatal):', tracingErr);
  }
}
```

Adapt this pattern to the actual structure of the dispatcher — don't restructure existing logic, just wrap it with timing calls.

### Step 4: Instrument the Health Monitor agent

Apply the same pattern to `lib/atc/health-monitor.ts`. Identify the logical phases from the existing code (e.g., stall detection, merge conflict recovery, failed PR reconciliation, dependency re-evaluation) and add `addPhase` calls for each. Add `addDecision` calls where the agent transitions a work item's state.

### Step 5: Instrument the Project Manager agent

Apply the same pattern to `lib/atc/project-manager.ts`. The Project Manager likely has phases like: backlog review, health assessment, decomposition, completion detection. Use agent name `'project-manager'`.

### Step 6: Instrument the Supervisor agent

First find where Supervisor logic lives:
```bash
cat app/api/agents/supervisor/cron/route.ts
# If it delegates to a lib file, find that file
grep -r "supervisor" lib/atc/ --include="*.ts" -l
```

Instrument it with the same pattern using agent name `'supervisor'`.

Additionally, add a health-check phase that reads recent traces from other agents:

```typescript
// === Phase: agent_health_check ===
phaseStart = Date.now();
const agentNames: AgentName[] = ['dispatcher', 'health-monitor', 'project-manager'];
for (const agentName of agentNames) {
  const recentTraces = await listRecentTraces(agentName, 5);
  const errorCount = recentTraces.filter(t => t.status === 'error').length;
  if (recentTraces.length >= 3 && errorCount / recentTraces.length > 0.5) {
    addDecision(trace, {
      action: 'agent_health_warning',
      reason: `Agent ${agentName} has ${errorCount}/${recentTraces.length} error rate in recent runs`,
    });
    console.warn(`[Supervisor] Agent ${agentName} elevated error rate: ${errorCount}/${recentTraces.length}`);
  }
}
addPhase(trace, { name: 'agent_health_check', durationMs: Date.now() - phaseStart });
```

### Step 7: Create the traces API endpoint

```bash
mkdir -p app/api/agents/traces
```

Create `app/api/agents/traces/route.ts`. Look at `app/api/agents/atc-metrics/route.ts` or another nearby route for the auth pattern (likely checks `getServerSession` from Auth.js or validates a Bearer token). Match that exactly.

```typescript
// app/api/agents/traces/route.ts
import { NextRequest, NextResponse } from 'next/server';
// [auth imports matching other agent API routes]
import { listRecentTraces, AgentName } from '@/lib/atc/tracing';

export async function GET(request: NextRequest) {
  // [auth check — match existing pattern]

  const { searchParams } = new URL(request.url);
  const agentParam = searchParams.get('agent') as AgentName | null;
  const limitParam = searchParams.get('limit');
  const limit = Math.min(parseInt(limitParam ?? '20', 10) || 20, 100);

  const traces = await listRecentTraces(agentParam ?? undefined, limit);
  return NextResponse.json({ traces, count: traces.length });
}
```

### Step 8: Verification

```bash
# Type check
npx tsc --noEmit

# Build check
npm run build

# Verify no import errors or missing exports
grep -r "from.*tracing" lib/atc/ app/api/agents/ --include="*.ts"
```

If `npx tsc --noEmit` reports errors, fix them before proceeding. Common issues:
- `_startMs` on `AgentTrace` might conflict with serialization — add `// eslint-disable-next-line` if linter complains, or use a Map/closure instead
- Storage helper function names might differ from assumed — adjust imports after reading `lib/storage.ts`
- Agent function signatures might require async changes if they weren't already async

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add structured agent trace logging to all autonomous agents

- Add lib/atc/tracing.ts with startTrace/addPhase/addDecision/completeTrace/persistTrace helpers
- Instrument Dispatcher, Health Monitor, Project Manager, Supervisor agents
- Supervisor reads peer agent traces to detect elevated error rates
- Add GET /api/agents/traces endpoint (optional agent filter, limit param)
- Traces stored at af-data/agent-traces/{agent}/{timestamp}.json, 30-day retention"

git push origin feat/agent-trace-logging

gh pr create \
  --title "feat: add structured agent trace logging to all autonomous agents" \
  --body "## Summary

Adds structured JSON trace logging to all 4 autonomous agents (Dispatcher, Health Monitor, Project Manager, Supervisor).

## What's new

### \`lib/atc/tracing.ts\` (new)
- \`startTrace\` / \`addPhase\` / \`addDecision\` / \`addError\` / \`completeTrace\` helpers
- \`persistTrace\`: writes to \`af-data/agent-traces/{agent}/{timestamp}.json\`
- \`cleanupOldTraces\`: 30-day retention, runs in each agent's own cron cycle
- \`listRecentTraces\`: used by the API endpoint and Supervisor health check

### Agent instrumentation
Each agent now calls \`startTrace\` at the top, wraps logical phases with timing, records per-item decisions, and calls \`completeTrace + persistTrace\` in a \`finally\` block. Tracing failures are non-fatal (caught and logged).

### Supervisor health check
The Supervisor now reads the last 5 traces from each peer agent and warns if >50% of recent runs errored.

### \`GET /api/agents/traces\` (new)
Returns recent traces. Optional query params: \`agent\` (filter), \`limit\` (default 20, max 100).

## Files changed
- \`lib/atc/tracing.ts\` (new)
- \`lib/atc/dispatcher.ts\` (instrumented)
- \`lib/atc/health-monitor.ts\` (instrumented)
- \`lib/atc/project-manager.ts\` (instrumented)
- \`lib/atc/supervisor.ts\` or equivalent (instrumented + peer health check)
- \`app/api/agents/traces/route.ts\` (new)

## Notes
- Does not touch \`lib/event-bus.ts\` (concurrent work on that file avoided)
- No behavioral changes to agent logic, only observability wrapping
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: partial agent trace logging implementation"
git push origin feat/agent-trace-logging
```
2. Open the PR with partial status:
```bash
gh pr create --title "feat: agent trace logging [PARTIAL]" --body "Partial implementation — see ISSUES below"
```
3. Output structured report:
```
STATUS: PR Open
PR: [URL]
BRANCH: feat/agent-trace-logging
FILES CHANGED: [list files actually modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [e.g., "instrument project-manager.ts", "fix TypeScript error in tracing.ts line 42"]
```

## Escalation Protocol

If you encounter a blocker that cannot be resolved autonomously (e.g., `lib/storage.ts` does not expose list/delete blob operations and direct Vercel Blob SDK usage is unclear, or the Supervisor agent logic is split across files in a way that makes instrumentation ambiguous):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "agent-trace-logging",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/tracing.ts", "<other files modified>"]
    }
  }'
```