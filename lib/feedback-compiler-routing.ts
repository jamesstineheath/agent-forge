import { queryModelCallEvents, emitRoutingThresholdEvent } from './atc/events';
import { loadJson, saveJson } from './storage';
import type {
  RoutingThresholdConfig,
  RoutingPolicyOverride,
  SignalCombinationKey,
} from './model-routing-policy';

const OVERRIDES_KEY = 'config/routing-policy-overrides';

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

  const events = await queryModelCallEvents({ startDate: since });

  // Accumulate counts per signal combination
  const counts = new Map<SignalCombinationKey, { total: number; failures: number }>();

  for (const event of events) {
    const taskType = event.taskType ?? 'unknown';
    const complexity = event.complexity ?? 'unknown';
    const criteria = event.criteria;
    const success = event.success !== false;

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
    const raw = await loadJson<RoutingPolicyOverride[]>(OVERRIDES_KEY);
    if (raw) {
      existing = raw;
    }
  } catch {
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

  // Write merged overrides back
  await saveJson(OVERRIDES_KEY, Array.from(merged.values()));

  // Emit events for each new override
  for (const o of newOverrides) {
    await emitRoutingThresholdEvent({
      signalKey: o.signalKey,
      forceModel: o.forceModel,
      triggeringFailureRate: o.triggeringFailureRate,
      sampleSize: o.sampleSize,
    });
  }
}
