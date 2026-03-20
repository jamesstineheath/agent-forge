/**
 * Supervisor Phase Manifest — defines the execution order, tiers, and timeouts
 * for decomposed supervisor phases.
 *
 * The coordinator (cron/route.ts) iterates this manifest in order, calling each
 * phase via internal HTTP. Critical phases run first and are never deferred.
 */

export interface PhaseDefinition {
  name: string;           // Route segment name (kebab-case)
  tier: 'critical' | 'standard' | 'housekeeping';
  maxDurationSeconds: number;
  timeoutMs: number;      // How long coordinator waits for HTTP response
  description: string;
}

export interface PhaseResult {
  name: string;
  tier: string;
  status: 'success' | 'failure' | 'timeout' | 'skipped' | 'deferred';
  durationMs: number;
  decisions?: string[];
  errors?: string[];
  outputs?: Record<string, unknown>;
}

export interface PhaseExecutionLog {
  cycleId: string;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  phases: PhaseResult[];
  deferredPhases: string[];
}

// Ordered by tier, then by priority within tier.
// Critical phases run first and are never deferred.
export const PHASE_MANIFEST: PhaseDefinition[] = [
  // CRITICAL — always run first, in this order
  { name: 'escalation-management', tier: 'critical', maxDurationSeconds: 30, timeoutMs: 25_000, description: '§10-12: Timeout monitoring, Gmail polling, reminders' },
  { name: 'criteria-import',       tier: 'critical', maxDurationSeconds: 60, timeoutMs: 55_000, description: '§19: Import approved criteria from Notion' },
  { name: 'architecture-planning', tier: 'critical', maxDurationSeconds: 300, timeoutMs: 295_000, description: '§21: Generate architecture plans' },
  { name: 'decomposition',         tier: 'critical', maxDurationSeconds: 300, timeoutMs: 295_000, description: '§22: Trigger decomposition from plans' },

  // STANDARD — run after critical, skipped if time exhausted
  { name: 'intent-validation',     tier: 'standard', maxDurationSeconds: 60, timeoutMs: 55_000, description: '§20: Post-project criteria verification' },
  { name: 'spend-monitoring',      tier: 'standard', maxDurationSeconds: 15, timeoutMs: 12_000, description: '§5: Vercel spend threshold checks' },
  { name: 'agent-health',          tier: 'standard', maxDurationSeconds: 15, timeoutMs: 12_000, description: 'Agent trace health + staleness checks' },
  { name: 'hlo-polling',           tier: 'standard', maxDurationSeconds: 30, timeoutMs: 25_000, description: '§15: HLO lifecycle state from open PRs' },

  // HOUSEKEEPING — run last, deferred if time budget exceeded
  { name: 'branch-cleanup',        tier: 'housekeeping', maxDurationSeconds: 60, timeoutMs: 55_000, description: 'Stale branch deletion' },
  { name: 'blob-reconciliation',   tier: 'housekeeping', maxDurationSeconds: 30, timeoutMs: 25_000, description: '§9.5: Work item blob-index reconciliation' },
  { name: 'drift-detection',       tier: 'housekeeping', maxDurationSeconds: 30, timeoutMs: 25_000, description: '§18: Statistical drift detection' },
  { name: 'pm-sweep',              tier: 'housekeeping', maxDurationSeconds: 60, timeoutMs: 55_000, description: '§14: PM Agent daily sweep + digest' },
  { name: 'repo-reindex',          tier: 'housekeeping', maxDurationSeconds: 60, timeoutMs: 55_000, description: '§16: Full re-index for stale repos' },
  { name: 'cache-metrics',         tier: 'housekeeping', maxDurationSeconds: 10, timeoutMs: 8_000, description: 'Daily cache metrics summary' },
];
