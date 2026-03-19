# Agent Forge -- Vercel Spend Monitor Library

## Metadata
- **Branch:** `feat/vercel-spend-monitor`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/vercel-spend-monitor.ts

## Context

Agent Forge needs a module to monitor Vercel API spend and alert on budget thresholds. This library will be used by monitoring/alerting workflows to track costs and prevent surprise overages.

The repo uses Vercel Blob for persistent storage via `lib/storage.ts`. Look at that file to understand the storage patterns before implementing `persistSpendStatus`. The storage module likely exposes functions like `readBlob`, `writeBlob`, or similar — check the actual exports before coding.

The Vercel billing API endpoint for teams is `GET https://api.vercel.com/v2/teams/{teamId}/billing`. Authentication uses a Bearer token via the `VERCEL_API_TOKEN` env var (sometimes `VERCEL_TOKEN` — check existing env usage in the codebase). The team ID comes from `VERCEL_TEAM_ID`.

Relevant env vars already used in the project: `BLOB_READ_WRITE_TOKEN` (Vercel Blob), `AGENT_FORGE_API_SECRET`. The Vercel billing env vars (`VERCEL_API_TOKEN`, `VERCEL_TEAM_ID`) may be new additions — implement defensively.

## Requirements

1. `lib/vercel-spend-monitor.ts` must exist and export the `VercelSpendStatus` type and all three functions.
2. `VercelSpendStatus` type: `{ currentSpend: number; budget: number; percentUsed: number; alertsSent: string[] }` where `alertsSent` is an array of stringified threshold numbers (e.g., `["50", "75"]`).
3. `getSpendStatus()` async function: calls `GET https://api.vercel.com/v2/teams/{teamId}/billing` with `Authorization: Bearer {VERCEL_API_TOKEN}` header and `teamId` from `VERCEL_TEAM_ID`. Parses the response to extract current period spend and billing period budget. Returns `VercelSpendStatus` with `alertsSent` loaded from Blob (or `[]` if not yet persisted). Throws a descriptive error if env vars are missing or the API call fails.
4. `checkSpendThresholds(status: VercelSpendStatus): number[]` — synchronous function that checks which of `[50, 75, 100]` are crossed (i.e., `percentUsed >= threshold`) but not yet in `alertsSent` (as string). Returns array of crossed-but-unalerted threshold numbers.
5. `persistSpendStatus(status: VercelSpendStatus): Promise<void>` — saves the full `VercelSpendStatus` object to Vercel Blob at path `af-data/vercel-spend-status.json` using `lib/storage.ts` patterns.
6. All API errors and parsing errors must be caught and re-thrown with meaningful messages (don't swallow errors silently).
7. Project must compile with `npx tsc --noEmit` and `npm run build`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/vercel-spend-monitor
```

### Step 1: Understand existing storage patterns

Before writing any code, read the storage module to understand the correct API:

```bash
cat lib/storage.ts
```

Note the exact function signatures and import paths. The module likely uses `@vercel/blob` under the hood. Look for functions to read/write JSON blobs — these will be used in `persistSpendStatus` and inside `getSpendStatus` (to load existing `alertsSent`).

Also check if there are any existing fetch wrappers or API client patterns:

```bash
grep -r "VERCEL_API_TOKEN\|VERCEL_TOKEN\|vercel.com/v2" lib/ app/ --include="*.ts" -l 2>/dev/null || echo "No existing Vercel API usage found"
```

### Step 2: Understand the Vercel billing API response shape

The Vercel billing API (`GET https://api.vercel.com/v2/teams/{teamId}/billing`) returns a JSON object. The relevant fields are typically nested under a billing/invoice structure. Implement defensively — the exact shape may vary. Use this approach:

```typescript
// Expected response shape (partial — defensive access required)
interface VercelBillingResponse {
  billing?: {
    plan?: string;
    period?: {
      start?: number; // Unix ms
      end?: number;
    };
    addons?: Array<{ price?: number; quantity?: number }>;
    invoiceItems?: Array<{ price?: number; quantity?: number; name?: string }>;
  };
  // Some versions nest under "plan" or "invoice"
  currentBillingCycleUsage?: number;
  budget?: {
    amount?: number;
    // ...
  };
}
```

Since the exact response shape is uncertain, parse with fallbacks: try multiple field paths, default to `0` for spend if parsing fails, and log a warning. Do NOT throw if spend cannot be parsed — return `{ currentSpend: 0, budget: 0, percentUsed: 0 }` with a console warning so the function remains usable even if Vercel changes their API schema.

### Step 3: Implement lib/vercel-spend-monitor.ts

Create the file with this structure:

```typescript
/**
 * Vercel Spend Monitor
 *
 * Queries the Vercel billing API to track spend against budget thresholds.
 * Used by monitoring workflows to detect and alert on cost overruns.
 *
 * Required env vars:
 *   VERCEL_API_TOKEN - Vercel API Bearer token
 *   VERCEL_TEAM_ID   - Vercel team ID (e.g. "team_xxx")
 */

// Import storage utilities from lib/storage.ts
// (check actual exports from Step 1 before finalizing imports)
import { ... } from "./storage";

export type VercelSpendStatus = {
  currentSpend: number;   // in USD cents or dollars — match Vercel API units
  budget: number;         // total period budget in same units
  percentUsed: number;    // 0-100+ (can exceed 100 if over budget)
  alertsSent: string[];   // e.g. ["50", "75"] — thresholds already alerted
};

const BLOB_KEY = "af-data/vercel-spend-status.json";
const THRESHOLDS = [50, 75, 100];
const VERCEL_API_BASE = "https://api.vercel.com";

/**
 * Loads the previously persisted spend status from Blob.
 * Returns null if not yet persisted.
 */
async function loadPersistedStatus(): Promise<VercelSpendStatus | null> {
  try {
    // Use lib/storage.ts read function — adapt to actual API from Step 1
    // e.g. return await readJson<VercelSpendStatus>(BLOB_KEY);
    //      or: const raw = await getBlob(BLOB_KEY); return JSON.parse(raw);
  } catch {
    return null; // Not yet persisted — fine
  }
}

/**
 * Queries the Vercel billing API and returns current spend status.
 * Merges alertsSent from previously persisted status.
 */
export async function getSpendStatus(): Promise<VercelSpendStatus> {
  const token = process.env.VERCEL_API_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!token) {
    throw new Error("VERCEL_API_TOKEN environment variable is not set");
  }
  if (!teamId) {
    throw new Error("VERCEL_TEAM_ID environment variable is not set");
  }

  const url = `${VERCEL_API_BASE}/v2/teams/${teamId}/billing`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to reach Vercel billing API: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(
      `Vercel billing API returned ${response.status} ${response.statusText}: ${body}`
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(
      `Failed to parse Vercel billing API response as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Parse spend and budget defensively
  const { currentSpend, budget } = parseSpendFromResponse(data);
  const percentUsed = budget > 0 ? (currentSpend / budget) * 100 : 0;

  // Load previously persisted alertsSent
  const persisted = await loadPersistedStatus();
  const alertsSent = persisted?.alertsSent ?? [];

  return {
    currentSpend,
    budget,
    percentUsed,
    alertsSent,
  };
}

/**
 * Extracts spend numbers from the Vercel billing API response.
 * Tries multiple known field paths defensively.
 */
function parseSpendFromResponse(data: unknown): {
  currentSpend: number;
  budget: number;
} {
  if (typeof data !== "object" || data === null) {
    console.warn("[vercel-spend-monitor] Unexpected billing response shape:", data);
    return { currentSpend: 0, budget: 0 };
  }

  const d = data as Record<string, unknown>;

  // Try common field paths — Vercel API shape varies by plan
  // Adapt these based on actual API response observed in production
  let currentSpend = 0;
  let budget = 0;

  // Try top-level fields
  if (typeof d.currentUsage === "number") currentSpend = d.currentUsage;
  if (typeof d.usage === "number") currentSpend = d.usage;

  // Try nested billing object
  const billing = d.billing as Record<string, unknown> | undefined;
  if (billing) {
    if (typeof billing.currentBillingCycleUsage === "number") {
      currentSpend = billing.currentBillingCycleUsage;
    }
    if (typeof billing.balance === "number") currentSpend = billing.balance;
  }

  // Try budget fields
  if (typeof d.billingCycleBudget === "number") budget = d.billingCycleBudget;
  if (billing && typeof (billing as Record<string, unknown>).budget === "number") {
    budget = (billing as Record<string, unknown>).budget as number;
  }

  if (currentSpend === 0 && budget === 0) {
    console.warn(
      "[vercel-spend-monitor] Could not extract spend/budget from response. " +
      "API shape may have changed. Raw response keys:",
      Object.keys(d)
    );
  }

  return { currentSpend, budget };
}

/**
 * Returns threshold numbers that have been crossed but not yet alerted.
 * Thresholds: [50, 75, 100] (percent of budget used).
 */
export function checkSpendThresholds(status: VercelSpendStatus): number[] {
  return THRESHOLDS.filter(
    (threshold) =>
      status.percentUsed >= threshold &&
      !status.alertsSent.includes(String(threshold))
  );
}

/**
 * Persists the current spend status to Vercel Blob.
 * Updates alertsSent so future runs know which alerts have been sent.
 */
export async function persistSpendStatus(status: VercelSpendStatus): Promise<void> {
  try {
    // Use lib/storage.ts write function — adapt to actual API from Step 1
    // e.g. await writeJson(BLOB_KEY, status);
    //      or: await putBlob(BLOB_KEY, JSON.stringify(status, null, 2));
  } catch (err) {
    throw new Error(
      `Failed to persist spend status to Blob at '${BLOB_KEY}': ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}
```

**Important:** Fill in the actual storage calls based on what you found in Step 1. The pseudo-code comments must be replaced with real function calls.

### Step 4: Adapt storage calls to actual lib/storage.ts API

After reading `lib/storage.ts` in Step 1, replace the placeholder storage calls:

- If `lib/storage.ts` exports a generic `getBlob(key: string): Promise<string>` and `putBlob(key: string, value: string): Promise<void>`, use those with `JSON.parse`/`JSON.stringify`.
- If it exports typed helpers like `readJson<T>` and `writeJson`, use those directly.
- If Vercel Blob is used directly via `@vercel/blob`, follow the same pattern as other callers in the codebase.

Check how other files in `lib/` use storage for reference:
```bash
grep -r "storage\|Blob\|putBlob\|getBlob\|writeJson\|readJson" lib/ --include="*.ts" -l | grep -v "storage.ts"
```

Pick one representative file and follow its pattern exactly.

### Step 5: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- The `data as Record<string, unknown>` cast may need refinement if TypeScript strict mode complains
- Storage function return types may need explicit type parameters
- `unknown` traversal requires proper type narrowing

### Step 6: Build check

```bash
npm run build
```

Fix any build errors. This file should not trigger any Next.js build issues since it's a pure library module with no React or route-handler dependencies.

### Step 7: Verification

Confirm the file exists and exports are correct:

```bash
# Check file exists
ls -la lib/vercel-spend-monitor.ts

# Verify exports
grep -E "^export (async function|function|type|const)" lib/vercel-spend-monitor.ts

# Expected output should include:
# export type VercelSpendStatus
# export async function getSpendStatus
# export function checkSpendThresholds
# export async function persistSpendStatus
```

Run a final type check:
```bash
npx tsc --noEmit && echo "TypeScript OK"
npm run build && echo "Build OK"
```

### Step 8: Commit, push, open PR

```bash
git add lib/vercel-spend-monitor.ts
git commit -m "feat: add Vercel spend monitor library

- Implements VercelSpendStatus type with currentSpend, budget, percentUsed, alertsSent
- getSpendStatus() queries Vercel billing API (v2/teams/{teamId}/billing)
- checkSpendThresholds() returns crossed-but-unalerted thresholds [50, 75, 100]
- persistSpendStatus() saves status to Blob at af-data/vercel-spend-status.json
- Defensive parsing with fallbacks for Vercel API response shape variations"

git push origin feat/vercel-spend-monitor

gh pr create \
  --title "feat: Vercel spend monitor library" \
  --body "## Summary

Adds \`lib/vercel-spend-monitor.ts\` for tracking Vercel API spend against budget thresholds.

## Changes
- **\`lib/vercel-spend-monitor.ts\`** (new file)
  - \`VercelSpendStatus\` type exported
  - \`getSpendStatus()\` — queries \`GET https://api.vercel.com/v2/teams/{teamId}/billing\`
  - \`checkSpendThresholds()\` — returns thresholds [50, 75, 100] crossed but not yet alerted
  - \`persistSpendStatus()\` — saves status to Blob at \`af-data/vercel-spend-status.json\`

## Environment Variables Required
- \`VERCEL_API_TOKEN\` — Vercel API Bearer token
- \`VERCEL_TEAM_ID\` — Vercel team ID

## Notes
- Defensive API response parsing (Vercel billing schema varies by plan)
- Loads \`alertsSent\` from Blob on each \`getSpendStatus()\` call to prevent duplicate alerts
- Storage operations use \`lib/storage.ts\` patterns consistent with rest of codebase

## Acceptance Criteria
- [x] \`lib/vercel-spend-monitor.ts\` exists with exported \`VercelSpendStatus\` type
- [x] \`getSpendStatus()\` queries Vercel billing API using \`VERCEL_API_TOKEN\` and \`VERCEL_TEAM_ID\`
- [x] \`checkSpendThresholds()\` returns only thresholds crossed but not yet in \`alertsSent\`
- [x] \`persistSpendStatus()\` saves status to Blob at \`af-data/vercel-spend-status.json\`
- [x] Project compiles successfully"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: partial vercel-spend-monitor implementation"
git push origin feat/vercel-spend-monitor
gh pr create --title "wip: Vercel spend monitor library" --body "Partial implementation — see ISSUES below"
```

2. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/vercel-spend-monitor
FILES CHANGED: lib/vercel-spend-monitor.ts
SUMMARY: [what was completed]
ISSUES: [what failed — e.g. "lib/storage.ts uses @vercel/blob put() directly, not a wrapper — need to update import pattern"]
NEXT STEPS: [e.g. "Replace placeholder storage calls in persistSpendStatus and loadPersistedStatus with actual @vercel/blob put/get calls matching pattern in lib/work-items.ts"]
```

If you hit a blocker you cannot resolve (e.g., Vercel billing API returns 404 for this endpoint and the correct endpoint is unknown, or `lib/storage.ts` has no applicable write function):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "vercel-spend-monitor",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/vercel-spend-monitor.ts"]
    }
  }'
```