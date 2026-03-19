# Agent Forge -- Create Model Routing Analytics API Endpoint

## Metadata
- **Branch:** `feat/model-routing-analytics-api`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/analytics/model-routing/route.ts

## Context

Agent Forge is a dev orchestration platform built on Next.js (App Router). It coordinates autonomous agent teams and tracks work items across multiple repositories.

The platform has an event bus (`lib/event-bus.ts`) with durable Vercel Blob storage for webhook and system events. The existing event query infrastructure in `lib/atc/events.ts` provides functions for querying typed events. This task adds a new analytics API endpoint that aggregates model call and escalation events into a structured analytics shape for dashboard consumption.

Auth uses Auth.js v5 (`next-auth@beta`) with Google OAuth. All API routes requiring auth check for a valid session. See existing authenticated API routes (e.g., `app/api/events/route.ts`) for the pattern.

**Concurrent work to avoid:** The concurrent branch `fix/create-forceopus-kill-switch-api-and-dashboard-tog` touches `app/api/config/force-opus/route.ts`, `app/components/force-opus-toggle.tsx`, and `app/page.tsx`. This task creates a new file at `app/api/analytics/model-routing/route.ts` — **no overlap**.

## Requirements

1. Create `app/api/analytics/model-routing/route.ts` with a `GET` handler
2. Accept query params: `startDate`, `endDate`, `taskType` (all optional)
3. Default date range to last 7 days when `startDate`/`endDate` are not provided
4. Query model call events using `queryModelCallEvents` from `lib/atc/events.ts`
5. Query model escalation events using `queryModelEscalationEvents` from `lib/atc/events.ts`
6. Aggregate results into a `ModelRoutingAnalytics` shape:
   - `perModelCosts`: `Record<string, { totalCost: number; callCount: number; avgCostPerStep: number }>`
   - `dailySpend`: `Array<{ date: string; model: string; cost: number }>`
   - `qualityScores`: `Array<{ taskType: string; model: string; successRate: number; totalCalls: number }>`
   - `escalationRates`: `Array<{ taskType: string; escalationCount: number; totalCalls: number; rate: number }>`
7. Require session auth; return 401 if unauthenticated
8. Return zero-value analytics (empty arrays/objects) when no events exist — never error on empty data
9. Project must compile with `npm run build`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/model-routing-analytics-api
```

### Step 1: Inspect existing event query infrastructure

Before writing code, examine the event query functions to understand their signatures and return types:

```bash
grep -n "queryModel\|ModelCall\|ModelEscalation\|model_call\|model_escalation" lib/atc/events.ts | head -60
grep -n "queryModel\|ModelCall\|ModelEscalation" lib/event-bus-types.ts | head -40
```

Also check an existing authenticated API route for the auth pattern:

```bash
cat app/api/events/route.ts
```

Note the exact function signatures, parameter types, and return types of `queryModelCallEvents` and `queryModelEscalationEvents`. If these functions do not exist yet in `lib/atc/events.ts`, check `lib/event-bus.ts` for the base query API and implement the lookup using available primitives.

### Step 2: Understand the event data shapes

```bash
grep -n "model_call\|model_escalation\|ModelCall\|ModelEscalation" lib/event-bus-types.ts
grep -n "model_call\|model_escalation" lib/atc/events.ts
```

Understand what fields are available on each event type (e.g., `model`, `cost`, `taskType`, `success`, `stepCount`). The aggregation logic in Step 3 depends on the actual field names.

### Step 3: Create the analytics route

Create `app/api/analytics/model-routing/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth"; // adjust import to match existing auth pattern in repo

// Import event query functions — adjust if signatures differ from what's found in Step 1
// import { queryModelCallEvents, queryModelEscalationEvents } from "@/lib/atc/events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelCostStats {
  totalCost: number;
  callCount: number;
  avgCostPerStep: number;
}

interface DailySpendEntry {
  date: string;   // ISO date string YYYY-MM-DD
  model: string;
  cost: number;
}

interface QualityScoreEntry {
  taskType: string;
  model: string;
  successRate: number;
  totalCalls: number;
}

interface EscalationRateEntry {
  taskType: string;
  escalationCount: number;
  totalCalls: number;
  rate: number;
}

interface ModelRoutingAnalytics {
  perModelCosts: Record<string, ModelCostStats>;
  dailySpend: DailySpendEntry[];
  qualityScores: QualityScoreEntry[];
  escalationRates: EscalationRateEntry[];
}

// ---------------------------------------------------------------------------
// Zero-value analytics (returned when no events exist)
// ---------------------------------------------------------------------------

function emptyAnalytics(): ModelRoutingAnalytics {
  return {
    perModelCosts: {},
    dailySpend: [],
    qualityScores: [],
    escalationRates: [],
  };
}

// ---------------------------------------------------------------------------
// GET /api/analytics/model-routing
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  // Auth check
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Parse query params
  const { searchParams } = req.nextUrl;
  const taskTypeFilter = searchParams.get("taskType") ?? undefined;

  // Default to last 7 days if not provided
  const now = new Date();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 7);

  const startDateParam = searchParams.get("startDate");
  const endDateParam = searchParams.get("endDate");

  const startDate = startDateParam ? new Date(startDateParam) : defaultStart;
  const endDate = endDateParam ? new Date(endDateParam) : now;

  // Guard against invalid dates
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return NextResponse.json(
      { error: "Invalid startDate or endDate" },
      { status: 400 }
    );
  }

  try {
    // Query events — adjust function calls to match actual signatures
    const [callEvents, escalationEvents] = await Promise.all([
      queryModelCallEvents({ startDate, endDate }),
      queryModelEscalationEvents({ startDate, endDate }),
    ]);

    // If no events, return zero-value analytics
    if ((!callEvents || callEvents.length === 0) && (!escalationEvents || escalationEvents.length === 0)) {
      return NextResponse.json(emptyAnalytics());
    }

    // --- perModelCosts & dailySpend ---
    const perModelCosts: Record<string, ModelCostStats & { totalSteps: number }> = {};
    const dailySpendMap: Map<string, number> = new Map(); // key: "YYYY-MM-DD|model"

    for (const event of callEvents ?? []) {
      // Adjust field names to match actual event shape discovered in Step 2
      const model: string = event.model ?? "unknown";
      const cost: number = event.cost ?? 0;
      const stepCount: number = event.stepCount ?? 1;
      const taskType: string = event.taskType ?? "unknown";

      // Apply taskType filter if provided
      if (taskTypeFilter && taskType !== taskTypeFilter) continue;

      // perModelCosts
      if (!perModelCosts[model]) {
        perModelCosts[model] = { totalCost: 0, callCount: 0, avgCostPerStep: 0, totalSteps: 0 };
      }
      perModelCosts[model].totalCost += cost;
      perModelCosts[model].callCount += 1;
      perModelCosts[model].totalSteps += stepCount;

      // dailySpend
      const eventDate = new Date(event.timestamp ?? event.createdAt ?? Date.now());
      const dateKey = eventDate.toISOString().slice(0, 10); // YYYY-MM-DD
      const spendKey = `${dateKey}|${model}`;
      dailySpendMap.set(spendKey, (dailySpendMap.get(spendKey) ?? 0) + cost);
    }

    // Compute avgCostPerStep and strip internal totalSteps
    const perModelCostsFinal: Record<string, ModelCostStats> = {};
    for (const [model, stats] of Object.entries(perModelCosts)) {
      perModelCostsFinal[model] = {
        totalCost: stats.totalCost,
        callCount: stats.callCount,
        avgCostPerStep: stats.totalSteps > 0 ? stats.totalCost / stats.totalSteps : 0,
      };
    }

    // Convert dailySpendMap to array
    const dailySpend: DailySpendEntry[] = [];
    for (const [key, cost] of dailySpendMap.entries()) {
      const [date, model] = key.split("|");
      dailySpend.push({ date, model, cost });
    }
    dailySpend.sort((a, b) => a.date.localeCompare(b.date));

    // --- qualityScores ---
    // key: "taskType|model"
    const qualityMap: Map<string, { successCount: number; totalCalls: number }> = new Map();

    for (const event of callEvents ?? []) {
      const model: string = event.model ?? "unknown";
      const taskType: string = event.taskType ?? "unknown";
      const success: boolean = event.success ?? true;

      if (taskTypeFilter && taskType !== taskTypeFilter) continue;

      const key = `${taskType}|${model}`;
      if (!qualityMap.has(key)) qualityMap.set(key, { successCount: 0, totalCalls: 0 });
      const entry = qualityMap.get(key)!;
      entry.totalCalls += 1;
      if (success) entry.successCount += 1;
    }

    const qualityScores: QualityScoreEntry[] = [];
    for (const [key, stats] of qualityMap.entries()) {
      const [taskType, model] = key.split("|");
      qualityScores.push({
        taskType,
        model,
        successRate: stats.totalCalls > 0 ? stats.successCount / stats.totalCalls : 0,
        totalCalls: stats.totalCalls,
      });
    }

    // --- escalationRates ---
    // key: taskType
    const escalationMap: Map<string, { escalationCount: number; totalCalls: number }> = new Map();

    // Count total calls per taskType (from callEvents)
    for (const event of callEvents ?? []) {
      const taskType: string = event.taskType ?? "unknown";
      if (taskTypeFilter && taskType !== taskTypeFilter) continue;
      if (!escalationMap.has(taskType)) escalationMap.set(taskType, { escalationCount: 0, totalCalls: 0 });
      escalationMap.get(taskType)!.totalCalls += 1;
    }

    // Count escalations per taskType (from escalationEvents)
    for (const event of escalationEvents ?? []) {
      const taskType: string = event.taskType ?? "unknown";
      if (taskTypeFilter && taskType !== taskTypeFilter) continue;
      if (!escalationMap.has(taskType)) escalationMap.set(taskType, { escalationCount: 0, totalCalls: 0 });
      escalationMap.get(taskType)!.escalationCount += 1;
    }

    const escalationRates: EscalationRateEntry[] = [];
    for (const [taskType, stats] of escalationMap.entries()) {
      escalationRates.push({
        taskType,
        escalationCount: stats.escalationCount,
        totalCalls: stats.totalCalls,
        rate: stats.totalCalls > 0 ? stats.escalationCount / stats.totalCalls : 0,
      });
    }

    const analytics: ModelRoutingAnalytics = {
      perModelCosts: perModelCostsFinal,
      dailySpend,
      qualityScores,
      escalationRates,
    };

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("[model-routing analytics] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
```

**Important:** After inspecting the actual function signatures and event field names in Step 1 and Step 2, adjust:
- The import path and function names for `queryModelCallEvents` / `queryModelEscalationEvents`
- The parameter shape passed to those functions (may be `{ startDate, endDate }`, may be separate args, or may take ISO strings)
- The field names on event objects (`event.model`, `event.cost`, `event.taskType`, `event.success`, `event.stepCount`, `event.timestamp`)
- The auth import path (`@/auth` vs `next-auth` vs another pattern — match what existing routes use)

### Step 4: Handle missing query functions gracefully

If `queryModelCallEvents` or `queryModelEscalationEvents` do not exist in `lib/atc/events.ts`, check for a base `queryEvents` function and filter by event type. Example fallback:

```typescript
// Fallback if typed helpers don't exist:
import { queryEvents } from "@/lib/atc/events";
// or from lib/event-bus.ts

const allEvents = await queryEvents({ startDate, endDate });
const callEvents = allEvents.filter(e => e.type === "model_call");
const escalationEvents = allEvents.filter(e => e.type === "model_escalation");
```

If neither `queryModelCallEvents` nor a base `queryEvents` exists, check `lib/event-bus.ts` for the available query API and use it directly.

### Step 5: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Quick smoke test (if dev server available)
# curl "http://localhost:3000/api/analytics/model-routing" -H "Cookie: ..."
```

Resolve any TypeScript errors before proceeding. Common issues:
- Wrong import path for auth
- Wrong parameter types for event query functions
- Event field names that don't match the actual event shape

### Step 6: Commit, push, open PR

```bash
git add app/api/analytics/model-routing/route.ts
git commit -m "feat: add model routing analytics API endpoint"
git push origin feat/model-routing-analytics-api
gh pr create \
  --title "feat: create model routing analytics API endpoint" \
  --body "## Summary

Adds \`GET /api/analytics/model-routing\` endpoint that aggregates model call and escalation events for dashboard consumption.

## Changes
- \`app/api/analytics/model-routing/route.ts\` — new authenticated API route

## Endpoint
- **Method:** GET
- **Auth:** Session required (401 if unauthenticated)
- **Query params:** \`startDate\`, \`endDate\`, \`taskType\` (all optional)
- **Default range:** Last 7 days when dates omitted
- **Response shape:**
  - \`perModelCosts\`: per-model cost aggregation
  - \`dailySpend\`: time-series spend by model
  - \`qualityScores\`: success rates by task type + model
  - \`escalationRates\`: escalation counts and rates by task type
- Returns empty zero-value analytics (not an error) when no events exist

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes

## No conflicts
No overlap with concurrent branch \`fix/create-forceopus-kill-switch-api-and-dashboard-tog\`."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/model-routing-analytics-api
FILES CHANGED: app/api/analytics/model-routing/route.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g., queryModelCallEvents not found in lib/atc/events.ts]
NEXT STEPS: [e.g., implement missing event query helpers, fix field name mismatches]
```

## Escalation Protocol

If the executing agent cannot resolve a blocker autonomously (e.g., `queryModelCallEvents` and `queryModelEscalationEvents` don't exist and no base query API is available, or auth import path cannot be determined):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "create-model-routing-analytics-api-endpoint",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/analytics/model-routing/route.ts"]
    }
  }'
```