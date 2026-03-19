# Agent Forge -- Create Cost Baseline Tracking API

## Metadata
- **Branch:** `feat/cost-baseline-tracking-api`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/analytics/cost-baseline/route.ts, app/components/model-routing-dashboard.tsx, lib/hooks.ts

## Context

Agent Forge tracks work items dispatched to target repos via autonomous agents. The platform recently added model routing (Opus vs Sonnet) to reduce costs while maintaining quality. The 30% cost reduction target needs to be validated by comparing current costs against a recorded all-Opus baseline.

Relevant existing patterns:
- `app/api/analytics/model-routing/route.ts` — analytics API that queries model_call events from the event bus; follow this pattern exactly
- `lib/feedback-compiler-routing.ts` — reads model_call events from `lib/event-bus.ts`; shows how to query event bus for model_call data
- `app/components/model-routing-dashboard.tsx` — existing dashboard with metric cards; add a new "Phase 1 ROI" card here
- `lib/hooks.ts` — SWR hooks pattern (e.g. `useModelRouting()`); add `useCostBaseline()` following the same shape
- Vercel Blob storage pattern: `lib/storage.ts` wraps `@vercel/blob`; use `put` and `head`/`get` for JSON blobs at `af-data/config/cost-baseline.json`
- Auth pattern: API routes under `app/(app)` use `auth()` from `lib/auth.ts`; check how `model-routing/route.ts` handles auth

Model call events in the event bus have type `model_call` and include fields like `model`, `cost`, `workItemId`, and `success` (or similar — inspect `lib/event-bus-types.ts` for the exact shape).

The endpoint must be authenticated (Bearer token via `AGENT_FORGE_API_SECRET` or session auth, following the pattern in `app/api/analytics/model-routing/route.ts`).

## Requirements

1. `POST /api/analytics/cost-baseline` — queries all `model_call` events from the last 30 days, calculates `totalCost`, `totalItems` (successful work items), `baselineCostPerSuccess`, and `recordedAt`, stores as JSON in Vercel Blob at `af-data/config/cost-baseline.json`, returns the stored `CostBaseline` object.
2. `GET /api/analytics/cost-baseline` — reads stored baseline from Blob; calculates current cost-per-success from the last 30 days of `model_call` events; returns a `CostComparison` object with `{ baselineCostPerSuccess, currentCostPerSuccess, costReductionPct, baselineSuccessRate, currentSuccessRate, periodStart, periodEnd }`. When no baseline exists, returns the comparison with `null` for comparison fields but still includes current stats.
3. `useCostBaseline()` hook added to `lib/hooks.ts` using SWR, fetching from `/api/analytics/cost-baseline`, following the same pattern as existing hooks.
4. "Phase 1 ROI" card added to `app/components/model-routing-dashboard.tsx` showing `costReductionPct` and success rate comparison; includes a "Record Baseline" button (POST trigger) when no baseline exists.
5. Project compiles with `npm run build` and `npx tsc --noEmit`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/cost-baseline-tracking-api
```

### Step 1: Inspect existing patterns

Read these files before writing any code:

```bash
cat app/api/analytics/model-routing/route.ts
cat lib/event-bus-types.ts
cat lib/event-bus.ts
cat lib/storage.ts
cat lib/hooks.ts
cat app/components/model-routing-dashboard.tsx
cat lib/types.ts
```

Pay close attention to:
- How `model-routing/route.ts` authenticates requests (replicate exactly)
- The exact shape of `model_call` events — field names for `model`, `cost`, `success`, `workItemId`, timestamps
- How `lib/storage.ts` exposes Blob `put`/`get` (or whether to use `@vercel/blob` directly)
- The SWR hook shape in `lib/hooks.ts`
- Existing card component structure in `model-routing-dashboard.tsx`

### Step 2: Create the cost baseline API route

Create `app/api/analytics/cost-baseline/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
// Import auth following the same pattern as model-routing/route.ts
// Import event bus query functions
// Import storage helpers or @vercel/blob directly

// --- Types ---

export interface CostBaseline {
  baselineCostPerSuccess: number
  recordedAt: string          // ISO timestamp
  totalItems: number          // successful work items in the 30-day window
  totalCost: number           // total model cost in the 30-day window
  successRate: number         // fraction of work items that succeeded
  periodStart: string
  periodEnd: string
}

export interface CostComparison {
  baseline: CostBaseline | null
  baselineCostPerSuccess: number | null
  currentCostPerSuccess: number | null
  costReductionPct: number | null   // positive = cheaper than baseline
  baselineSuccessRate: number | null
  currentSuccessRate: number | null
  currentTotalCost: number
  currentTotalItems: number
  periodStart: string
  periodEnd: string
}

const BASELINE_BLOB_KEY = 'af-data/config/cost-baseline.json'

// --- Helper: compute stats from model_call events ---
// Adapt field names to match the actual event shape discovered in Step 1

async function computeStatsFromEvents(events: /* EventType[] */ any[]): Promise<{
  totalCost: number
  totalItems: number   // successful
  successRate: number
  periodStart: string
  periodEnd: string
}> {
  const modelCallEvents = events.filter(e => e.type === 'model_call')
  // Adjust field names based on actual event-bus-types.ts
  const totalCost = modelCallEvents.reduce((sum, e) => sum + (e.cost ?? e.data?.cost ?? 0), 0)
  const successfulItems = modelCallEvents.filter(e => e.success ?? e.data?.success ?? false)
  const totalItems = successfulItems.length
  const successRate = modelCallEvents.length > 0 ? totalItems / modelCallEvents.length : 0
  const timestamps = modelCallEvents.map(e => new Date(e.timestamp ?? e.createdAt).getTime())
  const periodStart = timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString()
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const periodEnd = new Date().toISOString()
  return { totalCost, totalItems, successRate, periodStart, periodEnd }
}

// --- POST: record baseline ---
export async function POST(req: NextRequest) {
  // 1. Auth check — follow model-routing/route.ts pattern exactly
  // 2. Query model_call events for last 30 days from event bus
  // 3. Compute stats
  // 4. Build CostBaseline object
  // 5. Store to Blob at BASELINE_BLOB_KEY
  // 6. Return the stored baseline
}

// --- GET: return comparison ---
export async function GET(req: NextRequest) {
  // 1. Auth check
  // 2. Try to read existing baseline from Blob (handle 404 gracefully)
  // 3. Query model_call events for last 30 days
  // 4. Compute current stats
  // 5. Build CostComparison
  //    - costReductionPct = baseline exists
  //        ? ((baseline.baselineCostPerSuccess - current.costPerSuccess) / baseline.baselineCostPerSuccess) * 100
  //        : null
  // 6. Return comparison
}
```

**Important implementation notes:**
- Use the exact auth pattern from `model-routing/route.ts` — do not invent a new one
- For Blob storage: if `lib/storage.ts` has helpers, use them; otherwise import `{ put, head }` from `@vercel/blob` and `fetch` the URL to read JSON
- Handle the case where no baseline blob exists (catch a 404 or check `head()` before `get()`)
- `costReductionPct` should be positive when current < baseline (we're spending less), negative when current > baseline
- If `totalItems === 0`, set `costPerSuccess` to `0` to avoid division by zero

### Step 3: Add `useCostBaseline` hook to `lib/hooks.ts`

Open `lib/hooks.ts` and add the following hook, matching the existing SWR hook style precisely:

```typescript
import type { CostComparison } from '@/app/api/analytics/cost-baseline/route'

// Add near the other analytics hooks (e.g., near useModelRouting)
export function useCostBaseline() {
  const { data, error, isLoading, mutate } = useSWR<CostComparison>(
    '/api/analytics/cost-baseline',
    fetcher  // use whatever fetcher is already defined in hooks.ts
  )
  return {
    comparison: data ?? null,
    isLoading,
    error,
    refresh: mutate,
  }
}
```

Adjust the import path and type shape based on what you see in the existing hooks.

### Step 4: Add "Phase 1 ROI" card to the model routing dashboard

Open `app/components/model-routing-dashboard.tsx` and:

1. Import `useCostBaseline` from `lib/hooks.ts`
2. Call `useCostBaseline()` near the top of the component
3. Add a POST handler for the "Record Baseline" button:

```typescript
async function handleRecordBaseline() {
  await fetch('/api/analytics/cost-baseline', { method: 'POST' })
  refreshBaseline() // call mutate/refresh from the hook
}
```

4. Add a "Phase 1 ROI" card in the dashboard grid, following the same card structure as existing cards:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Phase 1 ROI</CardTitle>
    <CardDescription>Cost reduction vs all-Opus baseline</CardDescription>
  </CardHeader>
  <CardContent>
    {comparison?.baseline == null ? (
      <div>
        <p className="text-sm text-muted-foreground mb-3">
          No baseline recorded. Record a baseline to start tracking cost reduction.
        </p>
        <Button onClick={handleRecordBaseline} size="sm">
          Record Baseline
        </Button>
      </div>
    ) : (
      <div className="space-y-3">
        <div>
          <p className="text-2xl font-bold text-green-600">
            {comparison.costReductionPct != null
              ? `${comparison.costReductionPct.toFixed(1)}%`
              : '—'}
          </p>
          <p className="text-xs text-muted-foreground">cost reduction vs baseline</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="font-medium">Baseline cost/success</p>
            <p className="text-muted-foreground">
              ${comparison.baselineCostPerSuccess?.toFixed(4) ?? '—'}
            </p>
          </div>
          <div>
            <p className="font-medium">Current cost/success</p>
            <p className="text-muted-foreground">
              ${comparison.currentCostPerSuccess?.toFixed(4) ?? '—'}
            </p>
          </div>
          <div>
            <p className="font-medium">Baseline success rate</p>
            <p className="text-muted-foreground">
              {comparison.baselineSuccessRate != null
                ? `${(comparison.baselineSuccessRate * 100).toFixed(1)}%`
                : '—'}
            </p>
          </div>
          <div>
            <p className="font-medium">Current success rate</p>
            <p className="text-muted-foreground">
              {comparison.currentSuccessRate != null
                ? `${(comparison.currentSuccessRate * 100).toFixed(1)}%`
                : '—'}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Baseline recorded {new Date(comparison.baseline.recordedAt).toLocaleDateString()}
        </p>
      </div>
    )}
  </CardContent>
</Card>
```

Use the exact card component imports already present in the file. Match spacing, className conventions, and layout patterns from the existing cards.

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors. Common issues to watch for:
- Import path for `CostComparison` type in `hooks.ts` — may need to be a relative import
- Blob read pattern — if `lib/storage.ts` doesn't expose a generic `get`, use `@vercel/blob`'s `head` + native `fetch(url)` to read JSON
- Auth import path differences from what's sketched above

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add cost baseline tracking API and Phase 1 ROI dashboard card"
git push origin feat/cost-baseline-tracking-api
gh pr create \
  --title "feat: create cost baseline tracking API" \
  --body "## Summary

Adds a cost baseline tracking API to validate the 30% cost reduction target from model routing.

## Changes

- **app/api/analytics/cost-baseline/route.ts** — New endpoint: POST records all-Opus baseline from last 30 days of model_call events; GET returns CostComparison with costReductionPct vs stored baseline
- **lib/hooks.ts** — Added \`useCostBaseline()\` SWR hook
- **app/components/model-routing-dashboard.tsx** — Added 'Phase 1 ROI' card showing cost reduction %, success rate comparison, and baseline recording button

## Acceptance Criteria
- [x] POST records CostBaseline to Blob with baselineCostPerSuccess, recordedAt, totalItems, totalCost
- [x] GET returns CostComparison with costReductionPct when baseline exists
- [x] GET returns meaningful response (null comparison fields) when no baseline recorded
- [x] Phase 1 ROI card renders on model routing dashboard
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/cost-baseline-tracking-api
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "dashboard card not yet added", "Blob read pattern needs fixing"]
```

## Escalation

If blocked on any of the following, call the escalation API:
- The `model_call` event shape in `lib/event-bus-types.ts` doesn't have `cost` or `success` fields and you can't determine the correct field names
- `lib/storage.ts` has no way to read arbitrary JSON blobs and `@vercel/blob` is not available as a dependency
- The auth pattern in `model-routing/route.ts` requires credentials or environment variables not available in the execution environment

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "cost-baseline-tracking-api",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/analytics/cost-baseline/route.ts", "lib/hooks.ts", "app/components/model-routing-dashboard.tsx"]
    }
  }'
```