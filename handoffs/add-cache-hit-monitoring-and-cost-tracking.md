# Agent Forge -- Add Cache Hit Monitoring and Cost Tracking

## Metadata
- **Branch:** `feat/cache-hit-monitoring`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/cache-metrics.ts, lib/atc.ts

## Context

Agent Forge uses the Anthropic Claude API with prompt caching enabled across several endpoints (orchestrator, ATC monitoring, etc.). The Anthropic API returns cache usage data in the `usage` object of every response:
- `input_tokens` — uncached input tokens (full price)
- `cache_creation_input_tokens` — tokens written to cache (1.25x base price)
- `cache_read_input_tokens` — tokens read from cache (0.1x base price)
- `output_tokens` — output tokens (full price)

The goal is to add a lightweight observability layer that:
1. Extracts cache metrics from Anthropic API responses
2. Persists them to Vercel Blob at `af-data/cache-metrics/YYYY-MM-DD.json`
3. Summarizes cache effectiveness in each ATC monitoring cycle

The repo uses Vercel Blob for storage (see `lib/storage.ts` for existing patterns). TypeScript strict mode is assumed. The AI SDK used is `@ai-sdk/anthropic` + `ai`, so Anthropic responses come back via the `generateText` / `streamText` result objects which expose `usage` (and potentially `experimental_providerMetadata` for cache fields).

Check existing `lib/storage.ts` to understand how blob reads/writes are done — use the same `BLOB_READ_WRITE_TOKEN` pattern.

## Requirements

1. `lib/cache-metrics.ts` must export the `CacheMetrics` interface with fields: `endpoint`, `timestamp`, `inputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `outputTokens`
2. `extractCacheMetrics(response, endpoint)` must read `cache_creation_input_tokens` and `cache_read_input_tokens` from the Anthropic response usage object (handle missing fields gracefully with 0 defaults)
3. `calculateSavings(metrics)` must return `{ savingsPercent, cachedTokens, uncachedTokens }` using correct pricing ratios: cache reads = 0.1x, cache writes = 1.25x base price
4. `logCacheMetrics(metrics)` must append to daily log at `af-data/cache-metrics/YYYY-MM-DD.json` in Vercel Blob (read existing array, push new entry, write back)
5. `lib/atc.ts` must import and call a new `summarizeDailyCacheMetrics()` function (defined in `lib/cache-metrics.ts`) during its monitoring cycle — log total cached tokens, hit rate, and estimated savings to console
6. TypeScript must compile with no errors (`npx tsc --noEmit`)
7. All new code must handle errors gracefully (storage failures must not crash the ATC cycle)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/cache-hit-monitoring
```

### Step 1: Inspect existing storage patterns

Read `lib/storage.ts` to understand blob read/write patterns, then read `lib/atc.ts` to find the monitoring cycle location.

```bash
cat lib/storage.ts
cat lib/atc.ts
```

Note the blob client initialization and any helper functions (e.g., `readBlob`, `writeBlob`). You will replicate those patterns in `lib/cache-metrics.ts`.

### Step 2: Create `lib/cache-metrics.ts`

Create the file with the following complete implementation. Adapt blob client initialization to match exactly what `lib/storage.ts` does.

```typescript
import { put, head, list } from "@vercel/blob";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheMetrics {
  endpoint: string;
  timestamp: string; // ISO 8601
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

// Shape of the Anthropic usage object as returned by the AI SDK.
// The cache fields may be on `usage` directly or nested under
// experimental_providerMetadata.anthropic — handle both.
export interface AnthropicResponseLike {
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    // Direct fields (some SDK versions surface these)
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  // AI SDK v3 surfaces provider-specific fields here
  experimental_providerMetadata?: {
    anthropic?: {
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    };
  };
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Extract cache metrics from an Anthropic API response.
 * Handles both direct usage fields and AI SDK provider metadata.
 */
export function extractCacheMetrics(
  response: AnthropicResponseLike,
  endpoint: string
): CacheMetrics {
  const usage = response.usage ?? {};
  const providerMeta =
    response.experimental_providerMetadata?.anthropic ?? {};

  // Cache creation tokens — try provider metadata first, then direct field
  const cacheCreationInputTokens =
    providerMeta.cacheCreationInputTokens ??
    usage.cache_creation_input_tokens ??
    0;

  // Cache read tokens
  const cacheReadInputTokens =
    providerMeta.cacheReadInputTokens ??
    usage.cache_read_input_tokens ??
    0;

  // Standard token counts — AI SDK uses camelCase aliases
  const inputTokens =
    usage.input_tokens ?? usage.promptTokens ?? 0;
  const outputTokens =
    usage.output_tokens ?? usage.completionTokens ?? 0;

  return {
    endpoint,
    timestamp: new Date().toISOString(),
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
  };
}

/**
 * Calculate cost savings from cache usage.
 *
 * Pricing ratios relative to base input token price:
 *   - Regular input tokens:       1.0x
 *   - Cache creation tokens:      1.25x  (writing to cache costs more)
 *   - Cache read tokens:          0.1x   (reading from cache is 10x cheaper)
 *
 * savingsPercent = how much cheaper the actual bill was vs if all tokens
 * were charged at base price.
 */
export function calculateSavings(metrics: CacheMetrics): {
  savingsPercent: number;
  cachedTokens: number;
  uncachedTokens: number;
} {
  const {
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
  } = metrics;

  const cachedTokens = cacheReadInputTokens;
  const uncachedTokens = inputTokens + cacheCreationInputTokens;

  // Cost if all input tokens charged at base price (1.0x)
  const totalInputTokens =
    inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const hypotheticalCost = totalInputTokens; // in units of "1 token at base price"

  // Actual cost in the same units
  const actualCost =
    inputTokens * 1.0 +
    cacheCreationInputTokens * 1.25 +
    cacheReadInputTokens * 0.1;

  const savings = hypotheticalCost - actualCost;
  const savingsPercent =
    hypotheticalCost > 0
      ? Math.round((savings / hypotheticalCost) * 10000) / 100
      : 0;

  return { savingsPercent, cachedTokens, uncachedTokens };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function getDailyBlobPath(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `af-data/cache-metrics/${today}.json`;
}

/**
 * Append a CacheMetrics record to today's daily log in Vercel Blob.
 * Reads the existing array (if any), pushes the new entry, writes back.
 * Errors are caught and logged — never throws.
 */
export async function logCacheMetrics(metrics: CacheMetrics): Promise<void> {
  const blobPath = getDailyBlobPath();

  try {
    // Attempt to read existing entries for today
    let entries: CacheMetrics[] = [];

    try {
      const existing = await head(blobPath, {
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (existing?.url) {
        const res = await fetch(existing.url);
        if (res.ok) {
          const text = await res.text();
          entries = JSON.parse(text) as CacheMetrics[];
        }
      }
    } catch {
      // File doesn't exist yet — start with empty array
    }

    entries.push(metrics);

    await put(blobPath, JSON.stringify(entries, null, 2), {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false,
      contentType: "application/json",
    });
  } catch (err) {
    console.error("[cache-metrics] Failed to log metrics:", err);
    // Swallow error — observability failures must not crash callers
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * Read today's cache metrics from Vercel Blob and log a human-readable
 * summary. Intended to be called from the ATC monitoring cycle.
 * Never throws.
 */
export async function summarizeDailyCacheMetrics(): Promise<void> {
  const blobPath = getDailyBlobPath();
  const today = new Date().toISOString().slice(0, 10);

  try {
    let entries: CacheMetrics[] = [];

    try {
      const existing = await head(blobPath, {
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (existing?.url) {
        const res = await fetch(existing.url);
        if (res.ok) {
          const text = await res.text();
          entries = JSON.parse(text) as CacheMetrics[];
        }
      }
    } catch {
      // No data yet today
    }

    if (entries.length === 0) {
      console.log(`[ATC cache-metrics] No cache metrics recorded for ${today}`);
      return;
    }

    // Aggregate
    let totalInput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;
    let totalOutput = 0;

    for (const e of entries) {
      totalInput += e.inputTokens;
      totalCacheCreation += e.cacheCreationInputTokens;
      totalCacheRead += e.cacheReadInputTokens;
      totalOutput += e.outputTokens;
    }

    const totalAllInput = totalInput + totalCacheCreation + totalCacheRead;
    const hitRate =
      totalAllInput > 0
        ? Math.round((totalCacheRead / totalAllInput) * 10000) / 100
        : 0;

    // Aggregate savings
    const aggregateMetrics: CacheMetrics = {
      endpoint: "aggregate",
      timestamp: new Date().toISOString(),
      inputTokens: totalInput,
      cacheCreationInputTokens: totalCacheCreation,
      cacheReadInputTokens: totalCacheRead,
      outputTokens: totalOutput,
    };
    const { savingsPercent } = calculateSavings(aggregateMetrics);

    // Endpoint breakdown
    const byEndpoint: Record<string, number> = {};
    for (const e of entries) {
      byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] ?? 0) + 1;
    }

    console.log(
      `[ATC cache-metrics] Daily summary (${today}) — ` +
        `${entries.length} calls | ` +
        `cache hit rate: ${hitRate}% | ` +
        `cached tokens: ${totalCacheRead.toLocaleString()} | ` +
        `estimated savings: ${savingsPercent}% vs full price | ` +
        `endpoints: ${Object.entries(byEndpoint)
          .map(([ep, n]) => `${ep}(${n})`)
          .join(", ")}`
    );
  } catch (err) {
    console.error("[ATC cache-metrics] Failed to summarize metrics:", err);
  }
}
```

### Step 3: Integrate into `lib/atc.ts`

Open `lib/atc.ts` and find the main monitoring cycle function (likely called `runATCCycle`, `atcMonitor`, or similar — look for the exported function that Vercel cron calls, or the internal cycle loop).

Add the import at the top of the file:
```typescript
import { summarizeDailyCacheMetrics } from "./cache-metrics";
```

Then, inside the monitoring cycle function, add a call to `summarizeDailyCacheMetrics()` near the end of the cycle (after the main work is done, before returning). Wrap it so it never throws:

```typescript
// Cache metrics summary (observability)
await summarizeDailyCacheMetrics().catch((err) =>
  console.error("[ATC] cache metrics summary failed:", err)
);
```

Use the exact import style (`./cache-metrics`) consistent with other imports in `lib/atc.ts` (check whether they use `.js` extensions or not).

### Step 4: Check for existing blob helper pattern

After reviewing `lib/storage.ts`, if there is a shared `getBlobToken()` helper or the token is accessed differently (e.g., via a `getBlob()` wrapper), update `lib/cache-metrics.ts` to use that pattern instead of directly referencing `process.env.BLOB_READ_WRITE_TOKEN`. Consistency with existing patterns is important.

If `lib/storage.ts` exports a `readBlob` / `writeBlob` helper that wraps `@vercel/blob`, prefer using those instead of calling `put`/`head` directly, to avoid token duplication.

### Step 5: Verification

```bash
# Type check — must pass with zero errors
npx tsc --noEmit

# Build check
npm run build

# Quick smoke test: verify exports are present
node -e "
const m = require('./lib/cache-metrics');
console.log('exports:', Object.keys(m));
const metrics = m.extractCacheMetrics({
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 800 }
}, 'test-endpoint');
console.log('metrics:', metrics);
const savings = m.calculateSavings(metrics);
console.log('savings:', savings);
// With 800 cache read tokens (0.1x) out of 1100 total,
// hypothetical cost = 1100, actual = 100*1 + 200*1.25 + 800*0.1 = 100+250+80 = 430
// savings = 1100-430 = 670, savingsPercent ≈ 60.91%
console.assert(savings.cachedTokens === 800, 'cachedTokens should be 800');
console.assert(savings.savingsPercent > 0, 'should show savings');
console.log('smoke test passed');
" 2>/dev/null || echo "Note: node smoke test skipped (may need build step first)"
```

If TypeScript errors occur:
- If `@vercel/blob` types differ, adjust the `head()` call — it may return `null` rather than throwing when key not found. Use try/catch or check the actual return type.
- If `experimental_providerMetadata` doesn't exist on the AI SDK response type, add a type assertion: `(response as any).experimental_providerMetadata`
- If there are strict null check issues on `usage` fields, add explicit `?? 0` defaults

### Step 6: Commit, push, open PR

```bash
git add lib/cache-metrics.ts lib/atc.ts
git commit -m "feat: add cache hit monitoring and cost tracking

- Add lib/cache-metrics.ts with CacheMetrics interface, extractCacheMetrics,
  calculateSavings, logCacheMetrics, and summarizeDailyCacheMetrics
- Cache reads cost 0.1x, cache writes cost 1.25x base price
- Daily logs persisted to Vercel Blob at af-data/cache-metrics/YYYY-MM-DD.json
- ATC monitoring cycle now logs daily cache hit rate and savings summary
- All storage failures are swallowed to prevent ATC cycle crashes"

git push origin feat/cache-hit-monitoring

gh pr create \
  --title "feat: add cache hit monitoring and cost tracking" \
  --body "## Summary

Adds observability for prompt caching effectiveness across all Anthropic API calls.

## Changes

### \`lib/cache-metrics.ts\` (new)
- \`CacheMetrics\` interface — typed record per API call
- \`extractCacheMetrics(response, endpoint)\` — reads \`cache_creation_input_tokens\` and \`cache_read_input_tokens\` from Anthropic response (handles both direct usage fields and AI SDK \`experimental_providerMetadata\`)
- \`calculateSavings(metrics)\` — computes savings % using correct pricing ratios (cache reads = 0.1x, cache writes = 1.25x base price)
- \`logCacheMetrics(metrics)\` — appends to daily blob at \`af-data/cache-metrics/YYYY-MM-DD.json\`
- \`summarizeDailyCacheMetrics()\` — reads today's log and emits a summary line with hit rate and estimated savings

### \`lib/atc.ts\`
- Calls \`summarizeDailyCacheMetrics()\` at end of each monitoring cycle

## Acceptance Criteria
- [x] \`CacheMetrics\` interface exported
- [x] \`extractCacheMetrics\` reads cache token fields with 0 defaults
- [x] \`calculateSavings\` uses 0.1x/1.25x pricing ratios
- [x] \`logCacheMetrics\` persists to Vercel Blob in append mode
- [x] ATC cycle logs cache summary
- [x] TypeScript compiles with no errors
- [x] All errors swallowed — no ATC crashes from observability failures"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/cache-hit-monitoring
FILES CHANGED: [lib/cache-metrics.ts, lib/atc.ts]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "@vercel/blob head() type mismatch", "experimental_providerMetadata not on AI SDK type"]
NEXT STEPS: [e.g., "Fix head() null return handling in logCacheMetrics and summarizeDailyCacheMetrics"]
```

## Common Failure Modes

| Error | Fix |
|-------|-----|
| `head() returns BlobMetadata \| null` (not throws) | Replace try/catch around `head()` with null check: `const existing = await head(...); if (existing) { ... }` |
| `experimental_providerMetadata` not in AI SDK types | Cast: `(response as any).experimental_providerMetadata?.anthropic` |
| `addRandomSuffix` not in `put()` options | Remove that option — it may not exist in the installed version; the blob path is deterministic by design |
| Import path style mismatch | Match `.js` / no-extension style from other `lib/atc.ts` imports |