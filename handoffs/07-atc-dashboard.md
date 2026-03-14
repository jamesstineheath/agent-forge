# Agent Forge -- ATC Dashboard Enhancement

## Metadata
- **Branch:** `feat/atc-dashboard`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** low
- **Estimated files:** app/api/atc/route.ts, app/api/atc/events/route.ts, lib/hooks.ts, app/(app)/pipeline/page.tsx, app/(app)/page.tsx, components/atc-event-log.tsx, components/concurrency-gauge.tsx
- **Dependencies:** Requires 05-queue-management and 06-conflict-detection to be merged first (dashboard displays ATC events from those features).

## Context

The pipeline page (`app/(app)/pipeline/page.tsx`) currently fetches from `/api/orchestrator/status` and shows active/completed work items. It has no visibility into ATC state: no event timeline, no queue view, no concurrency gauges, no conflict/retry events.

The ATC already persists rich state (lib/atc.ts):
- `ATCState` with activeExecutions, queuedItems, recentEvents (saved to `atc/state` Blob key)
- Rolling event log (saved to `atc/events` Blob key, up to 200 events)
- Event types: status_change, timeout, concurrency_block, auto_dispatch, conflict, retry, parked, error

The dashboard page also uses `usePipelineStatus()` hook which polls `/api/orchestrator/status` every 10s. This endpoint returns work items in active statuses but not ATC-specific data.

What needs to happen:
1. Expose ATC state + events via an API endpoint (the existing `app/api/atc/route.ts` is GET-able but only returns basic state)
2. Add SWR hooks for ATC data
3. Rebuild the pipeline page to show: ATC event timeline, active executions with file info, queue with priority ordering, per-repo concurrency gauges
4. Update the dashboard home page to show ATC health (last run time, events since last check)

Existing component patterns: Cards from shadcn/ui, Badge for status colors, SWR for data fetching. The app uses Tailwind CSS v4 with shadcn/ui components in `components/ui/`.

## Requirements

1. `GET /api/atc` returns the full ATCState plus recent events from the event log.
2. `GET /api/atc/events?limit=50` returns the event log with configurable limit (max 200).
3. New SWR hook: `useATCState()` polling `/api/atc` every 10s.
4. New SWR hook: `useATCEvents(limit)` polling `/api/atc/events?limit={limit}` every 30s.
5. Pipeline page rebuilt with three sections:
   a. **Active Executions** (existing, enhanced): Show each execution with status badge, elapsed time, PR link, repo name, and files being modified (collapsible, if available in ATCState).
   b. **Event Timeline**: Chronological event list (newest first) with type-specific icons/colors. Filter by event type. Show last 50 events with "load more".
   c. **Queue**: List of ready/queued items ordered by priority, showing target repo and estimated wait.
6. New component: `ConcurrencyGauge` showing active/limit per repo (small horizontal bar).
7. Dashboard home page: Add an ATC health card showing last run time and event count in last hour.
8. All new components in `components/` directory (not `components/ui/` which is shadcn).

## Execution Steps

### Step 0: Pre-flight checks and branch setup
