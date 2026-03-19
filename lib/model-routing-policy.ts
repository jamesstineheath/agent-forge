// ── Model Routing Policy Types ──────────────────────────────────────────────

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
