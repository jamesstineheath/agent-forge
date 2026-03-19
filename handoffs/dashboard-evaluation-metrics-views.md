<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Dashboard Evaluation Metrics Views

## Metadata
- **Branch:** `feat/dashboard-evaluation-metrics-views`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/agents/page.tsx, app/api/agents/evaluation-metrics/route.ts, components/evaluation-metrics-panel.tsx, lib/hooks.ts

## Context

PRJ-20 (Evaluation Model Expansion) shipped data-layer support for reasoning quality metrics, cost tracking, drift detection, and failure attribution. These are computed by the Supervisor and Health Monitor agents and stored in Vercel Blob / agent traces, but there is no dashboard UI to surface them.

The existing dashboard lives under `app/(app)/` using Next.js App Router. The agents page (`app/(app)/agents/page.tsx`) already shows agent heartbeats (see the recently merged `show-github-actions-tlm-agents-in-dashboard-agent-heartbeat` PR which added `components/tlm-agent-heartbeat.tsx` and `app/api/agents/tlm-agents/route.ts`). The pattern is: API route reads from blob/traces → React hook (SWR in `lib/hooks.ts`) fetches the API route → component renders.

**Concurrent work to avoid:** The branch `fix/wire-failure-attribution-into-health-monitor-agent` is actively modifying `lib/atc/health-monitor.ts` and `lib/types.ts`. Do **not** touch those files. All reads for failure attribution data should go through the blob store directly in the new API route, not by importing from those modules.

The four metric categories to add:

1. **Failure Attribution** — which agent/component causes the most failures. Data source: work item history events in `lib/atc/events.ts` (global rolling log at `af-data/atc/event-log.json`) and work items with `status: "failed"` in `af-data/work-items/*`.
2. **Cost per Work Item Trend** — cost tracking over time. Data source: agent traces / work item metadata (look for `costUsd` or similar fields on work item blobs).
3. **Reasoning Quality** — plan quality, step efficiency, tool correctness. Data source: Supervisor agent outputs / TLM memory at `docs/tlm-memory.md` (readable via GitHub API or blob).
4. **Drift Detection Alerts** — already computed by Supervisor. Data source: Supervisor's blob outputs (check `af-data/atc/*` for supervisor state or `af-data/work-items/*` for drift flags).

Since the exact blob key shapes for PRJ-20 data may vary, the API route should be defensive: return whatever data exists, and the UI should gracefully handle missing/empty data with a "No data yet" state.

## Requirements

1. New API route `GET /api/agents/evaluation-metrics` returns a JSON object with four top-level keys: `failureAttribution`, `costTrend`, `reasoningQuality`, `driftAlerts`.
2. `failureAttribution` is an array of `{ agent: string, count: number, percentage: number }` sorted descending by count.
3. `costTrend` is an array of `{ date: string, avgCostUsd: number, itemCount: number }` (last 14 days, one entry per day that has data).
4. `reasoningQuality` is an object with `{ planQuality: number | null, stepEfficiency: number | null, toolCorrectness: number | null, dataSource: string }` where values are 0–100 scores or null if unavailable.
5. `driftAlerts` is an array of `{ id: string, severity: "low"|"medium"|"high", message: string, detectedAt: string }`.
6. New SWR hook `useEvaluationMetrics()` added to `lib/hooks.ts` that fetches from the new API route.
7. New component `components/evaluation-metrics-panel.tsx` renders all four metric sections. Each section has a clear heading, handles empty/null data gracefully with a "No data available" message, and uses the existing Tailwind/shadcn styling patterns visible in other dashboard components.
8. The `app/(app)/agents/page.tsx` imports and renders `<EvaluationMetricsPanel />` below the existing content.
9. The API route is authenticated (same pattern as other API routes — check `auth()` from Auth.js and return 401 if unauthenticated).
10. No modifications to `lib/atc/health-monitor.ts` or `lib/types.ts`.
11. TypeScript compiles with no errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-evaluation-metrics-views
```

### Step 1: Explore existing patterns and data shapes

Before writing any code, read the existing codebase to understand patterns:

```bash
# Understand the API route pattern
cat app/api/agents/tlm-agents/route.ts
cat app/api/agents/atc-metrics/route.ts

# Understand hook pattern
cat lib/hooks.ts

# Understand storage patterns
cat lib/storage.ts

# See what blob keys exist for PRJ-20 / evaluation data
cat lib/atc/events.ts
cat lib/work-items.ts

# See the agents page to know where to insert the panel
cat app/(app)/agents/page.tsx

# Check an existing component for styling patterns
cat components/tlm-agent-heartbeat.tsx

# Check if there are any evaluation/supervisor blob keys referenced
grep -r "evaluation\|costUsd\|reasoningQuality\|driftAlert\|failureAttrib" lib/ app/ --include="*.ts" --include="*.tsx" -l
grep -r "supervisor" lib/atc/ --include="*.ts" -l
```

Identify:
- The exact blob key paths used by the Supervisor for drift alerts and reasoning quality data
- Whether cost data is stored on work item blobs (look for `costUsd`, `cost`, `totalCost` fields in `lib/types.ts` and work item blobs)
- The shape of the global event log to extract failure attribution

### Step 2: Create the API route

Create `app/api/agents/evaluation-metrics/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { list, get } from "@/lib/storage"; // use whatever storage helpers exist

// Types for the response shape
export interface FailureAttributionEntry {
  agent: string;
  count: number;
  percentage: number;
}

export interface CostTrendEntry {
  date: string; // ISO date string YYYY-MM-DD
  avgCostUsd: number;
  itemCount: number;
}

export interface ReasoningQualityMetrics {
  planQuality: number | null;
  stepEfficiency: number | null;
  toolCorrectness: number | null;
  dataSource: string;
}

export interface DriftAlert {
  id: string;
  severity: "low" | "medium" | "high";
  message: string;
  detectedAt: string;
}

export interface EvaluationMetricsResponse {
  failureAttribution: FailureAttributionEntry[];
  costTrend: CostTrendEntry[];
  reasoningQuality: ReasoningQualityMetrics;
  driftAlerts: DriftAlert[];
  lastUpdated: string;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [failureAttribution, costTrend, reasoningQuality, driftAlerts] =
      await Promise.allSettled([
        computeFailureAttribution(),
        computeCostTrend(),
        fetchReasoningQuality(),
        fetchDriftAlerts(),
      ]);

    return NextResponse.json({
      failureAttribution:
        failureAttribution.status === "fulfilled"
          ? failureAttribution.value
          : [],
      costTrend:
        costTrend.status === "fulfilled" ? costTrend.value : [],
      reasoningQuality:
        reasoningQuality.status === "fulfilled"
          ? reasoningQuality.value
          : { planQuality: null, stepEfficiency: null, toolCorrectness: null, dataSource: "unavailable" },
      driftAlerts:
        driftAlerts.status === "fulfilled" ? driftAlerts.value : [],
      lastUpdated: new Date().toISOString(),
    } satisfies EvaluationMetricsResponse);
  } catch (err) {
    console.error("[evaluation-metrics] unexpected error:", err);
    return NextResponse.json(
      { error: "Failed to load evaluation metrics" },
      { status: 500 }
    );
  }
}
```

Implement `computeFailureAttribution()`: list all work items, filter to `status === "failed"`, group by the `repoFullName` or any `agentSource` / `source` field present on items, count and compute percentages. If no agent field exists, try to parse the failure reason or fall back to grouping by `source` (e.g., `"github-issue"`, `"pa"`, `"manual"`). Return top 10 sorted descending.

Implement `computeCostTrend()`: list all work items, look for any `costUsd` / `cost` / `executionCostUsd` field on each item. If the field exists, bucket by `Math.floor(Date.parse(item.updatedAt) / 86400000)` → date string. Compute daily avg and count. Return last 14 days. If the field doesn't exist on any item, return `[]`.

Implement `fetchReasoningQuality()`: attempt to read a blob key like `af-data/atc/reasoning-quality.json` or `af-data/supervisor/reasoning-quality.json` (check what the Supervisor actually writes — grep for the key in `lib/atc/` files). Parse and return. If not found, return all-null object with `dataSource: "not yet computed"`.

Implement `fetchDriftAlerts()`: attempt to read `af-data/atc/drift-alerts.json` or `af-data/supervisor/drift-alerts.json`. If not found, scan the global event log (`af-data/atc/event-log.json`) for events with `type` containing `"drift"`. Return up to 20 most recent.

> **Key pattern**: Use `Promise.allSettled` so one missing blob doesn't break the whole response. Each helper should `try/catch` internally and return a safe empty value on any error.

### Step 3: Add the SWR hook

In `lib/hooks.ts`, add the new hook following the exact same pattern as existing hooks in the file:

```typescript
// Add import at top if EvaluationMetricsResponse type isn't auto-imported
// import type { EvaluationMetricsResponse } from "@/app/api/agents/evaluation-metrics/route";

export function useEvaluationMetrics() {
  const { data, error, isLoading } = useSWR<EvaluationMetricsResponse>(
    "/api/agents/evaluation-metrics",
    fetcher,
    { refreshInterval: 60_000 } // refresh every 60s
  );
  return { metrics: data, error, isLoading };
}
```

Match the exact `useSWR` import and `fetcher` function already used in the file.

### Step 4: Create the EvaluationMetricsPanel component

Create `components/evaluation-metrics-panel.tsx`. Study `components/tlm-agent-heartbeat.tsx` first to match the exact className patterns (card styles, heading styles, badge styles, etc.) used in the dashboard.

The component structure:

```tsx
"use client";

import { useEvaluationMetrics } from "@/lib/hooks";
// Import any UI primitives (Card, Badge, etc.) that are used in tlm-agent-heartbeat.tsx

export function EvaluationMetricsPanel() {
  const { metrics, isLoading, error } = useEvaluationMetrics();

  if (isLoading) {
    return <div className="...">Loading evaluation metrics...</div>;
  }
  if (error) {
    return <div className="...">Failed to load evaluation metrics</div>;
  }

  return (
    <div className="..."> {/* match outer container style from tlm-agent-heartbeat */}
      <h2 className="...">Evaluation Metrics</h2>

      {/* Section 1: Failure Attribution */}
      <FailureAttributionSection data={metrics?.failureAttribution ?? []} />

      {/* Section 2: Cost per Work Item Trend */}
      <CostTrendSection data={metrics?.costTrend ?? []} />

      {/* Section 3: Reasoning Quality */}
      <ReasoningQualitySection data={metrics?.reasoningQuality} />

      {/* Section 4: Drift Detection Alerts */}
      <DriftAlertsSection data={metrics?.driftAlerts ?? []} />
    </div>
  );
}
```

Sub-component implementation notes:

**FailureAttributionSection**: Render a simple bar-chart-like list. For each entry, show agent name, count badge, and a visual progress bar (just a `div` with `width: ${percentage}%` styled with Tailwind — no chart library needed). If array is empty, show "No failure attribution data yet."

**CostTrendSection**: Render a simple table or list showing date, avg cost (formatted as `$0.0000`), and item count. If empty, show "No cost data available — cost tracking may not be enabled."

**ReasoningQualitySection**: Show three metrics as labeled stat cards: Plan Quality, Step Efficiency, Tool Correctness. Each shows the score (e.g., `87/100`) or `—` if null. Show the `dataSource` string as a small caption. If all null and dataSource contains "not yet", show "Reasoning quality data will appear after the Supervisor agent runs."

**DriftAlertsSection**: Render alerts as a list. Each alert shows severity badge (color-coded: low=gray, medium=yellow, high=red), message, and time-ago string. If empty, show a green "✓ No drift detected" message. Cap display at 10 most recent.

Use only Tailwind classes and any UI primitives already imported in other dashboard components (check `app/(app)/agents/page.tsx` and `components/tlm-agent-heartbeat.tsx` for what's available). **Do not install new npm packages.**

### Step 5: Wire into the agents page

Edit `app/(app)/agents/page.tsx` to import and render the panel:

```tsx
import { EvaluationMetricsPanel } from "@/components/evaluation-metrics-panel";

// Inside the page JSX, after the existing content (TLM agent heartbeat, etc.):
<EvaluationMetricsPanel />
```

Place it logically — after the existing agent health section but before any footer. Match the spacing/layout patterns in the existing page.

### Step 6: Verification

```bash
# TypeScript check — must be clean
npx tsc --noEmit

# Build must succeed
npm run build

# Confirm no modifications to the concurrent-work files
git diff --name-only | grep -E "lib/atc/health-monitor.ts|lib/types.ts"
# Should output nothing

# Smoke-check the new files exist
ls app/api/agents/evaluation-metrics/route.ts
ls components/evaluation-metrics-panel.tsx
grep -n "useEvaluationMetrics" lib/hooks.ts
grep -n "EvaluationMetricsPanel" app/\(app\)/agents/page.tsx
```

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add evaluation metrics dashboard views

- Add /api/agents/evaluation-metrics route (failure attribution, cost trend, reasoning quality, drift alerts)
- Add useEvaluationMetrics SWR hook to lib/hooks.ts
- Add EvaluationMetricsPanel component with four metric sections
- Wire EvaluationMetricsPanel into agents dashboard page
- All metric fetches use Promise.allSettled for graceful degradation
- No modifications to lib/atc/health-monitor.ts or lib/types.ts"

git push origin feat/dashboard-evaluation-metrics-views

gh pr create \
  --title "feat: dashboard evaluation metrics views" \
  --body "## Summary

Adds dashboard UI for evaluation metrics from PRJ-20 (Evaluation Model Expansion).

## Changes

- **\`app/api/agents/evaluation-metrics/route.ts\`** — New authenticated API route returning failure attribution, cost trend, reasoning quality, and drift alerts. Uses \`Promise.allSettled\` so missing blob data never breaks the response.
- **\`lib/hooks.ts\`** — New \`useEvaluationMetrics()\` SWR hook (60s refresh interval).
- **\`components/evaluation-metrics-panel.tsx\`** — Four-section panel component. Each section handles empty/null data gracefully.
- **\`app/(app)/agents/page.tsx\`** — Renders \`<EvaluationMetricsPanel />\` below existing agent heartbeat content.

## Notes

- Does **not** modify \`lib/atc/health-monitor.ts\` or \`lib/types.ts\` (concurrent branch conflict avoidance).
- If PRJ-20 blob keys differ from what was assumed, the API route returns empty/null values — no errors.
- No new npm dependencies.

## Testing

- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Dashboard renders metrics panel; empty states display when data not yet available"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-evaluation-metrics-views
FILES CHANGED: [list what was actually created/modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [e.g., "ReasoningQualitySection not implemented — blob key shape unclear. Need to check what af-data/atc/reasoning-quality.json actually contains."]
```

## Escalation

If the blob key paths for PRJ-20 evaluation data cannot be determined from the codebase (no `reasoning-quality`, `drift-alerts`, or similar keys found anywhere in `lib/`), escalate before guessing:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "dashboard-evaluation-metrics-views",
    "reason": "Cannot locate PRJ-20 blob key paths for reasoning quality, drift alerts, or cost data. No references found in lib/. Need blob key schema from PRJ-20 implementation.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2",
      "error": "grep for costUsd, reasoningQuality, driftAlert returned no results in lib/ or app/",
      "filesChanged": []
    }
  }'
```