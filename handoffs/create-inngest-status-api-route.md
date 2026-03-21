# Agent Forge -- Create inngest-status API route

## Metadata
- **Branch:** `feat/inngest-status-api-route`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/agents/inngest-status/route.ts

## Context

The Agent Forge dashboard uses a set of API routes to display health and status for its 7 Inngest durable step functions. Recent work added an `InngestFunctionCard` component (see `components/inngest-function-card.tsx`) and execution logging was integrated into all 7 Inngest functions (see recent PRs for `lib/inngest/dispatcher.ts`, `lib/inngest/health-monitor.ts`, `lib/inngest/pm-cycle.ts`, `lib/inngest/plan-pipeline.ts`, `lib/inngest/pipeline-oversight.ts`, `lib/inngest/pm-sweep.ts`, `lib/inngest/housekeeping.ts`).

This task creates the backend API route that serves `InngestFunctionStatus` data to the dashboard. The route reads execution logs from Vercel Blob via `readAllExecutionLogs()` from `lib/inngest/execution-log.ts`, maps them to a standard status format, and returns a JSON array of 7 objects.

**Auth pattern in this repo:** API routes check for an authenticated session (Auth.js v5 / `next-auth@beta`) OR a `CRON_SECRET` header for machine access. See existing routes like `app/api/agents/atc-metrics/route.ts` or `app/api/agents/tlm-memory/route.ts` for the canonical pattern.

**The 7 Inngest functions** (from `lib/inngest/` and `app/api/inngest/route.ts`):
1. `plan-pipeline` (`lib/inngest/plan-pipeline.ts`)
2. `pipeline-oversight` (`lib/inngest/pipeline-oversight.ts`)
3. `pm-sweep` (`lib/inngest/pm-sweep.ts`)
4. `housekeeping` (`lib/inngest/housekeeping.ts`)
5. `dispatcher-cycle` (`lib/inngest/dispatcher.ts`)
6. `pm-cycle` (`lib/inngest/pm-cycle.ts`)
7. `health-monitor-cycle` (`lib/inngest/health-monitor.ts`)

**No files overlap** with the concurrent work item on branch `fix/integration-test-end-to-end-spike-lifecycle-valida` (which only touches `lib/__tests__/spike-lifecycle.test.ts`).

## Requirements

1. Create `app/api/agents/inngest-status/route.ts` with an exported `GET` handler
2. The handler must authenticate requests via session OR `CRON_SECRET` header, returning 401 if neither is present
3. Call `readAllExecutionLogs()` from `lib/inngest/execution-log.ts` to fetch all 7 execution logs in parallel
4. Map each log result to an `InngestFunctionStatus` object containing at minimum: `functionId`, `functionName`, `status`, and `lastRunAt`
5. If a log is `null` or the read throws, return `status: 'idle'` and `lastRunAt: null` for that function (never let one failure break the whole response)
6. Return a JSON array of exactly 7 `InngestFunctionStatus` objects with HTTP 200
7. All 7 Blob reads must happen in parallel (not sequentially) — use `Promise.all` or `Promise.allSettled`
8. Response time must be kept under 1 second by using parallel reads
9. Handle the case where `readAllExecutionLogs` itself doesn't exist yet — inspect `lib/inngest/execution-log.ts` first and adapt accordingly

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/inngest-status-api-route
```

### Step 1: Inspect existing execution log infrastructure

Before writing any code, read the relevant files to understand the exact APIs and types available:

```bash
cat lib/inngest/execution-log.ts
```

Look for:
- The exact export name(s): is it `readAllExecutionLogs`, `getExecutionLog`, or similar?
- The `InngestFunctionStatus` type — is it defined here, in `lib/types.ts`, or elsewhere?
- What shape does a single execution log entry have? (fields like `status`, `lastRunAt`, `functionId`, `functionName`, etc.)
- The list of function IDs used as keys

Also check for existing similar routes to understand the auth pattern:

```bash
cat app/api/agents/atc-metrics/route.ts
# or
cat app/api/agents/tlm-memory/route.ts
```

And check what hooks exist for this endpoint:
```bash
grep -r "inngest-status" lib/hooks.ts app/ --include="*.ts" --include="*.tsx" 2>/dev/null
```

### Step 2: Understand the InngestFunctionStatus type

```bash
grep -r "InngestFunctionStatus" lib/ app/ components/ --include="*.ts" --include="*.tsx" -l
grep -r "InngestFunctionStatus" lib/ app/ components/ --include="*.ts" --include="*.tsx"
```

This will show you the exact shape expected. If the type is not yet defined, you will need to define it inline or in the route file based on what `InngestFunctionCard` expects:

```bash
cat components/inngest-function-card.tsx
```

### Step 3: Implement the route

Create `app/api/agents/inngest-status/route.ts`. Below is a reference implementation — **adapt it based on what you find in Step 1 and Step 2**:

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/auth';  // Auth.js v5 — adjust import if different in this repo
import { readAllExecutionLogs } from '@/lib/inngest/execution-log';

// Adapt this type to match whatever InngestFunctionStatus is defined as in the codebase
// If already exported from lib/inngest/execution-log.ts or lib/types.ts, import it instead
interface InngestFunctionStatus {
  functionId: string;
  functionName: string;
  status: string;   // e.g. 'idle' | 'running' | 'completed' | 'failed' — use whatever the type defines
  lastRunAt: string | null;
}

export async function GET(request: Request) {
  // Auth check: session OR CRON_SECRET header
  const session = await auth();
  const cronSecret = request.headers.get('x-cron-secret') 
    ?? request.headers.get('authorization')?.replace('Bearer ', '');
  
  if (!session && cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Read all 7 logs in parallel, catching individual failures
  let allLogs: Awaited<ReturnType<typeof readAllExecutionLogs>>;
  try {
    allLogs = await readAllExecutionLogs();
  } catch (err) {
    console.error('[inngest-status] readAllExecutionLogs failed:', err);
    // Return all-idle if the bulk read itself fails
    // We need the function list — copy from execution-log.ts if exported, else hardcode
    return NextResponse.json(getFallbackStatuses());
  }

  // Map to InngestFunctionStatus[]
  // allLogs is expected to be a Record<string, ExecutionLog | null> or similar
  // Adjust based on actual return type
  const statuses: InngestFunctionStatus[] = Object.entries(allLogs).map(
    ([functionId, log]) => {
      if (!log) {
        return {
          functionId,
          functionName: getFunctionName(functionId),
          status: 'idle',
          lastRunAt: null,
        };
      }
      return {
        functionId,
        functionName: log.functionName ?? getFunctionName(functionId),
        status: deriveStatus(log),
        lastRunAt: log.lastRunAt ?? log.completedAt ?? log.startedAt ?? null,
      };
    }
  );

  return NextResponse.json(statuses);
}

// Derive a human-readable status from the log entry.
// Adapt field names to match the actual ExecutionLog shape.
function deriveStatus(log: Record<string, unknown>): string {
  if (typeof log.status === 'string') return log.status;
  if (log.error || log.failed) return 'failed';
  if (log.completedAt) return 'completed';
  if (log.startedAt && !log.completedAt) return 'running';
  return 'idle';
}

// Human-readable names for each Inngest function ID
function getFunctionName(functionId: string): string {
  const names: Record<string, string> = {
    'plan-pipeline': 'Plan Pipeline',
    'pipeline-oversight': 'Pipeline Oversight',
    'pm-sweep': 'PM Sweep',
    'housekeeping': 'Housekeeping',
    'dispatcher-cycle': 'Dispatcher',
    'pm-cycle': 'PM Cycle',
    'health-monitor-cycle': 'Health Monitor',
  };
  return names[functionId] ?? functionId;
}

// Fallback: return all-idle statuses for all 7 functions
function getFallbackStatuses(): InngestFunctionStatus[] {
  const functionIds = [
    'plan-pipeline',
    'pipeline-oversight',
    'pm-sweep',
    'housekeeping',
    'dispatcher-cycle',
    'pm-cycle',
    'health-monitor-cycle',
  ];
  return functionIds.map((functionId) => ({
    functionId,
    functionName: getFunctionName(functionId),
    status: 'idle',
    lastRunAt: null,
  }));
}
```

**Important adaptations to make:**
- Import `auth` using whatever the existing auth import pattern is in this repo (check other route files)
- Import `InngestFunctionStatus` from wherever it's defined if it already exists — don't redefine it
- If `readAllExecutionLogs()` returns an array instead of a record, map accordingly
- If `readAllExecutionLogs()` doesn't exist but per-function `readExecutionLog(functionId)` does, use `Promise.allSettled` across all 7 IDs manually (see alternative below)

**Alternative if only per-function reads exist:**
```typescript
const FUNCTION_IDS = [
  'plan-pipeline',
  'pipeline-oversight', 
  'pm-sweep',
  'housekeeping',
  'dispatcher-cycle',
  'pm-cycle',
  'health-monitor-cycle',
] as const;

// Use Promise.allSettled so one failure doesn't fail all
const results = await Promise.allSettled(
  FUNCTION_IDS.map((id) => readExecutionLog(id))
);

const statuses: InngestFunctionStatus[] = FUNCTION_IDS.map((functionId, i) => {
  const result = results[i];
  if (result.status === 'rejected' || result.value === null) {
    return { functionId, functionName: getFunctionName(functionId), status: 'idle', lastRunAt: null };
  }
  const log = result.value;
  return {
    functionId,
    functionName: log.functionName ?? getFunctionName(functionId),
    status: deriveStatus(log),
    lastRunAt: log.lastRunAt ?? log.completedAt ?? log.startedAt ?? null,
  };
});
```

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- Wrong auth import path — check `app/api/agents/atc-metrics/route.ts` for the exact import
- Mismatch between actual `ExecutionLog` field names and what the implementation uses
- `InngestFunctionStatus` type mismatch if it's already defined elsewhere with different fields

### Step 5: Verify build passes

```bash
npm run build
```

### Step 6: Run tests

```bash
npm test 2>/dev/null || true
```

No new tests are required for this work item, but ensure existing tests still pass.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add GET /api/agents/inngest-status route for dashboard"
git push origin feat/inngest-status-api-route
gh pr create \
  --title "feat: create inngest-status API route" \
  --body "## Summary

Creates \`GET /api/agents/inngest-status\` — the API route the dashboard uses to fetch real-time status for all 7 Inngest durable functions.

## Changes
- \`app/api/agents/inngest-status/route.ts\`: New GET handler

## Behavior
- Reads all 7 execution logs in parallel via \`readAllExecutionLogs()\` (or \`Promise.allSettled\` over per-function reads if bulk API not available)
- Maps each log to an \`InngestFunctionStatus\` object with \`functionId\`, \`functionName\`, \`status\`, and \`lastRunAt\`
- Individual Blob read failures return \`status: 'idle'\` instead of failing the request
- Auth: session OR \`CRON_SECRET\` header required

## Acceptance Criteria
- [x] GET /api/agents/inngest-status returns a JSON array of exactly 7 InngestFunctionStatus objects
- [x] Each status object contains functionId, functionName, status, and lastRunAt fields
- [x] Functions with no execution log return status 'idle' and lastRunAt null
- [x] All 7 Blob reads happen in parallel via Promise.all / Promise.allSettled
- [x] Individual Blob read failures return 'idle' status for that function rather than failing the entire request"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/inngest-status-api-route
FILES CHANGED: [app/api/agents/inngest-status/route.ts]
SUMMARY: [what was done]
ISSUES: [what failed — e.g. "readAllExecutionLogs not found in execution-log.ts, needs investigation"]
NEXT STEPS: [e.g. "Implement readAllExecutionLogs in lib/inngest/execution-log.ts first, then retry this route"]
```

If `lib/inngest/execution-log.ts` does not exist at all, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "inngest-status-api-route",
    "reason": "lib/inngest/execution-log.ts does not exist — cannot implement readAllExecutionLogs dependency. A prior work item must create execution-log.ts before this route can be built.",
    "confidenceScore": 0.1,
    "contextSnapshot": {
      "step": "1",
      "error": "lib/inngest/execution-log.ts not found",
      "filesChanged": []
    }
  }'
```