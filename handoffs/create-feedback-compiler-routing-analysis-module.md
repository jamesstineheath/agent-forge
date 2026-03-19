# Agent Forge -- Create Feedback Compiler Routing Analysis Module

## Metadata
- **Branch:** `feat/feedback-compiler-routing-analysis`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/feedback-compiler-routing.ts, lib/model-router.ts, lib/model-routing-policy.ts, lib/atc/events.ts

## Context

Agent Forge is a dev orchestration platform using a 4-agent autonomous architecture (Dispatcher, Health Monitor, Project Manager, Supervisor). The system already has model routing infrastructure in place:
- `lib/model-router.ts` — selects Opus vs Sonnet based on task signals
- `lib/model-routing-policy.ts` — contains routing policy types/logic
- `lib/atc/events.ts` — durable event log for the system
- `app/api/analytics/model-routing/route.ts` — analytics endpoint (recently merged)

This task adds a **feedback loop**: when Sonnet repeatedly fails for certain signal combinations, the system automatically tightens routing thresholds to force Opus for those combinations. The module stores overrides in Vercel Blob and the model router reads them at runtime (60s cache).

**Concurrent work to avoid:** Branch `fix/create-model-routing-dashboard-page` is modifying `app/model-routing/page.tsx`, `app/components/model-routing-dashboard.tsx`, `lib/hooks.ts`, and `app/layout.tsx`. Do **not** touch those files.

**Key patterns from the codebase:**
- Vercel Blob CRUD is handled via `lib/storage.ts` — inspect it to understand the `get`/`put` helpers before writing Blob calls
- Events are emitted via `lib/atc/events.ts` — look at how existing events are structured before adding a new one
- The `lib/types.ts` and `lib/model-routing-policy.ts` files hold shared types — check both before adding new types to avoid duplication

## Requirements

1. `analyzeRoutingOutcomes(config: RoutingThresholdConfig): Promise<RoutingPolicyOverride[]>` queries `model_call` events for the lookback period, groups by signal combination (taskType + complexity + criteria bucket), calculates failure rate per combination, and returns overrides for combinations exceeding `failureRateThreshold` with `>= minSampleSize` calls.
2. `analyzeRoutingOutcomes` returns an empty array when no combination exceeds thresholds or has sufficient sample size.
3. `applyRoutingOverrides(overrides: RoutingPolicyOverride[]): Promise<void>` reads existing overrides from `af-data/config/routing-policy-overrides.json`, merges (newer wins on same signal key), writes back, and emits a `routing_threshold_tightened` event per new override.
4. `lib/model-router.ts` `selectModel` loads overrides from Blob (in-memory cache with 60s TTL) and applies them before the default policy — if an override matches the current signals, it forces the override's model.
5. `RoutingPolicyOverride` and `RoutingThresholdConfig` types exist in `lib/model-routing-policy.ts` (add only if not already present).
6. `routing_threshold_tightened` is added to recognized event types in `lib/atc/events.ts`.
7. Project compiles with `npm run build` and `npx tsc --noEmit`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/feedback-compiler-routing-analysis
```

### Step 1: Read existing files before writing anything

Read these files in full before making changes — the implementation must match existing patterns:

```bash
cat lib/model-routing-policy.ts
cat lib/model-router.ts
cat lib/atc/events.ts
cat lib/storage.ts
cat lib/event-bus.ts
cat lib/event-bus-types.ts
cat lib/types.ts
```

Note:
- What types already exist in `lib/model-routing-policy.ts` (avoid duplicating `RoutingPolicyOverride` or `RoutingThresholdConfig` if present)
- How `lib/storage.ts` exposes Blob read/write (likely `getBlob`/`putBlob` or similar — use the actual exported functions)
- How events are emitted in `lib/atc/events.ts` — the exact function signature and event shape
- How the event bus logs events (to understand `model_call` event structure)

### Step 2: Add types to lib/model-routing-policy.ts

**Only add types that do not already exist.** After reading the file, add the following if missing:

```typescript
// Signal combination key for grouping routing outcomes
export type SignalCombinationKey = `${string}|${string}|${string}`; // taskType|complexity|criteriaBucket

// Configuration for routing outcome analysis
export interface RoutingThresholdConfig {
  /** Lookback window in milliseconds */
  lookbackMs: number;
  /** Minimum number of calls in a signal combination to consider */
  minSampleSize: number;
  /** Failure rate (0–1) above which an override is generated */
  failureRateThreshold: number;
}

// A persistent override that forces a specific model for a signal combination
export interface RoutingPolicyOverride {
  /** Signal combination key: "taskType|complexity|criteriaBucket" */
  signalKey: SignalCombinationKey;
  /** The model to force for this signal combination */
  forceModel: 'opus' | 'sonnet';
  /** ISO timestamp when this override was created */
  createdAt: string;
  /** Failure rate that triggered this override */
  triggeringFailureRate: number;
  /** Number of samples that informed this override */
  sampleSize: number;
}
```

### Step 3: Add routing_threshold_tightened to lib/atc/events.ts

Read the file first to understand the exact union type or string literal type used for event names. Then add `'routing_threshold_tightened'` to the appropriate type/union.

The event payload shape (for reference when emitting later):
```typescript
// Expected payload for routing_threshold_tightened events
{
  signalKey: string;
  forceModel: 'opus' | 'sonnet';
  triggeringFailureRate: number;
  sampleSize: number;
}
```

Follow the existing pattern exactly — do not invent a new pattern.

### Step 4: Create lib/feedback-compiler-routing.ts

```typescript
import { listEvents } from './event-bus'; // adjust import to actual export
import { emitEvent } from './atc/events';  // adjust import to actual export
import { getBlob, putBlob } from './storage'; // adjust to actual exports
import type {
  RoutingThresholdConfig,
  RoutingPolicyOverride,
  SignalCombinationKey,
} from './model-routing-policy';

const OVERRIDES_BLOB_KEY = 'af-data/config/routing-policy-overrides.json';

/** Derive a criteria bucket label from a numeric score or descriptor */
function criteriaBucket(criteria: unknown): string {
  if (typeof criteria === 'number') {
    if (criteria >= 0.8) return 'high';
    if (criteria >= 0.5) return 'medium';
    return 'low';
  }
  if (typeof criteria === 'string') return criteria;
  return 'unknown';
}

/** Build a canonical signal key from event signal fields */
function toSignalKey(
  taskType: string,
  complexity: string,
  criteria: unknown
): SignalCombinationKey {
  return `${taskType}|${complexity}|${criteriaBucket(criteria)}` as SignalCombinationKey;
}

/**
 * Queries model_call events for the lookback period, groups by signal combination,
 * and returns RoutingPolicyOverride[] for combinations exceeding the failure rate
 * threshold with sufficient sample size.
 */
export async function analyzeRoutingOutcomes(
  config: RoutingThresholdConfig
): Promise<RoutingPolicyOverride[]> {
  const { lookbackMs, minSampleSize, failureRateThreshold } = config;
  const since = new Date(Date.now() - lookbackMs).toISOString();

  // Query model_call events — adjust to the actual event query API
  const events = await listEvents({ type: 'model_call', since });

  // Accumulate counts per signal combination
  const counts = new Map<SignalCombinationKey, { total: number; failures: number }>();

  for (const event of events) {
    const payload = event.payload as {
      taskType?: string;
      complexity?: string;
      criteria?: unknown;
      success?: boolean;
      model?: string;
    };

    const taskType = payload.taskType ?? 'unknown';
    const complexity = payload.complexity ?? 'unknown';
    const criteria = payload.criteria;
    const success = payload.success !== false; // default true if not set

    const key = toSignalKey(taskType, complexity, criteria);
    const existing = counts.get(key) ?? { total: 0, failures: 0 };
    counts.set(key, {
      total: existing.total + 1,
      failures: existing.failures + (success ? 0 : 1),
    });
  }

  const overrides: RoutingPolicyOverride[] = [];
  const now = new Date().toISOString();

  for (const [signalKey, { total, failures }] of counts.entries()) {
    if (total < minSampleSize) continue;
    const failureRate = failures / total;
    if (failureRate < failureRateThreshold) continue;

    overrides.push({
      signalKey,
      forceModel: 'opus',
      createdAt: now,
      triggeringFailureRate: failureRate,
      sampleSize: total,
    });
  }

  return overrides;
}

/**
 * Reads existing overrides from Vercel Blob, merges new overrides (newer wins
 * for same signal key), writes back, and emits routing_threshold_tightened
 * events for each new override.
 */
export async function applyRoutingOverrides(
  overrides: RoutingPolicyOverride[]
): Promise<void> {
  if (overrides.length === 0) return;

  // Load existing overrides
  let existing: RoutingPolicyOverride[] = [];
  try {
    const raw = await getBlob(OVERRIDES_BLOB_KEY); // adjust to actual API
    if (raw) {
      existing = JSON.parse(raw) as RoutingPolicyOverride[];
    }
  } catch {
    // No existing overrides — start fresh
    existing = [];
  }

  // Build map keyed by signalKey (existing first, then new overrides win)
  const merged = new Map<string, RoutingPolicyOverride>();
  for (const o of existing) {
    merged.set(o.signalKey, o);
  }

  const newOverrides: RoutingPolicyOverride[] = [];
  for (const o of overrides) {
    const existingEntry = merged.get(o.signalKey);
    if (!existingEntry || o.createdAt > existingEntry.createdAt) {
      merged.set(o.signalKey, o);
      newOverrides.push(o);
    }
  }

  // Write merged overrides back to Blob
  await putBlob(OVERRIDES_BLOB_KEY, JSON.stringify(Array.from(merged.values()), null, 2));

  // Emit events for each new override
  for (const o of newOverrides) {
    await emitEvent('routing_threshold_tightened', {
      signalKey: o.signalKey,
      forceModel: o.forceModel,
      triggeringFailureRate: o.triggeringFailureRate,
      sampleSize: o.sampleSize,
    });
  }
}
```

> **Important:** Adjust all imports to match what is actually exported by `lib/storage.ts`, `lib/event-bus.ts`, and `lib/atc/events.ts`. Do not assume function names — read the files first (Step 1).

### Step 5: Modify lib/model-router.ts — load and apply overrides

Add an in-memory cache with 60s TTL, then apply overrides in `selectModel` before the default policy.

After reading the file, add code following this pattern — adapt to the actual structure:

```typescript
import { getBlob } from './storage'; // adjust to actual export
import type { RoutingPolicyOverride } from './model-routing-policy';

const OVERRIDES_BLOB_KEY = 'af-data/config/routing-policy-overrides.json';

// ── Override cache (60s TTL) ──────────────────────────────────────────────────
let _overridesCache: RoutingPolicyOverride[] | null = null;
let _overridesCacheExpiry = 0;

async function loadOverrides(): Promise<RoutingPolicyOverride[]> {
  const now = Date.now();
  if (_overridesCache !== null && now < _overridesCacheExpiry) {
    return _overridesCache;
  }
  try {
    const raw = await getBlob(OVERRIDES_BLOB_KEY);
    _overridesCache = raw ? (JSON.parse(raw) as RoutingPolicyOverride[]) : [];
  } catch {
    _overridesCache = [];
  }
  _overridesCacheExpiry = now + 60_000; // 60s TTL
  return _overridesCache;
}
```

In `selectModel` (or equivalent function), **before** applying the default policy, add:

```typescript
// Apply routing overrides (feedback-compiler tightened thresholds)
const overrides = await loadOverrides();
if (overrides.length > 0) {
  const signalKey = `${taskType}|${complexity}|${criteriaBucket}` as const;
  const override = overrides.find((o) => o.signalKey === signalKey);
  if (override) {
    return override.forceModel; // 'opus' | 'sonnet'
  }
}
```

> **Note:** The exact variable names (`taskType`, `complexity`, `criteriaBucket`) depend on what already exists in `selectModel`. Read the function fully before inserting. The signal key construction must match `toSignalKey` in `lib/feedback-compiler-routing.ts` exactly.

### Step 6: Verify compilation

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- Import paths that don't match actual exports
- The `SignalCombinationKey` template literal type — if TypeScript complains, use `string` for the Blob key construction and cast at the boundary
- `listEvents` may not accept `{ type, since }` — inspect the actual signature and adapt

```bash
npm run build
```

Fix any build errors.

### Step 7: Verify no overlap with concurrent branch

```bash
git diff --name-only main
```

Confirm the changed files do **not** include:
- `app/model-routing/page.tsx`
- `app/components/model-routing-dashboard.tsx`  
- `lib/hooks.ts`
- `app/layout.tsx`

If any of those appear, remove those changes immediately.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add feedback compiler routing analysis module with override persistence and model router integration"
git push origin feat/feedback-compiler-routing-analysis
gh pr create \
  --title "feat: Create Feedback Compiler routing analysis module" \
  --body "## Summary

Adds automatic routing threshold tightening when Sonnet repeatedly fails for specific signal combinations.

## Changes

### New: \`lib/feedback-compiler-routing.ts\`
- \`analyzeRoutingOutcomes(config)\` — queries \`model_call\` events, groups by taskType+complexity+criteriaBucket, returns \`RoutingPolicyOverride[]\` for combinations exceeding failure rate threshold with sufficient sample size
- \`applyRoutingOverrides(overrides)\` — merges into \`af-data/config/routing-policy-overrides.json\` (newer wins), emits \`routing_threshold_tightened\` event per new override

### Modified: \`lib/model-router.ts\`
- \`selectModel\` now loads overrides from Blob (60s in-memory cache) and applies them before default policy

### Modified: \`lib/model-routing-policy.ts\`
- Added \`RoutingThresholdConfig\`, \`RoutingPolicyOverride\`, \`SignalCombinationKey\` types (if not previously present)

### Modified: \`lib/atc/events.ts\`
- Added \`routing_threshold_tightened\` to recognized event types

## Acceptance Criteria
- [x] \`analyzeRoutingOutcomes\` returns overrides for combinations exceeding failure rate threshold with >= minSampleSize
- [x] \`analyzeRoutingOutcomes\` returns empty array when thresholds not met
- [x] \`applyRoutingOverrides\` persists to Blob and emits events
- [x] \`selectModel\` loads and applies overrides, overriding default policy
- [x] \`npm run build\` passes

## Notes
- Does not touch files modified by concurrent branch \`fix/create-model-routing-dashboard-page\`
- Override Blob key: \`af-data/config/routing-policy-overrides.json\`
- Cache TTL: 60 seconds"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "feat: partial - feedback compiler routing analysis (see PR for status)"
git push origin feat/feedback-compiler-routing-analysis
gh pr create --title "feat: Create Feedback Compiler routing analysis module [PARTIAL]" --body "Partial implementation — see ISSUES below."
```

2. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/feedback-compiler-routing-analysis
FILES CHANGED: [list files actually modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "adapt loadOverrides to actual getBlob signature", "fix SignalCombinationKey TS error in model-router.ts"]
```

3. Escalate if blocked on ambiguous architecture decisions:
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "feedback-compiler-routing-analysis",
    "reason": "<concise description of blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error message>",
      "filesChanged": ["lib/feedback-compiler-routing.ts", "lib/model-router.ts", "lib/model-routing-policy.ts", "lib/atc/events.ts"]
    }
  }'
```