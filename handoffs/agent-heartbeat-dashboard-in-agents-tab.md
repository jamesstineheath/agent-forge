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
- **Estimated files:** `app/api/agents/dashboard/route.ts`, `app/(app)/agents/page.tsx`, `lib/agent-dashboard.ts`, `lib/hooks.ts`, `components/agent-dashboard.tsx`

## Context

Agent Forge has 5 autonomous agents (Dispatcher, Health Monitor, Project Manager, Supervisor, Feedback Compiler) running on Vercel cron schedules. The control plane already has an Agents tab in the dashboard at `app/(app)/agents/page.tsx`. There is an existing agent traces API at `/api/agents/traces` and metrics at `/api/agents/atc-metrics/route.ts`. The event bus (`lib/event-bus.ts`) stores webhook events in Vercel Blob partitioned by hour.

The goal is a real-time health dashboard in the existing Agents tab that shows per-agent status, run history, key metrics, event bus stats, pipeline throughput, and active executions — auto-refreshing every 60 seconds.

No files overlap with the concurrent work items (`fix/bootstrap-rez-sniper-push-execute-handoffyml-via-g` or `feat/pa-auth-bypass-middleware-for-qa-agent-smoke-tests`). Safe to proceed independently.

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