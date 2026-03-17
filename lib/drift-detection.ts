/**
 * lib/drift-detection.ts
 *
 * Drift detection module using Jensen-Shannon divergence to identify
 * when recent outcome distributions deviate from historical baselines.
 */

import { WorkItem, DriftSnapshot } from './types';
import { loadJson, saveJson } from './storage';

const TERMINAL_STATUSES = ['merged', 'failed', 'parked', 'cancelled'] as const;
const DEFAULT_THRESHOLD = 0.15;
const DRIFT_INDEX_KEY = 'drift/index';

/**
 * Counts outcomes as percentages over the given period.
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
    const ts = item.updatedAt
      ? new Date(item.updatedAt).getTime()
      : item.createdAt
        ? new Date(item.createdAt).getTime()
        : 0;
    return (
      ts >= windowStart &&
      ts <= windowEnd &&
      (TERMINAL_STATUSES as readonly string[]).includes(item.status)
    );
  });

  const total = filtered.length;
  if (total === 0) {
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
  const allKeys = Array.from(
    new Set([...Object.keys(current), ...Object.keys(baseline)])
  );

  const normalize = (dist: Record<string, number>): number[] => {
    const values = allKeys.map((k) => dist[k] ?? 0);
    const sum = values.reduce((a, b) => a + b, 0);
    if (sum === 0) return values.map(() => 1 / allKeys.length);
    return values.map((v) => v / sum);
  };

  const P = normalize(current);
  const Q = normalize(baseline);

  const M = P.map((p, i) => 0.5 * (p + Q[i]));

  const klDivergence = (a: number[], m: number[]): number => {
    let kl = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] > 0 && m[i] > 0) {
        kl += a[i] * Math.log2(a[i] / m[i]);
      }
    }
    return kl;
  };

  const jsd = 0.5 * klDivergence(P, M) + 0.5 * klDivergence(Q, M);

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

  const currentWindowEnd = now;
  const currentWindowStart = now - periodMs(currentPeriodDays);

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
        (TERMINAL_STATUSES as readonly string[]).includes(item.status)
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
 * Persists a DriftSnapshot to storage at af-data/drift/YYYY-MM-DD.json
 * and updates the drift index for retrieval.
 */
export async function saveDriftSnapshot(snapshot: DriftSnapshot): Promise<void> {
  const key = `drift/${snapshot.date}`;
  await saveJson(key, snapshot);

  // Update the index of snapshot dates
  const index = (await loadJson<string[]>(DRIFT_INDEX_KEY)) ?? [];
  if (!index.includes(snapshot.date)) {
    index.push(snapshot.date);
    index.sort();
    await saveJson(DRIFT_INDEX_KEY, index);
  }
}

/**
 * Loads the most recent N drift snapshots.
 */
export async function getRecentDriftSnapshots(count: number): Promise<DriftSnapshot[]> {
  const index = (await loadJson<string[]>(DRIFT_INDEX_KEY)) ?? [];
  // Sort descending (most recent first) and take the first `count`
  const recentDates = [...index].sort().reverse().slice(0, count);

  const snapshots: DriftSnapshot[] = [];
  for (const date of recentDates) {
    const snapshot = await loadJson<DriftSnapshot>(`drift/${date}`);
    if (snapshot) {
      snapshots.push(snapshot);
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
