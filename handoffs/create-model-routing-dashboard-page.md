# Agent Forge -- Create Model Routing Dashboard Page

## Metadata
- **Branch:** `feat/model-routing-dashboard`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/model-routing/page.tsx, app/components/model-routing-dashboard.tsx, lib/hooks.ts, app/layout.tsx

## Context

Agent Forge is a Next.js dev orchestration platform. A model routing analytics API endpoint was recently added at `/api/analytics/model-routing` (see merged PR: `feat: create model routing analytics API endpoint`, file `app/api/analytics/model-routing/route.ts`).

This task creates the frontend dashboard page to visualize that data: per-model costs, daily spend, quality scores, and escalation rates. The codebase uses:

- **Next.js App Router** with server components for pages and client components for interactive UI
- **SWR** for client-side data fetching via hooks in `lib/hooks.ts`
- **Auth.js v5** — pages inside `app/(app)/` are auth-protected; the model routing page should live there or at a top-level route (use `app/model-routing/` as specified, but check if auth is needed by looking at the existing layout)
- Existing SWR hook pattern in `lib/hooks.ts` to guide the new hook

Before implementing, read the following files to understand patterns:
- `lib/hooks.ts` — existing SWR hooks
- `app/(app)/page.tsx` — dashboard page pattern
- `app/layout.tsx` — navigation structure
- `app/api/analytics/model-routing/route.ts` — API response shape

## Requirements

1. `app/model-routing/page.tsx` is a server component that renders at `/model-routing` with a title ("Model Routing Analytics"), a description, and includes the `<ModelRoutingDashboard />` client component.
2. `app/components/model-routing-dashboard.tsx` is a client component that fetches from `/api/analytics/model-routing` via the `useModelRoutingAnalytics` SWR hook.
3. The dashboard shows four sections: per-model cost breakdown, daily spend, quality scores (taskType × model matrix), and escalation rates.
4. A time range filter (last 7d, 30d, 90d) is present and updates the query parameters sent to the API on change.
5. An optional taskType filter is present (text input or select) that also updates query parameters.
6. Loading state is shown while data is fetching.
7. Empty state is shown when no data is returned.
8. `lib/hooks.ts` exports `useModelRoutingAnalytics(params)` using `useSWR`.
9. `app/layout.tsx` includes a navigation link to `/model-routing` (only if a nav exists in that file).
10. `npm run build` completes without TypeScript or build errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/model-routing-dashboard
```

### Step 1: Read existing files for patterns

Read these files before writing any code:

```bash
cat lib/hooks.ts
cat app/layout.tsx
cat app/api/analytics/model-routing/route.ts
cat app/components/force-opus-toggle.tsx   # client component pattern
# Also check if app/(app)/ layout handles auth
cat app/\(app\)/page.tsx 2>/dev/null || echo "not found"
ls app/
```

Use what you find to match the exact patterns: SWR import style, hook signature, TypeScript type usage, Tailwind class conventions, etc.

### Step 2: Add `useModelRoutingAnalytics` hook to `lib/hooks.ts`

Append the following hook to `lib/hooks.ts`. Match the existing import style (do not add duplicate imports).

The API endpoint (`/api/analytics/model-routing`) accepts query params: `days` (number), `taskType` (string). It returns JSON with (at minimum) arrays for per-model costs, daily spend, quality scores, and escalation rates — confirm the exact shape from the route file you read in Step 1.

```typescript
// Add to lib/hooks.ts

export interface ModelRoutingParams {
  days?: number;
  taskType?: string;
}

// These types should match the actual API response shape from app/api/analytics/model-routing/route.ts
// Adjust field names based on what you see in the API route
export interface ModelCostEntry {
  model: string;
  totalCost: number;
  callCount: number;
  avgCostPerStep: number;
}

export interface DailySpendEntry {
  date: string;
  model: string;
  cost: number;
}

export interface QualityScoreEntry {
  taskType: string;
  model: string;
  successRate: number;
}

export interface EscalationRateEntry {
  taskType: string;
  escalationCount: number;
  totalCalls: number;
  rate: number;
}

export interface ModelRoutingAnalytics {
  perModelCosts?: ModelCostEntry[];
  dailySpend?: DailySpendEntry[];
  qualityScores?: QualityScoreEntry[];
  escalationRates?: EscalationRateEntry[];
}

export function useModelRoutingAnalytics(params?: ModelRoutingParams) {
  const searchParams = new URLSearchParams();
  if (params?.days) searchParams.set("days", String(params.days));
  if (params?.taskType) searchParams.set("taskType", params.taskType);
  const query = searchParams.toString();
  const url = `/api/analytics/model-routing${query ? `?${query}` : ""}`;

  const { data, error, isLoading } = useSWR<ModelRoutingAnalytics>(url);
  return { data, error, isLoading };
}
```

> **Important:** After reading the actual API route in Step 1, adjust the type definitions to match the real response shape. Do not invent fields.

### Step 3: Create `app/components/model-routing-dashboard.tsx`

```typescript
"use client";

import { useState } from "react";
import {
  useModelRoutingAnalytics,
  type ModelRoutingParams,
} from "@/lib/hooks";

const TIME_RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
] as const;

export function ModelRoutingDashboard() {
  const [days, setDays] = useState<number>(30);
  const [taskType, setTaskType] = useState<string>("");

  const params: ModelRoutingParams = { days, taskType: taskType || undefined };
  const { data, isLoading } = useModelRoutingAnalytics(params);

  return (
    <div className="space-y-8">
      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex gap-2">
          {TIME_RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                days === r.days
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by task type..."
          value={taskType}
          onChange={(e) => setTaskType(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="text-center py-12 text-gray-500">
          Loading analytics...
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !data && (
        <div className="text-center py-12 text-gray-500">
          No analytics data available for the selected range.
        </div>
      )}

      {data && (
        <>
          {/* Per-Model Cost Breakdown */}
          <section>
            <h2 className="text-lg font-semibold mb-3">
              Per-Model Cost Breakdown
            </h2>
            {!data.perModelCosts || data.perModelCosts.length === 0 ? (
              <p className="text-gray-500 text-sm">No cost data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-left">
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Model
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Total Cost
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Call Count
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Avg Cost/Step
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perModelCosts.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 border border-gray-200 font-mono text-xs">
                          {row.model}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          ${row.totalCost.toFixed(4)}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          {row.callCount}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          ${row.avgCostPerStep.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Daily Spend */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Daily Spend</h2>
            {!data.dailySpend || data.dailySpend.length === 0 ? (
              <p className="text-gray-500 text-sm">No daily spend data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-left">
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Date
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Model
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dailySpend.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 border border-gray-200">
                          {row.date}
                        </td>
                        <td className="px-4 py-2 border border-gray-200 font-mono text-xs">
                          {row.model}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          ${row.cost.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Quality Scores */}
          <section>
            <h2 className="text-lg font-semibold mb-3">
              Quality Scores (Task Type × Model)
            </h2>
            {!data.qualityScores || data.qualityScores.length === 0 ? (
              <p className="text-gray-500 text-sm">No quality score data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-left">
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Task Type
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Model
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Success Rate
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.qualityScores.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 border border-gray-200">
                          {row.taskType}
                        </td>
                        <td className="px-4 py-2 border border-gray-200 font-mono text-xs">
                          {row.model}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          <span
                            className={
                              row.successRate >= 0.8
                                ? "text-green-700"
                                : row.successRate >= 0.5
                                ? "text-yellow-700"
                                : "text-red-700"
                            }
                          >
                            {(row.successRate * 100).toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Escalation Rates */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Escalation Rates</h2>
            {!data.escalationRates || data.escalationRates.length === 0 ? (
              <p className="text-gray-500 text-sm">No escalation data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-left">
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Task Type
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Escalations
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Total Calls
                      </th>
                      <th className="px-4 py-2 border border-gray-200 font-medium">
                        Rate
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.escalationRates.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2 border border-gray-200">
                          {row.taskType}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          {row.escalationCount}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          {row.totalCalls}
                        </td>
                        <td className="px-4 py-2 border border-gray-200">
                          <span
                            className={
                              row.rate <= 0.05
                                ? "text-green-700"
                                : row.rate <= 0.15
                                ? "text-yellow-700"
                                : "text-red-700"
                            }
                          >
                            {(row.rate * 100).toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
```

> **Note:** After reading the actual API route response shape in Step 1, adjust field names and types to match exactly. For example, the API might use `avgCost` instead of `avgCostPerStep`, or nest data differently. Do not guess — read the source.

### Step 4: Create `app/model-routing/page.tsx`

```typescript
import { ModelRoutingDashboard } from "@/app/components/model-routing-dashboard";

export const metadata = {
  title: "Model Routing Analytics | Agent Forge",
};

export default function ModelRoutingPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">
          Model Routing Analytics
        </h1>
        <p className="mt-2 text-gray-600">
          Per-model cost breakdown, daily spend, quality scores, and escalation
          rates across routing decisions.
        </p>
      </div>
      <ModelRoutingDashboard />
    </div>
  );
}
```

> **Important:** Check if the app uses auth-protected layouts (e.g., `app/(app)/`). If all dashboard pages live under `app/(app)/`, move the page to `app/(app)/model-routing/page.tsx` instead. Read `app/layout.tsx` and the directory structure to decide.

### Step 5: Add navigation link to `app/layout.tsx`

Read `app/layout.tsx`. If it contains a `<nav>` or navigation link list, add a link to `/model-routing`. Match the exact style/component of existing nav links.

Example (adjust to match existing pattern):
```tsx
<Link href="/model-routing">Model Routing</Link>
```

If there is no nav in `app/layout.tsx` (e.g., nav lives in a different component), find where nav links are defined (search for existing nav links like `/` or `/work-items`) and add the link there.

```bash
grep -r "href=" app/ --include="*.tsx" -l | head -10
grep -r "model-routing\|work-items\|pipeline" app/ --include="*.tsx" -l | head -10
```

### Step 6: Verify TypeScript alignment

After writing all files, verify that types exported from `lib/hooks.ts` exactly match the API response. Check `app/api/analytics/model-routing/route.ts` one more time and reconcile any field name mismatches.

Common issues to check:
- `successRate` vs `success_rate` (camelCase vs snake_case)
- `totalCost` vs `total_cost`
- Nested vs flat response structure
- Optional vs required fields

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common fixes:
- If `useSWR` import is missing in hooks.ts, it's already imported — don't double-import
- If the page needs to be inside `app/(app)/`, move it
- If `@/` alias isn't used in the codebase, use relative imports instead

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: create model routing dashboard page"
git push origin feat/model-routing-dashboard
gh pr create \
  --title "feat: create model routing dashboard page" \
  --body "## Summary

Adds the model routing analytics dashboard at \`/model-routing\`.

## Changes
- \`app/model-routing/page.tsx\` — Server component page with title, description, and dashboard
- \`app/components/model-routing-dashboard.tsx\` — Client component with SWR data fetching, time range filter, taskType filter, and four data sections
- \`lib/hooks.ts\` — Added \`useModelRoutingAnalytics(params)\` SWR hook with typed response
- \`app/layout.tsx\` — Added navigation link to /model-routing

## Sections
- Per-model cost breakdown (model, totalCost, callCount, avgCostPerStep)
- Daily spend table (date, model, cost)
- Quality scores table (taskType × model, successRate with color coding)
- Escalation rates table (taskType, escalationCount, totalCalls, rate with color coding)

## Filters
- Time range selector (7d / 30d / 90d)
- Optional taskType text filter

## Verification
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/model-routing-dashboard
FILES CHANGED: [list files modified]
SUMMARY: [what was done]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "type alignment with API response", "nav link not added"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., the API route doesn't exist yet, auth middleware blocks the route, or the response shape is undocumented):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "create-model-routing-dashboard-page",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/model-routing/page.tsx", "app/components/model-routing-dashboard.tsx", "lib/hooks.ts", "app/layout.tsx"]
    }
  }'
```