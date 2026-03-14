# Agent Forge -- ATC Dashboard Enhancement

## Metadata
- **Branch:** `feat/atc-dashboard`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** low
- **Estimated files:** app/api/atc/route.ts, lib/hooks.ts, app/(app)/pipeline/page.tsx, app/(app)/page.tsx, components/atc-event-log.tsx, components/concurrency-gauge.tsx
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

1. `GET /api/atc` returns the full ATCState (already partially exists but enhance it to also return recent events from the event log).
2. `GET /api/atc/events?limit=50` returns the event log with configurable limit.
3. New SWR hook: `useATCState()` polling `/api/atc` every 10s.
4. New SWR hook: `useATCEvents(limit)` polling `/api/atc/events?limit={limit}` every 30s.
5. Pipeline page rebuilt with three sections:
   a. **Active Executions** (existing, enhanced): Show each execution with status badge, elapsed time, PR link, repo name, and files being modified (collapsible).
   b. **Event Timeline**: Chronological event list (newest first) with type-specific icons/colors. Filter by event type. Show last 50 events with "load more".
   c. **Queue**: List of ready/queued items ordered by priority, showing target repo and estimated wait.
6. New component: `ConcurrencyGauge` showing active/limit per repo (small horizontal bar).
7. Dashboard home page: Add an ATC health card showing last run time and event count in last hour.
8. All new components in `components/` directory (not `components/ui/` which is shadcn).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-dashboard
```

### Step 1: Enhance ATC API routes

**`app/api/atc/route.ts`** (enhance existing or create if missing):
```typescript
import { NextResponse } from "next/server";
import { getATCState, getATCEvents } from "@/lib/atc";

export async function GET() {
  const [state, recentEvents] = await Promise.all([
    getATCState(),
    getATCEvents(20),
  ]);
  return NextResponse.json({ ...state, recentEvents });
}
```

**`app/api/atc/events/route.ts`** (new):
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getATCEvents } from "@/lib/atc";

export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
  const events = await getATCEvents(Math.min(limit, 200));
  return NextResponse.json(events);
}
```

### Step 2: Add SWR hooks

In `lib/hooks.ts`, add:
```typescript
import type { ATCState, ATCEvent } from "@/lib/types";

export function useATCState() {
  const { data, error, isLoading, mutate } = useSWR<ATCState & { recentEvents: ATCEvent[] }>(
    "/api/atc",
    fetcher,
    { refreshInterval: 10000 }
  );
  return { data, error, isLoading, mutate };
}

export function useATCEvents(limit = 50) {
  const { data, error, isLoading, mutate } = useSWR<ATCEvent[]>(
    `/api/atc/events?limit=${limit}`,
    fetcher,
    { refreshInterval: 30000 }
  );
  return { data, error, isLoading, mutate };
}
```

### Step 3: Create ConcurrencyGauge component

**`components/concurrency-gauge.tsx`**:
A small component that renders a horizontal bar showing active/limit for a repo. Props: `repoName: string`, `active: number`, `limit: number`. Use Tailwind for the bar (bg-blue-500 for active, bg-gray-200 for remaining). Show "repoShortName: 1/2" text.

### Step 4: Create ATCEventLog component

**`components/atc-event-log.tsx`**:
Takes `events: ATCEvent[]` as prop. Renders a vertical timeline list. Each event shows:
- Timestamp (relative, e.g., "3m ago")
- Type badge with color coding:
  - status_change: blue
  - timeout: red
  - concurrency_block: yellow
  - auto_dispatch: green
  - conflict: orange
  - retry: amber
  - parked: slate
  - error: red
- Work item ID (truncated, first 8 chars)
- Details text
- Previous -> New status transition (if present)

Include a simple filter: row of clickable badges to toggle event types on/off.

### Step 5: Rebuild pipeline page

Replace `app/(app)/pipeline/page.tsx` with an enhanced version that uses `useATCState()`, `useATCEvents()`, `useWorkItems()`, and `useRepos()`:

Three sections:

**Section 1: Active Executions + Concurrency**
- Show ConcurrencyGauge for each registered repo
- Below, show active execution cards (similar to current but enhanced with `filesBeingModified` as a collapsible details section)

**Section 2: Queue**
- List work items with status "ready" or "queued"
- Sort by priority (high first), then createdAt
- Show: title, target repo, priority badge, created time
- If queue is empty, show a clean empty state

**Section 3: Event Timeline**
- ATCEventLog component with last 50 events
- Type filter badges above the timeline

Keep the existing STATUS_COLORS map and format helpers.

### Step 6: Update dashboard home page

In `app/(app)/page.tsx`, add an ATC Health card to the stats grid:
```typescript
// After the existing 4 stat cards, add:
<Card>
  <CardHeader className="pb-2">
    <CardTitle className="text-sm font-medium text-muted-foreground">
      ATC Status
    </CardTitle>
  </CardHeader>
  <CardContent>
    <p className="text-sm font-medium">
      {atcState ? `Last run: ${formatRelativeTime(atcState.lastRunAt)}` : "\u2014"}
    </p>
  </CardContent>
</Card>
```

Use `useATCState()` hook in the dashboard page.

### Step 7: Verification
```bash
npx tsc --noEmit
npm run build
```

### Step 8: Commit, push, open PR
```bash
git add -A
git commit -m "feat: ATC dashboard with event timeline, queue, and concurrency gauges

Wires the pipeline page to real ATC state. Shows event timeline with
type filtering, queue with priority ordering, and per-repo concurrency
gauges. Adds ATC health card to dashboard home."
git push origin feat/atc-dashboard
gh pr create --title "feat: ATC dashboard enhancement" --body "## Summary
- Pipeline page rebuilt with three sections: active executions + concurrency, queue, event timeline
- New API: GET /api/atc/events for event log with configurable limit
- New SWR hooks: useATCState (10s poll), useATCEvents (30s poll)
- New components: ConcurrencyGauge, ATCEventLog
- Dashboard home gains ATC health card
- Event type filtering with color-coded badges

## Files Changed
- app/api/atc/route.ts (enhanced response)
- app/api/atc/events/route.ts (new)
- lib/hooks.ts (useATCState, useATCEvents)
- components/concurrency-gauge.tsx (new)
- components/atc-event-log.tsx (new)
- app/(app)/pipeline/page.tsx (rebuilt)
- app/(app)/page.tsx (ATC health card)

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Low. New UI components and API routes. No changes to ATC logic or work item state machine."
```

### Step 9: Auto-merge
If CI passes and TLM review approves, merge the PR:
```bash
gh pr merge --squash --auto
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-dashboard
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
