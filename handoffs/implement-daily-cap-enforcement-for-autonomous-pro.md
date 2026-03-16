# Agent Forge -- Implement Daily Cap Enforcement for Autonomous Producers

## Metadata
- **Branch:** `feat/daily-cap-enforcement`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/daily-cap.ts, app/api/fast-lane/route.ts, lib/mcp-tools.ts

## Context

Agent Forge's fast-lane endpoint (`app/api/fast-lane/route.ts`) and MCP tool (`lib/mcp-tools.ts`) allow autonomous producers (non-human agents) to create work items. Currently there is no rate limiting on how many items a producer can create per day, which risks runaway automation flooding the pipeline.

This task adds a daily cap system: non-human producers are limited to 3 fast-lane items per day by default (configurable per agent via Blob), with a hard exemption for James-triggered items. The cap resets at UTC midnight and is tracked in Vercel Blob storage.

### Existing patterns to follow

- **Storage**: `lib/storage.ts` exposes `readBlob(path)` and `writeBlob(path, data)` helpers. Look at how `lib/escalation.ts` reads/writes Blob data for the pattern.
- **Fast-lane route**: `app/api/fast-lane/route.ts` — already exists; needs a cap check inserted before work item creation.
- **MCP tools**: `lib/mcp-tools.ts` — `create_fast_lane_item` tool already exists; needs same cap check.
- **Auth**: Fast-lane items carry a `triggeredBy` field. `'james'` is the exempt identity.

## Requirements

1. Create `lib/daily-cap.ts` with three exported async functions:
   - `getDailyCapConfig()`: reads `af-data/config/daily-caps.json` from Blob; returns config with shape `{ defaults: { limit: number }, overrides: Record<string, number> }`. Falls back to `{ defaults: { limit: 3 }, overrides: {} }` if blob doesn't exist.
   - `checkDailyCap(triggeredBy: string): Promise<{ allowed: boolean, remaining: number, limit: number }>`: returns `{ allowed: true, remaining: Infinity, limit: Infinity }` if `triggeredBy === 'james'`. Otherwise reads the agent's daily count from Blob, compares to configured limit, and returns accordingly.
   - `incrementDailyCount(triggeredBy: string): Promise<void>`: increments the agent's count for today in Blob. Does nothing if `triggeredBy === 'james'`. Keys usage by `YYYY-MM-DD` (UTC).

2. Daily usage stored at `af-data/daily-caps/{YYYY-MM-DD}/{triggeredBy}.json` with shape `{ count: number, date: string, agent: string }`.

3. `app/api/fast-lane/route.ts`: Before creating a work item, call `checkDailyCap(triggeredBy)`. If `!allowed`, return HTTP 429 with `{ error: 'daily_cap_exceeded', remaining: 0, limit: N }`. If allowed, call `incrementDailyCount(triggeredBy)` after creating the work item.

4. `lib/mcp-tools.ts`: In `create_fast_lane_item` tool handler, add the same cap check. Return a structured error string (e.g. `"Error: daily cap exceeded (0 remaining of N)"`) if cap is hit. Call `incrementDailyCount` after successful item creation.

5. Default cap is 3 items/day per non-human agent. Blob config at `af-data/config/daily-caps.json` can override per agent.

6. Cap resets automatically by key — each new UTC date starts fresh (no explicit reset logic needed).

7. `'james'` is always exempt; `checkDailyCap('james')` returns `{ allowed: true, remaining: Infinity, limit: Infinity }`.

8. TypeScript must compile with no errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/daily-cap-enforcement
```

### Step 1: Inspect existing storage and fast-lane patterns

Read the relevant files to understand current patterns before writing new code:

```bash
cat lib/storage.ts
cat app/api/fast-lane/route.ts
cat lib/mcp-tools.ts
cat lib/escalation.ts   # reference for blob read/write patterns
```

Note how `readBlob` / `writeBlob` (or equivalent) are called and what they return when a path doesn't exist. Check if there's a `blobExists` or try/catch pattern for missing blobs.

### Step 2: Create `lib/daily-cap.ts`

Create the file with the following structure. Adapt import paths to match what `lib/storage.ts` actually exports.

```typescript
// lib/daily-cap.ts
import { readBlob, writeBlob } from './storage';

const CONFIG_PATH = 'af-data/config/daily-caps.json';

export interface DailyCapConfig {
  defaults: { limit: number };
  overrides: Record<string, number>;
}

export interface CapCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

interface DailyUsage {
  count: number;
  date: string;
  agent: string;
}

function getUtcDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function usagePath(date: string, agent: string): string {
  return `af-data/daily-caps/${date}/${agent}.json`;
}

export async function getDailyCapConfig(): Promise<DailyCapConfig> {
  try {
    const raw = await readBlob(CONFIG_PATH);
    if (!raw) return { defaults: { limit: 3 }, overrides: {} };
    return JSON.parse(raw) as DailyCapConfig;
  } catch {
    return { defaults: { limit: 3 }, overrides: {} };
  }
}

export async function checkDailyCap(triggeredBy: string): Promise<CapCheckResult> {
  if (triggeredBy === 'james') {
    return { allowed: true, remaining: Infinity, limit: Infinity };
  }

  const config = await getDailyCapConfig();
  const limit = config.overrides[triggeredBy] ?? config.defaults.limit;
  const date = getUtcDateString();

  let count = 0;
  try {
    const raw = await readBlob(usagePath(date, triggeredBy));
    if (raw) {
      const usage = JSON.parse(raw) as DailyUsage;
      count = usage.count;
    }
  } catch {
    // No usage record yet — count stays 0
  }

  const remaining = Math.max(0, limit - count);
  return {
    allowed: count < limit,
    remaining,
    limit,
  };
}

export async function incrementDailyCount(triggeredBy: string): Promise<void> {
  if (triggeredBy === 'james') return;

  const date = getUtcDateString();
  const path = usagePath(date, triggeredBy);

  let count = 0;
  try {
    const raw = await readBlob(path);
    if (raw) {
      const usage = JSON.parse(raw) as DailyUsage;
      count = usage.count;
    }
  } catch {
    // No existing record
  }

  const updated: DailyUsage = { count: count + 1, date, agent: triggeredBy };
  await writeBlob(path, JSON.stringify(updated));
}
```

> **Important**: After reading `lib/storage.ts`, adjust the import and function calls to match the actual exported API. If `readBlob` returns `null` vs throwing on missing key, adjust the try/catch/null-check logic accordingly. If the storage module uses a different pattern (e.g., `getBlob`, `putBlob`), use those.

### Step 3: Update `app/api/fast-lane/route.ts`

Add the cap check immediately before work item creation. The exact insertion point depends on the current file structure — read it first, then apply this pattern:

```typescript
// Add to imports at top:
import { checkDailyCap, incrementDailyCount } from '@/lib/daily-cap';

// Inside the POST handler, after extracting `triggeredBy` from the request body
// and before calling the work item creation function:

const capResult = await checkDailyCap(triggeredBy);
if (!capResult.allowed) {
  return NextResponse.json(
    {
      error: 'daily_cap_exceeded',
      remaining: 0,
      limit: capResult.limit,
    },
    { status: 429 }
  );
}

// ... existing work item creation logic ...

// After successful work item creation, increment the count:
await incrementDailyCount(triggeredBy);
```

Make sure `triggeredBy` is extracted from the request body before the cap check. Look at how the existing code reads the request body — it may already parse `triggeredBy`. If the field has a different name in the existing code (e.g., `source`, `createdBy`), use the correct field name but still compare against `'james'`.

### Step 4: Update `lib/mcp-tools.ts`

Add the same cap check in the `create_fast_lane_item` tool handler:

```typescript
// Add to imports at top:
import { checkDailyCap, incrementDailyCount } from './daily-cap';

// Inside the create_fast_lane_item handler, after extracting triggeredBy from args:

const capResult = await checkDailyCap(triggeredBy);
if (!capResult.allowed) {
  return {
    content: [
      {
        type: 'text',
        text: `Error: daily cap exceeded (0 remaining of ${capResult.limit})`,
      },
    ],
    isError: true,
  };
}

// ... existing item creation logic ...

// After successful creation:
await incrementDailyCount(triggeredBy);
```

Look at the existing MCP tool handler pattern — it may use a different return shape. Match the error return format to whatever `isError` pattern already exists in the file.

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- `Infinity` in the return type — if the interface requires `number`, that's fine since `Infinity` is a valid `number` in TypeScript.
- Import path mismatches — double-check `@/lib/daily-cap` vs `./daily-cap` vs `../lib/daily-cap` depending on the file location.
- If `readBlob` / `writeBlob` don't exist with those names, use whatever the actual storage API exports.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add daily cap enforcement for autonomous producers"
git push origin feat/daily-cap-enforcement
gh pr create \
  --title "feat: daily cap enforcement for autonomous producers" \
  --body "## Summary

Adds per-agent daily cap enforcement for fast-lane item creation by non-human producers.

## Changes

- **lib/daily-cap.ts** (new): \`checkDailyCap\`, \`getDailyCapConfig\`, \`incrementDailyCount\` — reads cap config from Blob, tracks daily usage per agent keyed by UTC date.
- **app/api/fast-lane/route.ts**: Returns HTTP 429 with \`{ error: 'daily_cap_exceeded', remaining: 0, limit: N }\` when cap is hit; increments count on success.
- **lib/mcp-tools.ts**: Same cap check in \`create_fast_lane_item\` MCP tool.

## Behavior

- Default cap: 3 items/day per non-human agent
- Configurable via Blob at \`af-data/config/daily-caps.json\`: \`{ defaults: { limit: 3 }, overrides: { 'qa-agent': 5 } }\`
- \`triggeredBy === 'james'\` is always exempt
- Cap resets automatically at UTC midnight (date-keyed storage)
- Usage stored at \`af-data/daily-caps/{YYYY-MM-DD}/{agent}.json\`

## Testing

- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/daily-cap-enforcement
FILES CHANGED: [list modified files]
SUMMARY: [what was implemented]
ISSUES: [what failed or remains]
NEXT STEPS: [what the next agent needs to do]
```

## Escalation

If blocked on an ambiguous requirement (e.g., the `triggeredBy` field name in the fast-lane route is different and the mapping to `'james'` is unclear, or the storage API doesn't match any readable pattern), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "daily-cap-enforcement",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error or ambiguity>",
      "filesChanged": ["lib/daily-cap.ts", "app/api/fast-lane/route.ts", "lib/mcp-tools.ts"]
    }
  }'
```