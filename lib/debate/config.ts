import type { DebateConfig } from './types';

/**
 * Default configuration for the debate-based TLM review system.
 *
 * These defaults are designed to be safe and cost-effective:
 * - 3 rounds balances thoroughness with token cost
 * - 0.8 confidence threshold filters out low-quality arguments
 * - Only medium/high risk PRs trigger debate to avoid overhead on trivial changes
 */
export const DEFAULT_DEBATE_CONFIG: DebateConfig = {
  maxRounds: 3,
  confidenceThreshold: 0.8,
  model: 'claude-sonnet-4-20250514',
  enabledForRiskLevels: ['medium', 'high'],
};

/**
 * Valid risk level values for parsing the DEBATE_ENABLED_RISK_LEVELS env var.
 */
const VALID_RISK_LEVELS = ['low', 'medium', 'high'] as const;
type RiskLevel = (typeof VALID_RISK_LEVELS)[number];

/**
 * Parses a comma-separated string of risk levels into a typed array.
 * Invalid values are silently filtered out, falling back to the default
 * if the result would be empty.
 */
function parseRiskLevels(raw: string): RiskLevel[] {
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is RiskLevel =>
      VALID_RISK_LEVELS.includes(s as RiskLevel)
    );

  return parsed.length > 0 ? parsed : DEFAULT_DEBATE_CONFIG.enabledForRiskLevels;
}

/**
 * Returns the effective DebateConfig by merging environment variable overrides
 * with sensible defaults.
 *
 * Reads the following environment variables:
 * - `DEBATE_MAX_ROUNDS` — integer, default 3
 * - `DEBATE_CONFIDENCE_THRESHOLD` — float between 0 and 1, default 0.8
 * - `DEBATE_MODEL` — Claude model identifier string, default 'claude-sonnet-4-20250514'
 * - `DEBATE_ENABLED_RISK_LEVELS` — comma-separated list of 'low', 'medium', 'high', default 'medium,high'
 *
 * @returns A validated DebateConfig object
 */
export function getDebateConfig(): DebateConfig {
  const maxRoundsRaw = process.env.DEBATE_MAX_ROUNDS;
  const confidenceRaw = process.env.DEBATE_CONFIDENCE_THRESHOLD;
  const modelRaw = process.env.DEBATE_MODEL;
  const riskLevelsRaw = process.env.DEBATE_ENABLED_RISK_LEVELS;

  const maxRounds = maxRoundsRaw
    ? Math.max(1, Math.floor(Number(maxRoundsRaw))) || DEFAULT_DEBATE_CONFIG.maxRounds
    : DEFAULT_DEBATE_CONFIG.maxRounds;

  const confidenceThreshold = confidenceRaw
    ? Math.min(1, Math.max(0, Number(confidenceRaw))) || DEFAULT_DEBATE_CONFIG.confidenceThreshold
    : DEFAULT_DEBATE_CONFIG.confidenceThreshold;

  const model =
    modelRaw && modelRaw.trim().length > 0
      ? modelRaw.trim()
      : DEFAULT_DEBATE_CONFIG.model;

  const enabledForRiskLevels = riskLevelsRaw
    ? parseRiskLevels(riskLevelsRaw)
    : DEFAULT_DEBATE_CONFIG.enabledForRiskLevels;

  return {
    maxRounds,
    confidenceThreshold,
    model,
    enabledForRiskLevels,
  };
}
