<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Implement Agent Trace Persistence in ATC Cron Cycle

## Metadata
- **Branch:** `feat/atc-trace-persistence`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc.ts, app/api/atc/cron/route.ts

## Context

Agent traces in `af-data/agent-traces/` are stale (last written March 18). The ATC monolith (`lib/atc.ts`) executes every 5 minutes via cron but never writes trace files after its cycle. The `pipeline_health` MCP tool reads from `af-data/agent-traces/{agent-name}/` to report agent activity, so it currently returns stale data.

Per CLAUDE.md, `lib/atc.ts` is **deprecated** (ADR-010) and its cron route (`/api/atc/cron`) has been **disabled** (removed from cron). The four autonomous agents that replaced it are in `lib/atc/dispatcher.ts`, `lib/atc/health-monitor.ts`, `lib/pm-agent.ts`, and `lib/atc/supervisor.ts` — these run on their own cron routes.

**Important architectural note:** Since the ATC monolith cron is disabled, trace persistence must be added to the **four active autonomous agents** instead. Each agent should write its own trace after completing a cycle. The `pipeline_health` tool already reads from `af-data/agent-traces/{agent-name}/` — we just need the write side in each active agent.

The trace format should be a JSON file at:
```
af-data/agent-traces/{agent-name}/{ISO-timestamp}.json
```

Each trace should include: cycle timestamp, agent name, actions taken, duration, errors encountered, and relevant state metrics.

A shared utility function should handle: (1) writing the trace to Blob, (2) pruning traces older than 7 days for that agent.

## Requirements

1. Create a shared trace utility at `lib/atc/trace.ts` that exports:
   - `writeAgentTrace(agentName: string, trace: AgentTrace): Promise<void>` — writes trace to Blob and prunes old traces
   - `AgentTrace` type with fields: `timestamp`, `agentName`, `durationMs`, `actionsCount`, `actions`, `errors`, `metadata`
2. Prune traces older than 7 days during each `writeAgentTrace` call — list blobs at the agent's prefix and delete those with timestamps older than 7 days
3. Add trace writes to the Dispatcher agent (`lib/atc/dispatcher.ts`) after each cycle completes
4. Add trace writes to the Health Monitor agent (`lib/atc/health-monitor.ts`) after each cycle completes
5. Add trace writes to the Supervisor agent (`lib/atc/supervisor.ts`) after each cycle completes
6. Add trace writes to the PM Agent (`lib/pm-agent.ts` or its cron route) after each cycle completes
7. Traces must not throw / break agent cycles — all trace writes are fire-and-forget with caught errors
8. The `actions` array in each trace should capture meaningful per-agent activity: dispatched item IDs, status transitions, stalls detected, escalations handled, etc.
9. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-trace-persistence
```

### Step 1: Understand existing trace read patterns

Before writing any code, read the existing files to understand:
- How `pipeline_health` reads traces (find it in the codebase — likely `lib/mcp/tools/pm.ts` or similar)
- The exact Blob path format expected
- Any existing `AgentTrace` types already defined

```bash
grep -r "agent-traces" --include="*.ts" -l
grep -r "AgentTrace" --include="*.ts" -l
grep -r "agent-traces" --include="*.ts" -n
```

Also review the four active agents to understand their return types and where a good "cycle complete" hook point is:
```bash
# Check cron route patterns
cat app/api/agents/dispatcher/cron/route.ts
cat app/api/agents/health-monitor/cron/route.ts
cat app/api/agents/supervisor/cron/route.ts
cat app/api/pm-agent/route.ts
```

### Step 2: Create `lib/atc/trace.ts`

Create the shared trace utility. Match whatever type structure `pipeline_health` already expects — if there's an existing type, use it. Otherwise create one that is compatible with the read side.

```typescript
// lib/atc/trace.ts
import { put, list, del } from "@vercel/blob";

const TRACE_PREFIX = "af-data/agent-traces";
const TRACE_RETENTION_DAYS = 7;

export interface AgentTraceAction {
  type: string;
  detail: string;
  itemId?: string;
}

export interface AgentTrace {
  timestamp: string;         // ISO-8601
  agentName: string;
  durationMs: number;
  actionsCount: number;
  actions: AgentTraceAction[];
  errors: string[];
  metadata?: Record<string, unknown>;
}

export async function writeAgentTrace(
  agentName: string,
  trace: AgentTrace
): Promise<void> {
  try {
    const timestamp = trace.timestamp.replace(/[:.]/g, "-");
    const path = `${TRACE_PREFIX}/${agentName}/${timestamp}.json`;

    await put(path, JSON.stringify(trace, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });

    // Prune old traces for this agent
    await pruneOldTraces(agentName);
  } catch (err) {
    // Never break agent cycle due to trace write failure
    console.error(`[trace] Failed to write trace for ${agentName}:`, err);
  }
}

async function pruneOldTraces(agentName: string): Promise<void> {
  try {
    const prefix = `${TRACE_PREFIX}/${agentName}/`;
    const cutoff = Date.now() - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const { blobs } = await list({ prefix });

    const toDelete = blobs.filter((blob) => {
      const uploadedAt = new Date(blob.uploadedAt).getTime();
      return uploadedAt < cutoff;
    });

    await Promise.all(toDelete.map((blob) => del(blob.url)));

    if (toDelete.length > 0) {
      console.log(`[trace] Pruned ${toDelete.length} old traces for ${agentName}`);
    }
  } catch (err) {
    console.error(`[trace] Failed to prune traces for ${agentName}:`, err);
  }
}
```

**Important:** Check how `@vercel/blob`'s `list` function works in the existing codebase — look at `lib/storage.ts` to see which Blob APIs are already used and match the pattern. Use `addRandomSuffix: false` only if the Blob SDK version supports it; otherwise adapt.

### Step 3: Add trace to Dispatcher cron

Read `lib/atc/dispatcher.ts` to understand its return shape. The dispatcher cron likely returns an object describing what was dispatched. Add timing and trace write at the cron route level (or end of the dispatcher function, whichever is cleaner).

In `app/api/agents/dispatcher/cron/route.ts` (or `lib/atc/dispatcher.ts`), wrap the cycle:

```typescript
import { writeAgentTrace } from "@/lib/atc/trace";

// At the start of the cycle:
const cycleStart = Date.now();

// ... existing dispatcher logic ...

// After the cycle, before returning:
const actions: AgentTraceAction[] = [];
// Populate from dispatcher result — e.g., dispatched items, conflicts detected, etc.
// Example: result.dispatched?.forEach(id => actions.push({ type: "dispatched", detail: id, itemId: id }))

await writeAgentTrace("dispatcher", {
  timestamp: new Date().toISOString(),
  agentName: "dispatcher",
  durationMs: Date.now() - cycleStart,
  actionsCount: actions.length,
  actions,
  errors: result.errors ?? [],
  metadata: {
    itemsDispatched: result.dispatched?.length ?? 0,
    conflictsDetected: result.conflicts?.length ?? 0,
  },
});
```

Adapt field names to match the actual dispatcher return type — read the source first.

### Step 4: Add trace to Health Monitor cron

Same pattern for `lib/atc/health-monitor.ts` or its cron route. The health monitor detects stalls, recoveries, and reconciliations — capture those as actions.

```typescript
// Example actions for health monitor:
// { type: "stall_detected", detail: `item ${id} stalled in ${stage}`, itemId: id }
// { type: "status_transition", detail: `${id}: executing -> failed`, itemId: id }
// { type: "merge_conflict_detected", detail: `PR #${prNumber} has conflicts`, itemId: id }
// { type: "reconciled", detail: `item ${id} actually merged`, itemId: id }

await writeAgentTrace("health-monitor", {
  timestamp: new Date().toISOString(),
  agentName: "health-monitor",
  durationMs: Date.now() - cycleStart,
  actionsCount: actions.length,
  actions,
  errors: result.errors ?? [],
  metadata: {
    stallsDetected: result.stalls?.length ?? 0,
    transitionsApplied: result.transitions?.length ?? 0,
  },
});
```

### Step 5: Add trace to Supervisor cron

Same pattern for `lib/atc/supervisor.ts`. The supervisor manages agent health, escalations, branch cleanup. Read its return type and capture meaningful actions.

```typescript
await writeAgentTrace("supervisor", {
  timestamp: new Date().toISOString(),
  agentName: "supervisor",
  durationMs: Date.now() - cycleStart,
  actionsCount: actions.length,
  actions,
  errors: [],
  metadata: {
    escalationsChecked: result.escalations ?? 0,
    branchesCleaned: result.branchesCleaned ?? 0,
  },
});
```

### Step 6: Add trace to PM Agent

The PM Agent runs at `app/api/pm-agent/route.ts`. It's Claude-powered (multi-action), so it may run on-demand rather than strictly on a cron schedule, but still benefits from traces. Wrap the handler similarly.

```typescript
await writeAgentTrace("pm-agent", {
  timestamp: new Date().toISOString(),
  agentName: "pm-agent",
  durationMs: Date.now() - cycleStart,
  actionsCount: actions.length,
  actions,
  errors: [],
  metadata: {
    action: requestBody.action,  // e.g., "backlog_review", "decompose", etc.
  },
});
```

### Step 7: Verify trace path matches pipeline_health expectations

After implementing, re-read the `pipeline_health` tool to confirm the Blob path format and JSON field names match what was just written. If there's a mismatch, fix `lib/atc/trace.ts` to match the expected format — the read side is the source of truth.

```bash
grep -r "agent-traces" --include="*.ts" -n
grep -r "pipeline_health" --include="*.ts" -n
```

### Step 8: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors. Common issues:
- `put` options: check if `addRandomSuffix` is supported in the installed version of `@vercel/blob`
- `list` return shape: check if it returns `{ blobs }` or `{ blobs, cursor }` etc.
- Existing `AgentTrace` type conflicts: if one exists already, use it instead of defining a new one

```bash
# Check @vercel/blob version and API
cat node_modules/@vercel/blob/dist/index.d.ts | grep -A5 "export function put"
cat node_modules/@vercel/blob/dist/index.d.ts | grep -A5 "export function list"
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add agent trace persistence to autonomous agent cron cycles

- Add lib/atc/trace.ts with writeAgentTrace() and 7-day pruning
- Write traces after each Dispatcher, Health Monitor, Supervisor, PM Agent cycle
- Traces written to af-data/agent-traces/{agent-name}/{timestamp}.json
- pipeline_health tool now receives fresh trace data on every cron tick
- Trace writes are fire-and-forget; never break agent cycle on failure"
git push origin feat/atc-trace-persistence
gh pr create \
  --title "feat: implement agent trace persistence in autonomous agent crons" \
  --body "## Summary
Adds trace persistence to the four active autonomous agents so that the \`pipeline_health\` tool receives fresh observability data on every cron cycle.

## Changes
- **\`lib/atc/trace.ts\`** (new): Shared \`writeAgentTrace()\` utility — writes JSON trace to \`af-data/agent-traces/{agent-name}/{timestamp}.json\` and prunes traces older than 7 days
- **Dispatcher cron**: Records dispatched items, conflicts detected, duration
- **Health Monitor cron**: Records stalls, status transitions, merge conflict detections, reconciliations
- **Supervisor cron**: Records escalations checked, branches cleaned
- **PM Agent route**: Records action type and outcomes

## Why
Agent traces were stale (last written March 18). \`pipeline_health\` was reading stale blobs. This wires up the write side without changing the read side.

## Risk
Low. Trace writes are wrapped in try/catch and are fire-and-forget — agent cycles cannot be broken by trace failures. No existing behavior is modified.

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-trace-persistence
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you hit a blocker (e.g., the `pipeline_health` tool expects a completely different trace schema than what can be inferred, or `@vercel/blob` API is incompatible with the approach), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "atc-trace-persistence",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/trace.ts"]
    }
  }'
```