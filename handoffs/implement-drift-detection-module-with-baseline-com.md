# Agent Forge -- Implement drift detection module with baseline comparison

## Metadata
- **Branch:** `feat/drift-detection-module`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/drift-detection.ts, lib/types.ts

## Context

Agent Forge is a dev orchestration platform built with Next.js. It tracks work items through a lifecycle (filed → ready → queued → generating → executing → reviewing → merged/failed/parked/cancelled) stored in Vercel Blob at `af-data/work-items/*`.

This task adds a drift detection module to identify when recent outcome distributions deviate significantly from historical baselines — a signal that the pipeline is degrading. The module uses Jensen-Shannon divergence to quantify distributional shift.

Existing patterns to follow:
- `lib/storage.ts` handles all Vercel Blob CRUD — use it for persistence
- `lib/types.ts` holds shared types like `WorkItem` — add `DriftSnapshot` there
- `lib/reasoning-metrics.ts` is a recent example of a new analytics module (follow its pattern for exports and structure)
- No external npm dependencies should be added; implement math inline

## Requirements

1. Add `DriftSnapshot` type to `lib/types.ts`
2. Create `lib/drift-detection.ts` with all required exports
3. `computeOutcomeDistribution` counts work items by terminal outcome (merged/failed/parked/cancelled) within the given period, returns percentages (0–100 summing to ~100)
4. `computeDriftScore` implements Jensen-Shannon divergence inline, returns 0 for identical distributions and >0.5 for maximally different distributions (e.g., `{merged: 100}` vs `{failed: 100}`)
5. `detectDrift` computes baseline from the older period (e.g., days 30–60 ago) and current from the recent period (e.g., last 30 days), calculates drift score, sets `degraded = true` if score exceeds threshold (default 0.15)
6. `saveDriftSnapshot` persists snapshot to Vercel Blob at `af-data/drift/YYYY-MM-DD.json`
7. `getRecentDriftSnapshots` loads the most recent N snapshots by listing and sorting blob keys under `af-data/drift/`
8. `formatDriftAlert` returns a human-readable string summarizing the snapshot
9. `npm run build` passes with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/drift-detection-module
```

### Step 1: Inspect existing types and storage patterns

Read the following files to understand existing conventions before writing any code:

```bash
cat lib/types.ts
cat lib/storage.ts
cat lib/reasoning-metrics.ts  # if exists, for structural reference
```

Note the `WorkItem` type structure — specifically the `status` field (which holds values like `merged`, `failed`, `parked`, `cancelled`) and any `updatedAt` / `createdAt` timestamp fields used to filter by period.

### Step 2: Add `DriftSnapshot` to `lib/types.ts`

Append the following type definition to `lib/types.ts`. Place it near other analytics/metrics types if any exist, otherwise append at the end:

```typescript
export interface DriftSnapshot {
  date: string;                                    // ISO date string YYYY-MM-DD
  baselinePeriodDays: number;                      // e.g., 30 (days 30-60 ago)
  currentPeriodDays: number;                       // e.g., 30 (last 30 days)
  baselineDistribution: Record<string, number>;    // outcome -> percentage
  currentDistribution: Record<string, number>;     // outcome -> percentage
  driftScore: number;                              // Jensen-Shannon divergence [0, 1]
  degraded: boolean;                               // true if driftScore > threshold
  threshold: number;                               // threshold used
  baselineCount: number;                           // number of items in baseline period
  currentCount: number;                            // number of items in current period
}
```

### Step 3: Create `lib/drift-detection.ts`

Create the file with the following complete implementation. Read `lib/storage.ts` first to confirm the exact function signatures for blob list/get/put operations, then implement accordingly:

```typescript
import { WorkItem, DriftSnapshot } from './types';
import { listBlobs, getBlob, putBlob } from './storage'; // adjust imports to match actual storage.ts exports

const TERMINAL_STATUSES = ['merged', 'failed', 'parked', 'cancelled'] as const;
const DEFAULT_THRESHOLD = 0.15;

/**
 * Counts outcomes as percentages over the given period (ending now).
 * Uses updatedAt (or createdAt) to filter items within the window.
 */
export function computeOutcomeDistribution(
  workItems: WorkItem[],
  periodDays: number,
  offsetDays = 0
): Record<string, number> {
  const now = Date.now();
  const periodMs = periodDays * 24 * 60 * 60 * 1000;
  const offsetMs = offsetDays * 24 * 60 * 60 * 1000;

  const windowEnd = now - offsetMs;
  const windowStart = windowEnd - periodMs;

  const filtered = workItems.filter((item) => {
    // Use updatedAt if available, fall back to createdAt
    const ts = item.updatedAt
      ? new Date(item.updatedAt).getTime()
      : item.createdAt
      ? new Date(item.createdAt).getTime()
      : 0;
    return (
      ts >= windowStart &&
      ts <= windowEnd &&
      TERMINAL_STATUSES.includes(item.status as any)
    );
  });

  const total = filtered.length;
  if (total === 0) {
    // Return uniform distribution across terminal statuses to avoid division by zero
    const uniform = 100 / TERMINAL_STATUSES.length;
    return Object.fromEntries(TERMINAL_STATUSES.map((s) => [s, uniform]));
  }

  const counts: Record<string, number> = {};
  for (const status of TERMINAL_STATUSES) {
    counts[status] = 0;
  }
  for (const item of filtered) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }

  const distribution: Record<string, number> = {};
  for (const [status, count] of Object.entries(counts)) {
    distribution[status] = (count / total) * 100;
  }
  return distribution;
}

/**
 * Jensen-Shannon divergence between two outcome distributions.
 * Distributions are percentage maps; internally normalized to probabilities.
 * Returns 0 for identical distributions, approaches 1 for maximally different.
 */
export function computeDriftScore(
  current: Record<string, number>,
  baseline: Record<string, number>
): number {
  // Collect all keys from both distributions
  const allKeys = Array.from(
    new Set([...Object.keys(current), ...Object.keys(baseline)])
  );

  // Normalize percentages to probabilities (sum to 1)
  const normalize = (dist: Record<string, number>): number[] => {
    const values = allKeys.map((k) => dist[k] ?? 0);
    const sum = values.reduce((a, b) => a + b, 0);
    if (sum === 0) return values.map(() => 1 / allKeys.length);
    return values.map((v) => v / sum);
  };

  const P = normalize(current);   // current distribution
  const Q = normalize(baseline);  // baseline distribution

  // M = 0.5 * (P + Q) — the mixture distribution
  const M = P.map((p, i) => 0.5 * (p + Q[i]));

  // KL divergence: KL(P || M) = sum(P * log(P / M))
  const klDivergence = (a: number[], m: number[]): number => {
    let kl = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] > 0 && m[i] > 0) {
        kl += a[i] * Math.log2(a[i] / m[i]);
      }
    }
    return kl;
  };

  // JS divergence = 0.5 * KL(P||M) + 0.5 * KL(Q||M)
  const jsd = 0.5 * klDivergence(P, M) + 0.5 * klDivergence(Q, M);

  // JSD is bounded [0, 1] when using log base 2; clamp for floating point safety
  return Math.max(0, Math.min(1, jsd));
}

/**
 * Detects drift by comparing a recent period to an older baseline period.
 */
export function detectDrift(options: {
  workItems: WorkItem[];
  baselinePeriodDays: number;
  currentPeriodDays: number;
  threshold?: number;
}): DriftSnapshot {
  const {
    workItems,
    baselinePeriodDays,
    currentPeriodDays,
    threshold = DEFAULT_THRESHOLD,
  } = options;

  const now = Date.now();
  const periodMs = (days: number) => days * 24 * 60 * 60 * 1000;

  // Current period: last `currentPeriodDays` days
  const currentWindowEnd = now;
  const currentWindowStart = now - periodMs(currentPeriodDays);

  // Baseline period: the `baselinePeriodDays` days immediately before the current period
  const baselineWindowEnd = currentWindowStart;
  const baselineWindowStart = baselineWindowEnd - periodMs(baselinePeriodDays);

  const filterItems = (start: number, end: number) =>
    workItems.filter((item) => {
      const ts = item.updatedAt
        ? new Date(item.updatedAt).getTime()
        : item.createdAt
        ? new Date(item.createdAt).getTime()
        : 0;
      return (
        ts >= start &&
        ts <= end &&
        TERMINAL_STATUSES.includes(item.status as any)
      );
    });

  const currentItems = filterItems(currentWindowStart, currentWindowEnd);
  const baselineItems = filterItems(baselineWindowStart, baselineWindowEnd);

  const currentDistribution = computeOutcomeDistribution(
    currentItems,
    currentPeriodDays
  );
  const baselineDistribution = computeOutcomeDistribution(
    baselineItems,
    baselinePeriodDays
  );

  const driftScore = computeDriftScore(currentDistribution, baselineDistribution);

  const date = new Date().toISOString().split('T')[0];

  return {
    date,
    baselinePeriodDays,
    currentPeriodDays,
    baselineDistribution,
    currentDistribution,
    driftScore,
    degraded: driftScore > threshold,
    threshold,
    baselineCount: baselineItems.length,
    currentCount: currentItems.length,
  };
}

/**
 * Persists a DriftSnapshot to Vercel Blob at af-data/drift/YYYY-MM-DD.json
 */
export async function saveDriftSnapshot(snapshot: DriftSnapshot): Promise<void> {
  const key = `af-data/drift/${snapshot.date}.json`;
  await putBlob(key, JSON.stringify(snapshot, null, 2));
}

/**
 * Loads the most recent N drift snapshots from Vercel Blob.
 */
export async function getRecentDriftSnapshots(count: number): Promise<DriftSnapshot[]> {
  const blobs = await listBlobs('af-data/drift/');
  // Sort descending by key name (ISO dates sort lexicographically)
  const sorted = blobs
    .map((b: any) => b.pathname ?? b.key ?? b)
    .filter((key: string) => key.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, count);

  const snapshots: DriftSnapshot[] = [];
  for (const key of sorted) {
    try {
      const raw = await getBlob(key);
      if (raw) {
        snapshots.push(JSON.parse(raw) as DriftSnapshot);
      }
    } catch {
      // Skip malformed snapshots
    }
  }
  return snapshots;
}

/**
 * Formats a DriftSnapshot into a human-readable alert message.
 */
export function formatDriftAlert(snapshot: DriftSnapshot): string {
  const status = snapshot.degraded ? '🚨 DEGRADED' : '✅ HEALTHY';
  const scorePercent = (snapshot.driftScore * 100).toFixed(1);
  const thresholdPercent = (snapshot.threshold * 100).toFixed(1);

  const formatDist = (dist: Record<string, number>) =>
    Object.entries(dist)
      .map(([k, v]) => `${k}: ${v.toFixed(1)}%`)
      .join(', ');

  return [
    `[Drift Detection] ${status} — ${snapshot.date}`,
    `Drift Score: ${scorePercent}% (threshold: ${thresholdPercent}%)`,
    `Current period (${snapshot.currentPeriodDays}d, n=${snapshot.currentCount}): ${formatDist(snapshot.currentDistribution)}`,
    `Baseline period (${snapshot.baselinePeriodDays}d, n=${snapshot.baselineCount}): ${formatDist(snapshot.baselineDistribution)}`,
  ].join('\n');
}
```

### Step 4: Reconcile with actual `lib/storage.ts` API

After writing the draft above, read `lib/storage.ts` carefully and adjust the import and usage in `lib/drift-detection.ts` to match the actual exported function names and signatures. Common patterns to look for:

- If storage exports `saveData`/`loadData` style functions, adjust accordingly
- If it uses a `BlobClient` class, instantiate it correctly
- If `listBlobs` returns objects with `pathname`, `url`, or `key` properties, update the `getRecentDriftSnapshots` function to use the correct property
- The key insight: `putBlob(key, content)` and `getBlob(key)` → `string | null` is the typical pattern; verify and adjust

### Step 5: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `WorkItem.status` type — if it's a union type `'merged' | 'failed' | ...`, update the `includes` check with a proper cast
- `WorkItem.updatedAt` / `createdAt` — verify field names match the actual `WorkItem` interface
- Missing imports in `lib/types.ts`

### Step 6: Build verification

```bash
npm run build
```

Ensure the build passes with no errors.

### Step 7: Quick sanity checks (inline, no test framework needed)

Verify the math is correct by mentally tracing through:
- `computeDriftScore({merged: 100}, {merged: 100})` → should be exactly `0` (identical distributions)
- `computeDriftScore({merged: 100, failed: 0, parked: 0, cancelled: 0}, {merged: 0, failed: 100, parked: 0, cancelled: 0})` → should be `1.0` (maximally different, P and Q are orthogonal, M = 0.5 each, KL(P||M) = 1 * log2(1/0.5) = 1, so JSD = 0.5*1 + 0.5*1 = 1.0)

If `computeDriftScore` doesn't return exactly 0 for identical inputs, check floating point — add a small epsilon guard or round to sufficient precision.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: implement drift detection module with baseline comparison"
git push origin feat/drift-detection-module
gh pr create \
  --title "feat: implement drift detection module with baseline comparison" \
  --body "## Summary
Adds \`lib/drift-detection.ts\` with Jensen-Shannon divergence-based drift detection for work item outcome distributions.

## Changes
- \`lib/types.ts\`: Added \`DriftSnapshot\` interface
- \`lib/drift-detection.ts\`: New module with 6 exports:
  - \`computeOutcomeDistribution\` — percentages of terminal outcomes in a time window
  - \`computeDriftScore\` — Jensen-Shannon divergence (0=identical, 1=maximal)
  - \`detectDrift\` — compares recent vs baseline periods, flags degradation
  - \`saveDriftSnapshot\` — persists to Vercel Blob at \`af-data/drift/YYYY-MM-DD.json\`
  - \`getRecentDriftSnapshots\` — loads N most recent snapshots
  - \`formatDriftAlert\` — human-readable alert string

## Acceptance Criteria
- [x] All 5 required functions exported from \`lib/drift-detection.ts\`
- [x] \`computeDriftScore\` returns 0 for identical distributions
- [x] \`computeDriftScore\` returns >0.5 for maximally different distributions
- [x] \`detectDrift\` sets \`degraded=true\` when drift exceeds threshold
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
BRANCH: feat/drift-detection-module
FILES CHANGED: [lib/types.ts, lib/drift-detection.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked on an unresolvable issue (e.g., `lib/storage.ts` has a completely different API than anticipated, or `WorkItem` is missing `updatedAt`/`createdAt` fields and the correct timestamp field is unclear):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "drift-detection-module",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/drift-detection.ts"]
    }
  }'
```