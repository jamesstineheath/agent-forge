# Agent Forge -- Implement cost tracking storage and recording utilities

## Metadata
- **Branch:** `feat/cost-tracking-storage`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/cost-tracking.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that dispatches AI agents to target repos. The platform needs cost tracking to monitor per-API-call expenditures across work items, agents, and repos.

The existing storage layer (`lib/storage.ts`) provides Vercel Blob CRUD helpers. Cost data should be stored in daily blob files at `af-data/costs/YYYY-MM-DD.json`, each containing an array of `CostEntry` objects. The `CostEntry` type was recently defined in `lib/types.ts` as part of the evaluation metrics work.

Check `lib/types.ts` for the existing `CostEntry` type definition before implementing — it likely has fields like `workItemId`, `agentName`/`agent`, `repo`, `inputTokens`, `outputTokens`, `costUsd`, `model`, and `timestamp`. Match whatever is defined there exactly.

The pattern for read-modify-write in this codebase uses the blob helpers from `lib/storage.ts`. Look at how other files like `lib/work-items.ts` or `lib/escalation.ts` use `readBlob`/`writeBlob` or similar functions to understand the exact API.

## Requirements

1. `lib/cost-tracking.ts` must export: `recordCost`, `getCostsForWorkItem`, `getCostsForPeriod`, `aggregateCosts`, `estimateCostFromTokens`
2. `recordCost(entry: CostEntry): Promise<void>` — reads existing daily blob at `af-data/costs/YYYY-MM-DD.json` (using entry's date or today), appends entry, writes back
3. `getCostsForWorkItem(workItemId: string): Promise<CostEntry[]>` — scans the last 30 days of daily files, returns entries matching `workItemId`
4. `getCostsForPeriod(startDate: string, endDate: string): Promise<CostEntry[]>` — returns all entries from `af-data/costs/YYYY-MM-DD.json` for each date in the inclusive range
5. `aggregateCosts(entries: CostEntry[]): { totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, byAgent: Record<string, number>, byRepo: Record<string, number> }` — pure function, no async
6. `estimateCostFromTokens(inputTokens: number, outputTokens: number, model?: string): number` — applies model-based pricing:
   - Default (sonnet, `claude-sonnet-4-20250514`): $3/M input tokens, $15/M output tokens
   - Opus (`claude-opus-4-20250514`): $15/M input tokens, $75/M output tokens
   - `estimateCostFromTokens(1000000, 500000)` must return `3 * 1 + 15 * 0.5 = 10.5`
7. Daily files missing from blob storage should be treated as empty arrays (graceful 404 handling)
8. All date arithmetic must be UTC
9. Project builds successfully with `npm run build`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/cost-tracking-storage
```

### Step 1: Inspect existing types and storage helpers

Read the existing files to understand exact interfaces before writing any code:

```bash
cat lib/types.ts | grep -A 30 "CostEntry"
cat lib/storage.ts
```

Note:
- The exact field names on `CostEntry` (e.g., is it `agent` or `agentName`? `repo` or `repoName`?)
- The storage API: what functions are exported from `lib/storage.ts`? Common patterns: `getBlob(path)`, `putBlob(path, data)`, or `readJsonBlob`, `writeJsonBlob`. Use whatever exists.
- Whether there's a pattern for handling "not found" (404) on reads

Also check for any existing cost-related code:
```bash
grep -r "CostEntry\|cost-tracking\|af-data/costs" lib/ app/ --include="*.ts" --include="*.tsx" -l
```

### Step 2: Implement `lib/cost-tracking.ts`

Create `lib/cost-tracking.ts`. Use the actual field names from `CostEntry` in `lib/types.ts` and the actual storage function signatures from `lib/storage.ts`.

The implementation should follow this structure (adapt imports/field names to match reality):

```typescript
import { CostEntry } from './types';
// Import whatever storage helpers exist — e.g.:
// import { getBlob, putBlob } from './storage';
// or: import { readJsonBlob, writeJsonBlob } from './storage';

// ─── Pricing ────────────────────────────────────────────────────────────────

const PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-sonnet-4-20250514': { inputPerM: 3, outputPerM: 15 },
  'claude-opus-4-20250514': { inputPerM: 15, outputPerM: 75 },
};

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function estimateCostFromTokens(
  inputTokens: number,
  outputTokens: number,
  model?: string
): number {
  const pricing = PRICING[model ?? DEFAULT_MODEL] ?? PRICING[DEFAULT_MODEL];
  return (inputTokens / 1_000_000) * pricing.inputPerM +
         (outputTokens / 1_000_000) * pricing.outputPerM;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function blobPath(dateStr: string): string {
  return `af-data/costs/${dateStr}.json`;
}

function dateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cur <= end) {
    dates.push(toDateString(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

async function readDailyFile(dateStr: string): Promise<CostEntry[]> {
  try {
    // Use whatever storage helper exists. Example:
    const data = await getBlob(blobPath(dateStr));
    if (!data) return [];
    return JSON.parse(data) as CostEntry[];
  } catch {
    return [];
  }
}

async function writeDailyFile(dateStr: string, entries: CostEntry[]): Promise<void> {
  await putBlob(blobPath(dateStr), JSON.stringify(entries));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function recordCost(entry: CostEntry): Promise<void> {
  // Derive date from entry's timestamp field (check actual field name)
  const dateStr = toDateString(new Date(entry.timestamp));
  const existing = await readDailyFile(dateStr);
  existing.push(entry);
  await writeDailyFile(dateStr, existing);
}

export async function getCostsForWorkItem(workItemId: string): Promise<CostEntry[]> {
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setUTCDate(today.getUTCDate() - 30);
  const dates = dateRange(toDateString(thirtyDaysAgo), toDateString(today));
  const results = await Promise.all(dates.map(readDailyFile));
  return results.flat().filter(e => e.workItemId === workItemId);
}

export async function getCostsForPeriod(
  startDate: string,
  endDate: string
): Promise<CostEntry[]> {
  const dates = dateRange(startDate, endDate);
  const results = await Promise.all(dates.map(readDailyFile));
  return results.flat();
}

export function aggregateCosts(entries: CostEntry[]): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byAgent: Record<string, number>;
  byRepo: Record<string, number>;
} {
  const byAgent: Record<string, number> = {};
  const byRepo: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const entry of entries) {
    totalInputTokens += entry.inputTokens ?? 0;
    totalOutputTokens += entry.outputTokens ?? 0;
    totalCostUsd += entry.costUsd ?? 0;

    // Use actual field names from CostEntry — adjust 'agent' and 'repo' below
    if (entry.agent) {
      byAgent[entry.agent] = (byAgent[entry.agent] ?? 0) + (entry.costUsd ?? 0);
    }
    if (entry.repo) {
      byRepo[entry.repo] = (byRepo[entry.repo] ?? 0) + (entry.costUsd ?? 0);
    }
  }

  return { totalInputTokens, totalOutputTokens, totalCostUsd, byAgent, byRepo };
}
```

**Important:** After writing the skeleton, verify field names match `CostEntry` in `lib/types.ts`. Common mismatches to check:
- `entry.timestamp` vs `entry.createdAt` vs `entry.date`
- `entry.agent` vs `entry.agentName`
- `entry.repo` vs `entry.repoName` vs `entry.repository`
- `entry.inputTokens` vs `entry.input_tokens`
- `entry.costUsd` vs `entry.cost` vs `entry.totalCost`

Adjust every field reference in your implementation to match the actual type.

### Step 3: Verify storage function signatures

After writing the initial file, check that the storage imports compile. The storage module likely exports one of these patterns:

**Pattern A** — generic blob read/write:
```typescript
import { getBlob, putBlob } from './storage';
// getBlob(path: string): Promise<string | null>
// putBlob(path: string, content: string): Promise<void>
```

**Pattern B** — JSON-typed helpers:
```typescript
import { readJsonBlob, writeJsonBlob } from './storage';
// readJsonBlob<T>(path: string): Promise<T | null>
// writeJsonBlob<T>(path: string, data: T): Promise<void>
```

**Pattern C** — Vercel Blob direct with re-exports:
```typescript
import { put, head, list } from '@vercel/blob';
```

Adapt `readDailyFile` and `writeDailyFile` to match the actual exported API. If `storage.ts` uses `@vercel/blob` directly, follow that same pattern. Handle the "not found" case (return `[]`).

### Step 4: TypeScript check and build

```bash
npx tsc --noEmit
```

Fix any type errors. Then:

```bash
npm run build
```

Fix any build errors. Common issues:
- Field name mismatches between `CostEntry` fields and what you reference
- Storage function signature mismatch
- Missing `async` on a function that uses `await`
- `Promise.all` type inference issues — add explicit `Promise<CostEntry[][]>` if needed

### Step 5: Verify acceptance criteria manually

```bash
node -e "
const { estimateCostFromTokens, aggregateCosts } = require('./lib/cost-tracking');

// Test 1: estimateCostFromTokens(1000000, 500000) should return 10.5
const cost = estimateCostFromTokens(1000000, 500000);
console.log('estimateCostFromTokens(1M, 500K) =', cost, cost === 10.5 ? 'PASS' : 'FAIL');

// Test 2: aggregateCosts grouping
const entries = [
  { agent: 'tlm-review', repo: 'personal-assistant', inputTokens: 100, outputTokens: 50, costUsd: 1.5 },
  { agent: 'tlm-review', repo: 'agent-forge', inputTokens: 200, outputTokens: 100, costUsd: 2.0 },
  { agent: 'orchestrator', repo: 'personal-assistant', inputTokens: 50, outputTokens: 25, costUsd: 0.5 },
];
const agg = aggregateCosts(entries);
console.log('aggregateCosts byAgent:', agg.byAgent);
console.log('aggregateCosts totalCostUsd:', agg.totalCostUsd, agg.totalCostUsd === 4.0 ? 'PASS' : 'FAIL');
" 2>/dev/null || echo "(Note: CJS require may not work in ESM project — rely on tsc check instead)"
```

If the project uses ESM modules, the `node -e` check may not work — that's fine as long as `tsc --noEmit` and `npm run build` pass.

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Both must succeed with no errors.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: implement cost tracking storage and recording utilities"
git push origin feat/cost-tracking-storage
gh pr create \
  --title "feat: implement cost tracking storage and recording utilities" \
  --body "## Summary

Adds \`lib/cost-tracking.ts\` with cost data persistence and aggregation utilities.

## What's added

- \`recordCost(entry)\` — appends a \`CostEntry\` to a daily blob file at \`af-data/costs/YYYY-MM-DD.json\` via read-modify-write
- \`getCostsForWorkItem(workItemId)\` — scans last 30 days of daily files, filters by workItemId
- \`getCostsForPeriod(startDate, endDate)\` — returns all entries in an inclusive date range
- \`aggregateCosts(entries)\` — pure aggregation: totalInputTokens, totalOutputTokens, totalCostUsd, byAgent, byRepo
- \`estimateCostFromTokens(inputTokens, outputTokens, model?)\` — applies model pricing (sonnet default: \$3/M in, \$15/M out; opus: \$15/M in, \$75/M out)

## Pricing verification

\`estimateCostFromTokens(1_000_000, 500_000)\` = \`3 * 1 + 15 * 0.5\` = \`10.5\` ✓

## Storage pattern

Daily blob files (\`af-data/costs/YYYY-MM-DD.json\`) are JSON arrays of CostEntry. Missing files are treated as empty arrays. All date arithmetic is UTC.

## Checklist
- [x] All 5 functions exported from lib/cost-tracking.ts
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/cost-tracking-storage
FILES CHANGED: lib/cost-tracking.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "CostEntry type not found in lib/types.ts", "storage.ts has no getBlob export"]
NEXT STEPS: [what remains — e.g., "Define CostEntry type in lib/types.ts first", "Update storage imports to match actual API"]
```

## Escalation

If you encounter a blocker that cannot be resolved autonomously (e.g., `CostEntry` is not defined anywhere in the codebase, `lib/storage.ts` has no usable read/write functions, or the project has TypeScript errors unrelated to this file that block the build):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "implement-cost-tracking-storage",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/cost-tracking.ts"]
    }
  }'
```