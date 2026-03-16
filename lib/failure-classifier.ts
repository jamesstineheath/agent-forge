import type { FailureCategory } from './types';

// Pattern lists ordered by match priority within each category

const STRUCTURAL_PATTERNS: RegExp[] = [
  /401/,
  /403/,
  /Forbidden/,
  /missing.*env/i,
  /ANTHROPIC_API_KEY/,
  /GH_PAT/,
  /repo.*not found/i,
  /permission denied/i,
  /authentication failed/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /ETIMEDOUT/,
  /rate limit/i,
  /5\d{2}/,
  /ECONNRESET/,
  /network error/i,
  /GitHub API rate/i,
];

const EXECUTION_PATTERNS: RegExp[] = [
  /tsc.*error/i,
  /TS\d{4}/,
  /test.*fail/i,
  /build.*fail/i,
  /context.*exhaust/i,
  /JEST/,
  /vitest/i,
  /npm run build.*exit code/i,
  /compile.*error/i,
];

/**
 * Classifies a failure based on error output and optional exit code.
 * Match order: structural → transient → execution → unknown
 */
export function classifyFailure(errorOutput: string, exitCode?: number): FailureCategory {
  if (STRUCTURAL_PATTERNS.some((pattern) => pattern.test(errorOutput))) {
    return 'structural';
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(errorOutput))) {
    return 'transient';
  }
  if (EXECUTION_PATTERNS.some((pattern) => pattern.test(errorOutput))) {
    return 'execution';
  }
  return 'unknown';
}

/**
 * Returns the maximum number of automatic retries for a given failure category.
 * - transient: 2 (network/rate limit issues are often self-resolving)
 * - execution: 0 (routes to handoff regeneration instead)
 * - structural: 0 (escalates immediately — human action required)
 * - unknown: 1 (one cautious retry before escalating)
 */
export function getMaxRetries(category: FailureCategory): number {
  switch (category) {
    case 'transient':
      return 2;
    case 'execution':
      return 0;
    case 'structural':
      return 0;
    case 'unknown':
      return 1;
  }
}

/**
 * Returns the recovery action for a given failure category.
 * - transient: 'retry' — retry the same execution
 * - execution: 'regenerate' — regenerate the handoff and re-execute
 * - structural: 'escalate' — notify human immediately
 * - unknown: 'retry-then-escalate' — retry once, then escalate if still failing
 */
export function getRecoveryAction(
  category: FailureCategory
): 'retry' | 'regenerate' | 'escalate' | 'retry-then-escalate' {
  switch (category) {
    case 'transient':
      return 'retry';
    case 'execution':
      return 'regenerate';
    case 'structural':
      return 'escalate';
    case 'unknown':
      return 'retry-then-escalate';
  }
}
