<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Agent Heartbeat Dashboard in Agents Tab

## Metadata
- **Branch:** `feat/agent-heartbeat-dashboard`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/api/agents/dashboard/route.ts`, `app/(app)/agents/page.tsx`, `lib/agent-dashboard.ts`, `lib/hooks.ts`

## Context

Agent Forge has 5 autonomous agents (Dispatcher, Health Monitor, Project Manager, Supervisor, Feedback Compiler) running on Vercel cron schedules. The control plane already has an Agents tab in the dashboard at `app/(app)/agents/page.tsx`. There is an existing agent traces API at `/api/agents/traces` and metrics at `/api/agents/atc-metrics/route.ts`. The event bus (`lib/event-bus.ts`) stores webhook events in Vercel Blob partitioned by hour.

The goal is a real-time health dashboard in the existing Agents tab that shows per-agent status, run history, key metrics, event bus stats, pipeline throughput, and active executions — auto-refreshing every 60 seconds.

No files overlap with the concurrent work item (`handoffs/bootstrap-rez-sniper-workflows.md`, `scripts/bootstrap-rez-sniper.sh`). Safe to proceed independently.

## Requirements

1. New API route `GET /api/agents/dashboard` that returns a JSON payload with:
   - Per-agent status (last run time, success/failure, health status: healthy/stale/error, last 10 run history)
   - Per-agent key metrics (agent-specific counts from traces/event log)
   - Event bus stats (events last hour, last 24h, breakdown by type)
   - Pipeline throughput (work items completed today and this week)
   - Active executions count and their branch names
2. Health thresholds based on each agent's known cadence:
   - Dispatcher: healthy if ran within 10 min (5-min cron), stale if 10–30 min, error if last run failed
   - Health Monitor: healthy if ran within 10 min (5-min cron)
   - Project Manager: healthy if ran within 30 min (15-min cron)
   - Supervisor: healthy if ran within 20 min (10-min cron)
   - Feedback Compiler: healthy if ran within 8 days (weekly cron)
3. Route is auth-protected (same session auth pattern as other API routes in this repo)
4. Frontend: add a `<AgentDashboard>` section to the existing agents page that renders the data
5. Auto-refreshes every 60 seconds using SWR or `setInterval`
6. Color coding: green (healthy), yellow (stale), red (error)
7. TypeScript — no `any` types, compiles cleanly

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/agent-heartbeat-dashboard
```

### Step 1: Understand existing patterns

Read these files before writing any code:

```bash
cat app/api/agents/atc-metrics/route.ts
cat app/api/agents/traces/route.ts   # may or may not exist — check
cat app/(app)/agents/page.tsx
cat lib/event-bus.ts
cat lib/event-bus-types.ts
cat lib/work-items.ts
cat lib/atc/events.ts
cat lib/hooks.ts
cat lib/auth.ts
```

Note the auth pattern used in other API routes (likely `auth()` from `lib/auth.ts` returning 401 if no session). Note the SWR hook pattern in `lib/hooks.ts`. Note the existing agent event structure in `lib/atc/events.ts`.

### Step 2: Create `lib/agent-dashboard.ts`

Create a pure data-fetching module with no React dependencies:

```typescript
// lib/agent-dashboard.ts

import { list, head, getDownloadUrl } from "@vercel/blob";
import { listWorkItems } from "./work-items";
import { queryEvents } from "./event-bus"; // use whatever the actual export is

export type AgentName =
  | "dispatcher"
  | "health-monitor"
  | "project-manager"
  | "supervisor"
  | "feedback-compiler";

export type AgentHealthStatus = "healthy" | "stale" | "error";

export interface AgentRunRecord {
  timestamp: string; // ISO
  success: boolean;
  durationMs?: number;
  summary?: string;
}

export interface AgentStatus {
  name: AgentName;
  displayName: string;
  cadenceMinutes: number;
  lastRun: AgentRunRecord | null;
  healthStatus: AgentHealthStatus;
  recentRuns: AgentRunRecord[]; // last 10, newest first
  metrics: Record<string, string | number>;
}

export interface EventBusStats {
  lastHourCount: number;
  last24hCount: number;
  byType: Record<string, number>;
}

export interface PipelineThroughput {
  completedToday: number;
  completedThisWeek: number;
}

export interface ActiveExecution {
  workItemId: string;
  title: string;
  branch: string;
  startedAt: string;
}

export interface AgentDashboardData {
  agents: AgentStatus[];
  eventBus: EventBusStats;
  pipeline: PipelineThroughput;
  activeExecutions: ActiveExecution[];
  generatedAt: string;
}

// Cadence thresholds in minutes (2x cadence = stale boundary)
const AGENT_CONFIG: Record<
  AgentName,
  { displayName: string; cadenceMinutes: number; staleThresholdMinutes: number }
> = {
  dispatcher: {
    displayName: "Dispatcher",
    cadenceMinutes: 5,
    staleThresholdMinutes: 10,
  },
  "health-monitor": {
    displayName: "Health Monitor",
    cadenceMinutes: 5,
    staleThresholdMinutes: 10,
  },
  "project-manager": {
    displayName: "Project Manager",
    cadenceMinutes: 15,
    staleThresholdMinutes: 30,
  },
  supervisor: {
    displayName: "Supervisor",
    cadenceMinutes: 10,
    staleThresholdMinutes: 20,
  },
  "feedback-compiler": {
    displayName: "Feedback Compiler",
    cadenceMinutes: 10080, // weekly
    staleThresholdMinutes: 11520, // 8 days
  },
};

function computeHealthStatus(
  lastRun: AgentRunRecord | null,
  staleThresholdMinutes: number
): AgentHealthStatus {
  if (!lastRun) return "stale";
  if (!lastRun.success) return "error";
  const ageMinutes =
    (Date.now() - new Date(lastRun.timestamp).getTime()) / 60000;
  if (ageMinutes > staleThresholdMinutes) return "stale";
  return "healthy";
}
```

> **Note:** The traces storage format needs to match what actually exists. In Step 3 you'll read the actual traces API/storage to fill in the implementation. The shape above is a target — adapt as needed.

### Step 3: Implement `lib/agent-dashboard.ts` fully

After reading existing code patterns, implement the full `fetchAgentDashboardData` function. The approach:

**Reading agent traces:**
- Check if there's a Vercel Blob prefix like `af-data/traces/` or `af-data/events/` that stores per-agent run records
- Check the existing `/api/agents/traces` route (if it exists) to see what it reads
- Fall back to reading from `lib/atc/events.ts` global event log, filtering by event type (e.g., `agent_cycle_complete`, `dispatcher_cycle_complete`, etc.)
- If traces don't exist in blob, read from the ATC events log filtering by agent-specific event types

**Concrete implementation pattern** (adapt based on what you find):

```typescript
export async function fetchAgentDashboardData(): Promise<AgentDashboardData> {
  const now = new Date();

  // 1. Read agent run history from atc events log
  // lib/atc/events.ts exports getGlobalEvents() or similar — check actual export
  const allEvents = await getGlobalEvents(); // returns EventLogEntry[]
  
  // 2. Build per-agent status
  const agents: AgentStatus[] = (
    Object.entries(AGENT_CONFIG) as [
      AgentName,
      (typeof AGENT_CONFIG)[AgentName]
    ][]
  ).map(([name, config]) => {
    // Filter events for this agent
    const agentEvents = allEvents
      .filter((e) => e.agentName === name || e.type?.includes(name.replace("-", "_")))
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

    const recentRuns: AgentRunRecord[] = agentEvents.slice(0, 10).map((e) => ({
      timestamp: e.timestamp,
      success: e.success ?? true,
      durationMs: e.durationMs,
      summary: e.summary,
    }));

    const lastRun = recentRuns[0] ?? null;
    const healthStatus = computeHealthStatus(lastRun, config.staleThresholdMinutes);

    // Agent-specific metrics
    const metrics = extractAgentMetrics(name, agentEvents);

    return {
      name,
      displayName: config.displayName,
      cadenceMinutes: config.cadenceMinutes,
      lastRun,
      healthStatus,
      recentRuns,
      metrics,
    };
  });

  // 3. Event bus stats
  const eventBus = await fetchEventBusStats(now);

  // 4. Pipeline throughput from work items
  const pipeline = await fetchPipelineThroughput(now);

  // 5. Active executions
  const activeExecutions = await fetchActiveExecutions();

  return {
    agents,
    eventBus,
    pipeline,
    activeExecutions,
    generatedAt: now.toISOString(),
  };
}

function extractAgentMetrics(
  name: AgentName,
  events: unknown[] // type based on actual event type
): Record<string, string | number> {
  // Return agent-specific metrics based on event data
  // Dispatcher: items dispatched, conflicts detected
  // Health Monitor: stuck items detected, rebases attempted
  // Project Manager: projects reviewed, decompositions triggered
  // Supervisor: escalations checked, agents monitored
  // Feedback Compiler: reports generated
  // Adapt based on actual event fields available
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayEvents = events.filter(
    (e: any) => new Date(e.timestamp) >= today
  );

  switch (name) {
    case "dispatcher":
      return {
        "Dispatched today": todayEvents.filter((e: any) => e.itemsDispatched > 0)
          .reduce((sum: number, e: any) => sum + (e.itemsDispatched ?? 0), 0),
        "Conflicts detected": todayEvents.reduce(
          (sum: number, e: any) => sum + (e.conflictsDetected ?? 0), 0
        ),
      };
    case "health-monitor":
      return {
        "Stalls detected": todayEvents.reduce(
          (sum: number, e: any) => sum + (e.stallsDetected ?? 0), 0
        ),
        "Rebases attempted": todayEvents.reduce(
          (sum: number, e: any) => sum + (e.rebasesAttempted ?? 0), 0
        ),
      };
    case "project-manager":
      return {
        "Projects reviewed": todayEvents.length,
        "Decompositions": todayEvents.filter((e: any) => e.decomposed).length,
      };
    case "supervisor":
      return {
        "Escalations checked": todayEvents.reduce(
          (sum: number, e: any) => sum + (e.escalationsChecked ?? 0), 0
        ),
      };
    case "feedback-compiler":
      return {
        "Reports generated": events.filter((e: any) => e.success).length,
      };
    default:
      return {};
  }
}

async function fetchEventBusStats(now: Date): Promise<EventBusStats> {
  // Query event bus for last hour and last 24h
  // Use lib/event-bus.ts queryEvents or read blob directly
  // Adapt to actual event bus API
  try {
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // Use whatever queryEvents function exists in lib/event-bus.ts
    const last24h = await queryEvents({ since: oneDayAgo.toISOString() });
    const lastHour = last24h.filter(
      (e) => new Date(e.timestamp) >= oneHourAgo
    );

    const byType: Record<string, number> = {};
    for (const event of last24h) {
      const type = event.type ?? "unknown";
      byType[type] = (byType[type] ?? 0) + 1;
    }

    return {
      lastHourCount: lastHour.length,
      last24hCount: last24h.length,
      byType,
    };
  } catch {
    return { lastHourCount: 0, last24hCount: 0, byType: {} };
  }
}

async function fetchPipelineThroughput(now: Date): Promise<PipelineThroughput> {
  try {
    const allItems = await listWorkItems();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const merged = allItems.filter((item) => item.status === "merged");
    const completedToday = merged.filter(
      (item) => item.mergedAt && new Date(item.mergedAt) >= startOfDay
    ).length;
    const completedThisWeek = merged.filter(
      (item) => item.mergedAt && new Date(item.mergedAt) >= startOfWeek
    ).length;

    return { completedToday, completedThisWeek };
  } catch {
    return { completedToday: 0, completedThisWeek: 0 };
  }
}

async function fetchActiveExecutions(): Promise<ActiveExecution[]> {
  try {
    const allItems = await listWorkItems();
    return allItems
      .filter((item) => item.status === "executing")
      .map((item) => ({
        workItemId: item.id,
        title: item.title,
        branch: item.branch ?? "unknown",
        startedAt: item.executingAt ?? item.updatedAt ?? new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}
```

> **Important:** The above is a template. You MUST read the actual types/exports in `lib/atc/events.ts`, `lib/event-bus.ts`, `lib/work-items.ts` before writing the real implementation. Match actual field names and function signatures. Use `// @ts-ignore` sparingly only if truly needed; prefer correct types.

### Step 4: Create `app/api/agents/dashboard/route.ts`

```typescript
// app/api/agents/dashboard/route.ts

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchAgentDashboardData } from "@/lib/agent-dashboard";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await fetchAgentDashboardData();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[agent-dashboard] Failed to fetch dashboard data:", error);
    return NextResponse.json(
      { error: "Failed to fetch dashboard data" },
      { status: 500 }
    );
  }
}
```

### Step 5: Add SWR hook to `lib/hooks.ts`

Open `lib/hooks.ts` and add a new hook at the end (do not modify existing hooks):

```typescript
// Add to lib/hooks.ts

export function useAgentDashboard() {
  const { data, error, isLoading, mutate } = useSWR<AgentDashboardData>(
    "/api/agents/dashboard",
    fetcher,
    { refreshInterval: 60000 } // 60s auto-refresh
  );

  return {
    dashboard: data,
    isLoading,
    isError: !!error,
    refresh: mutate,
  };
}
```

Import `AgentDashboardData` from `@/lib/agent-dashboard` at the top of `lib/hooks.ts`.

Check whether `lib/hooks.ts` already exports a `fetcher` function or uses a shared one — use the same pattern.

### Step 6: Build the frontend components

Create a new file `components/agent-dashboard.tsx`:

```tsx
// components/agent-dashboard.tsx
"use client";

import { useAgentDashboard } from "@/lib/hooks";
import type {
  AgentStatus,
  AgentHealthStatus,
  ActiveExecution,
  EventBusStats,
  PipelineThroughput,
} from "@/lib/agent-dashboard";

// ---- Color helpers ----

function statusColor(status: AgentHealthStatus): string {
  switch (status) {
    case "healthy":
      return "text-green-600 bg-green-50 border-green-200";
    case "stale":
      return "text-yellow-600 bg-yellow-50 border-yellow-200";
    case "error":
      return "text-red-600 bg-red-50 border-red-200";
  }
}

function statusDot(status: AgentHealthStatus): string {
  switch (status) {
    case "healthy":
      return "bg-green-500";
    case "stale":
      return "bg-yellow-400";
    case "error":
      return "bg-red-500";
  }
}

function statusLabel(status: AgentHealthStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "stale":
      return "Stale";
    case "error":
      return "Error";
  }
}

// ---- Sub-components ----

function RunDot({ success }: { success: boolean }) {
  return (
    <span
      className={`inline-block w-3 h-3 rounded-full ${
        success ? "bg-green-500" : "bg-red-500"
      }`}
      title={success ? "Success" : "Failed"}
    />
  );
}

function AgentCard({ agent }: { agent: AgentStatus }) {
  const colorClass = statusColor(agent.healthStatus);
  const dotClass = statusDot(agent.healthStatus);

  return (
    <div className={`rounded-lg border p-4 ${colorClass}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotClass}`} />
          <span className="font-semibold text-sm">{agent.displayName}</span>
        </div>
        <span className="text-xs font-medium uppercase tracking-wide">
          {statusLabel(agent.healthStatus)}
        </span>
      </div>

      <div className="text-xs mb-3 opacity-70">
        {agent.lastRun
          ? `Last run: ${new Date(agent.lastRun.timestamp).toLocaleTimeString()} — ${
              agent.lastRun.success ? "✓ Success" : "✗ Failed"
            }`
          : "No run recorded"}
      </div>

      {/* Run history dots */}
      <div className="flex gap-1 mb-3" title="Last 10 runs (newest left)">
        {agent.recentRuns.length > 0 ? (
          agent.recentRuns.map((run, i) => (
            <RunDot key={i} success={run.success} />
          ))
        ) : (
          <span className="text-xs opacity-50">No history</span>
        )}
        {agent.recentRuns.length === 0 && null}
      </div>

      {/* Metrics */}
      {Object.keys(agent.metrics).length > 0 && (
        <div className="border-t border-current/20 pt-2 mt-2 grid grid-cols-2 gap-1">
          {Object.entries(agent.metrics).map(([key, value]) => (
            <div key={key} className="text-xs">
              <span className="opacity-60">{key}: </span>
              <span className="font-medium">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventBusCard({ stats }: { stats: EventBusStats }) {
  const topTypes = Object.entries(stats.byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-sm mb-3 text-gray-700">Event Bus</h3>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-800">
            {stats.lastHourCount}
          </div>
          <div className="text-xs text-gray-500">Last hour</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-800">
            {stats.last24hCount}
          </div>
          <div className="text-xs text-gray-500">Last 24h</div>
        </div>
      </div>
      {topTypes.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs text-gray-500 mb-1">Top event types (24h)</div>
          {topTypes.map(([type, count]) => (
            <div key={type} className="flex justify-between text-xs">
              <span className="text-gray-600 truncate max-w-[160px]">{type}</span>
              <span className="font-medium text-gray-800">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PipelineCard({ pipeline }: { pipeline: PipelineThroughput }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <h3 className="font-semibold text-sm mb-3 text-gray-700">
        Pipeline Throughput
      </h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-800">
            {pipeline.completedToday}
          </div>
          <div className="text-xs text-gray-500">Merged today</div>
        </div>
        <div className="text-center">
          <div className="text-2xl font-bold text-gray-800">
            {pipeline.completedThisWeek}
          </div>
          <div className="text-xs text-gray-500">Merged this week</div>
        </div>
      </div>
    </div>
  );
}

function ActiveExecutionsCard({
  executions,
}: {
  executions: ActiveExecution[];
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-sm text-gray-700">
          Active Executions
        </h3>
        <span className="text-lg font-bold text-gray-800">
          {executions.length}
        </span>
      </div>
      {executions.length === 0 ? (
        <p className="text-xs text-gray-500">No active executions</p>
      ) : (
        <div className="space-y-2">
          {executions.map((exec) => (
            <div key={exec.workItemId} className="text-xs border-t pt-2 first:border-t-0 first:pt-0">
              <div className="font-medium text-gray-700 truncate">
                {exec.title}
              </div>
              <div className="text-gray-500 font-mono truncate">
                {exec.branch}
              </div>
              <div className="text-gray-400">
                Started {new Date(exec.startedAt).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main export ----

export function AgentDashboard() {
  const { dashboard, isLoading, isError, refresh } = useAgentDashboard();

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-gray-500">
        Loading agent dashboard...
      </div>
    );
  }

  if (isError || !dashboard) {
    return (
      <div className="py-8 text-center text-sm text-red-500">
        Failed to load agent dashboard.{" "}
        <button
          onClick={() => refresh()}
          className="underline hover:no-underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            Agent Health Dashboard
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Auto-refreshes every 60s · Last updated:{" "}
            {new Date(dashboard.generatedAt).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={() => refresh()}
          className="text-xs text-gray-500 hover:text-gray-800 border rounded px-2 py-1"
        >
          Refresh
        </button>
      </div>

      {/* Agent cards grid */}
      <div>
        <h3 className="text-sm font-medium text-gray-600 mb-3">
          Autonomous Agents
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {dashboard.agents.map((agent) => (
            <AgentCard key={agent.name} agent={agent} />
          ))}
        </div>
      </div>

      {/* Bottom row: event bus, pipeline, active executions */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <EventBusCard stats={dashboard.eventBus} />
        <PipelineCard pipeline={dashboard.pipeline} />
        <ActiveExecutionsCard executions={dashboard.activeExecutions} />
      </div>
    </div>
  );
}
```

### Step 7: Update the existing agents page

Open `app/(app)/agents/page.tsx`. Add the `<AgentDashboard>` component at the top of the page content (before any existing content), or in a clearly delineated section. Example pattern:

```tsx
// In app/(app)/agents/page.tsx — add import at top:
import { AgentDashboard } from "@/components/agent-dashboard";

// Then inside the JSX, before existing content:
<div className="mb-8">
  <AgentDashboard />
</div>
```

Do not remove any existing content from the agents page. Only add the new section.

### Step 8: Fix any TypeScript issues

```bash
npx tsc --noEmit
```

Common issues to fix:
- Missing fields on work item type — check `lib/types.ts` for actual field names (`mergedAt`, `executingAt`, `branch`, etc.)
- Mismatch between event log types and what's stored — check `lib/atc/events.ts` for the actual `EventLogEntry` type shape
- If `queryEvents` doesn't exist in `lib/event-bus.ts`, read blobs directly using the `list` + fetch pattern from that file
- If `listWorkItems` doesn't exist, use whatever the actual export is from `lib/work-items.ts`

### Step 9: Verification

```bash
npx tsc --noEmit
npm run build
```

If `npm run lint` exists:
```bash
npm run lint
```

Manually verify the route responds:
```bash
# (only works if you have local auth set up — otherwise skip)
curl http://localhost:3000/api/agents/dashboard
```

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add agent heartbeat dashboard to agents tab

- New /api/agents/dashboard route returning per-agent health, event bus stats, pipeline throughput, active executions
- lib/agent-dashboard.ts with health threshold logic (healthy/stale/error per cadence)
- components/agent-dashboard.tsx with color-coded cards and 10-run history dots
- SWR hook with 60s auto-refresh
- Integrated into existing agents page"

git push origin feat/agent-heartbeat-dashboard

gh pr create \
  --title "feat: agent heartbeat dashboard in Agents tab" \
  --body "## Summary

Adds a real-time agent health dashboard to the existing Agents tab.

## What's new

### API
- \`GET /api/agents/dashboard\` — returns per-agent status, event bus stats, pipeline throughput, active executions

### Data layer
- \`lib/agent-dashboard.ts\` — pure data module; reads agent event log, event bus, work item store
- Health thresholds: healthy/stale/error based on each agent's known cadence

### Frontend
- \`components/agent-dashboard.tsx\` — color-coded cards (green/yellow/red), last-10 run history dots, per-agent key metrics
- SWR hook with 60s auto-refresh
- Integrated into existing \`app/(app)/agents/page.tsx\`

## Agents covered
| Agent | Cadence | Stale after |
|-------|---------|------------|
| Dispatcher | 5 min | 10 min |
| Health Monitor | 5 min | 10 min |
| Project Manager | 15 min | 30 min |
| Supervisor | 10 min | 20 min |
| Feedback Compiler | weekly | 8 days |

## No overlap
Does not touch any files modified by the concurrent \`fix/bootstrap-rez-sniper-push-execute-handoffyml-via-g\` branch."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/agent-heartbeat-dashboard
FILES CHANGED: [list what was created/modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "lib/agent-dashboard.ts needs fetchEventBusStats implemented once event-bus.ts exports are confirmed"]
```

## Escalation Protocol

If you hit a blocker (e.g., agent event log doesn't exist and there's no trace storage, or event bus has no queryable API):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "agent-heartbeat-dashboard",
    "reason": "<describe the specific blocker, e.g. no agent run history is persisted anywhere>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<what you found vs what was expected>",
      "filesChanged": ["lib/agent-dashboard.ts", "app/api/agents/dashboard/route.ts"]
    }
  }'
```