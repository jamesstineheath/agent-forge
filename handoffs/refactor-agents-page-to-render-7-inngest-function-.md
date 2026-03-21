# Agent Forge -- Refactor Agents Page to Render 7 Inngest Function Cards

## Metadata
- **Branch:** `feat/refactor-agents-page-inngest-cards`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** app/agents/page.tsx

## Context

The Agents dashboard page currently renders a 4-card layout for the legacy ATC agents. Per ADR-010, the ATC monolith was replaced by 4 autonomous agents, and those agents have since been migrated to Inngest durable step functions (7 total). Recent PRs have built the supporting infrastructure:

- `components/inngest-function-card.tsx` — card component (`InngestFunctionCard`)
- `lib/hooks.ts` — `useInngestStatus()` and `useTriggerInngestFunction()` SWR hooks
- `app/api/agents/inngest-status/route.ts` — status API backing the hook
- `lib/execution-log.ts` — likely contains `INNGEST_FUNCTION_REGISTRY` with the 7 function definitions

The 7 Inngest functions are:
1. `plan-pipeline` (*/10 min)
2. `pipeline-oversight` (*/30 min)
3. `pm-sweep` (daily 08:00 UTC)
4. `housekeeping` (*/6h)
5. `dispatcher-cycle` (*/15 min)
6. `pm-cycle` (*/30 min)
7. `health-monitor-cycle` (*/15 min)

**Concurrent work warning:** Branch `feat/create-inngest-trigger-api-route` is modifying `app/api/agents/inngest-trigger/route.ts`. This handoff only touches `app/agents/page.tsx` — no overlap.

## Requirements

1. `app/agents/page.tsx` renders exactly 7 `InngestFunctionCard` components, one per entry in `INNGEST_FUNCTION_REGISTRY`
2. Each card receives real status data fetched via `useInngestStatus()`, matched by `functionId`
3. Each card's Run Now button is wired via `useTriggerInngestFunction()`
4. Loading state shows 7 skeleton/placeholder cards with fixed dimensions (prevent layout shift)
5. The page shell renders immediately; data populates asynchronously (client component with SWR)
6. Grid is responsive: 1 column on mobile (`grid-cols-1`), 2 on tablet (`sm:grid-cols-2`), 3–4 on desktop (`lg:grid-cols-3` or `xl:grid-cols-4`)
7. The old 4-card layout is fully replaced; no legacy ATC card references remain

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/refactor-agents-page-inngest-cards
```

### Step 1: Inspect existing files

Read these files carefully before writing any code — the exact API shapes matter:

```bash
cat app/agents/page.tsx
cat components/inngest-function-card.tsx
cat lib/hooks.ts
cat lib/execution-log.ts   # find INNGEST_FUNCTION_REGISTRY export
cat app/api/agents/inngest-status/route.ts
```

Key things to confirm:
- The exact export name and shape of `INNGEST_FUNCTION_REGISTRY` (may be in `lib/execution-log.ts` or another file — grep if needed)
- The props interface of `InngestFunctionCard`
- The return shape of `useInngestStatus()` (likely `{ data: InngestStatusMap | InngestStatusArray, isLoading, error }`)
- The signature of `useTriggerInngestFunction()` (likely returns a trigger function that accepts a `functionId`)

```bash
grep -r "INNGEST_FUNCTION_REGISTRY" lib/ app/ --include="*.ts" --include="*.tsx" -l
grep -r "useInngestStatus\|useTriggerInngestFunction" lib/hooks.ts
```

### Step 2: Rewrite `app/agents/page.tsx`

Based on what you found in Step 1, rewrite the page. The template below uses the most likely API shapes — **adjust to match the actual interfaces you found**:

```tsx
'use client';

import { InngestFunctionCard } from '@/components/inngest-function-card';
import { useInngestStatus, useTriggerInngestFunction } from '@/lib/hooks';
// Adjust the import path/name based on what grep found in Step 1
import { INNGEST_FUNCTION_REGISTRY } from '@/lib/execution-log';

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 animate-pulse h-48 w-full" />
  );
}

export default function AgentsPage() {
  const { data: statusData, isLoading, error } = useInngestStatus();
  const { trigger } = useTriggerInngestFunction();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-gray-500 mt-1">
          Inngest durable functions — real-time status and manual triggers
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          Failed to load agent status: {error.message ?? 'Unknown error'}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {isLoading
          ? Array.from({ length: 7 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))
          : INNGEST_FUNCTION_REGISTRY.map((fn) => {
              // statusData may be a map (keyed by functionId) or an array
              // Adjust this lookup based on the actual shape from useInngestStatus
              const status = Array.isArray(statusData)
                ? statusData.find((s) => s.functionId === fn.id)
                : statusData?.[fn.id];

              return (
                <InngestFunctionCard
                  key={fn.id}
                  functionId={fn.id}
                  name={fn.name}
                  cron={fn.cron}
                  status={status}
                  onRunNow={() => trigger(fn.id)}
                />
              );
            })}
      </div>
    </div>
  );
}
```

**Important adaptation rules:**
- If `INNGEST_FUNCTION_REGISTRY` uses a different field name than `id` (e.g., `functionId`, `slug`), adjust the `key`, `functionId`, and lookup accordingly
- If `InngestFunctionCard` has a different props interface, match it exactly — do not invent props
- If `useTriggerInngestFunction()` returns the trigger function directly (not wrapped in `{ trigger }`), adjust the destructuring
- If `useInngestStatus()` has a different return shape, adjust the loading/data access accordingly
- Preserve any existing page-level auth checks, layout wrappers, or `<title>` metadata present in the original file

### Step 3: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `InngestFunctionCard` props mismatch — check the component's interface and align
- `INNGEST_FUNCTION_REGISTRY` type — it may not have a `cron` field; only pass props the component actually accepts
- `status` type — may need a null/undefined guard

### Step 4: Verify build

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 5: Manual visual check (optional but recommended)

If you have a dev server available:
```bash
npm run dev
# Navigate to /agents in a browser and confirm:
# - 7 skeleton cards appear during load
# - 7 real cards render once data loads
# - No console errors
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: refactor agents page to render 7 inngest function cards"
git push origin feat/refactor-agents-page-inngest-cards
gh pr create \
  --title "feat: refactor agents page to render 7 Inngest function cards" \
  --body "$(cat <<'EOF'
## Summary

Refactors \`app/agents/page.tsx\` to replace the legacy 4-card ATC layout with a responsive grid of 7 \`InngestFunctionCard\` components.

## Changes

- **\`app/agents/page.tsx\`**: Rewrote as a client component using \`useInngestStatus()\` and \`useTriggerInngestFunction()\` SWR hooks. Maps over \`INNGEST_FUNCTION_REGISTRY\` to render one card per Inngest function. Loading state renders 7 fixed-dimension skeleton cards to prevent layout shift.

## Acceptance Criteria

- [x] Renders exactly 7 function cards (one per INNGEST_FUNCTION_REGISTRY entry)
- [x] Each card receives real status data from useInngestStatus hook
- [x] Run Now button triggers the corresponding function via useTriggerInngestFunction
- [x] Loading state shows 7 skeleton cards with fixed dimensions (no layout shift)
- [x] Grid is responsive: 1 col mobile, 2 col sm, 3 col lg, 4 col xl

## No conflicts

Only \`app/agents/page.tsx\` was modified. Concurrent branch \`feat/create-inngest-trigger-api-route\` touches \`app/api/agents/inngest-trigger/route.ts\` — no overlap.
EOF
)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/refactor-agents-page-inngest-cards
FILES CHANGED: app/agents/page.tsx
SUMMARY: [what was done]
ISSUES: [what failed — e.g., InngestFunctionCard props interface unclear, INNGEST_FUNCTION_REGISTRY not found at expected path]
NEXT STEPS: [what remains]
```

If the blocker is architectural (e.g., `INNGEST_FUNCTION_REGISTRY` doesn't exist yet, `InngestFunctionCard` has a completely different interface than expected), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "refactor-agents-page-inngest-cards",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/agents/page.tsx"]
    }
  }'
```