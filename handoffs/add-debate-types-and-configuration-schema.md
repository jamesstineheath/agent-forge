# Agent Forge -- Add debate types and configuration schema

## Metadata
- **Branch:** `feat/debate-types-and-config`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/types.ts, lib/debate/config.ts

## Context

This task establishes the foundational TypeScript types and configuration schema for a debate-based TLM (Team Lead Model) review system. The debate system will allow multiple AI agents to take advocate/critic positions on code review decisions, improving review quality through structured argumentation.

Agent Forge is a Next.js dev orchestration platform. The `lib/` directory contains shared logic (see `lib/types.ts` for existing type patterns, `lib/escalation.ts` for state machine patterns). No existing debate infrastructure exists yet — this is greenfield work creating the `lib/debate/` directory.

The repo uses TypeScript with strict compilation. All new files should follow the existing pattern of well-typed exports with JSDoc documentation.

## Requirements

1. Create `lib/debate/types.ts` exporting all required interfaces with correct field types and JSDoc comments
2. `DebatePosition` is a union type `'advocate' | 'critic'`
3. `DebateArgument` has fields: `position: DebatePosition`, `agentId: string`, `claim: string`, `evidence: string[]`, `confidence: number`, `referencedFiles: string[]`
4. `DebateRound` has fields: `roundNumber: number`, `arguments: DebateArgument[]`, `timestamp: string`
5. `DebateOutcome` has fields: `consensus: boolean`, `finalVerdict: 'approve' | 'request_changes' | 'escalate'`, `resolvedIssues: string[]`, `unresolvedDisagreements: string[]`, `tokenUsage: { advocate: number, critic: number, judge: number, total: number }`
6. `DebateConfig` has fields: `maxRounds: number`, `confidenceThreshold: number`, `model: string`, `enabledForRiskLevels: ('low' | 'medium' | 'high')[]`
7. `DebateSession` has fields: `id: string`, `prNumber: number`, `repo: string`, `config: DebateConfig`, `rounds: DebateRound[]`, `outcome: DebateOutcome | null`, `startedAt: string`, `completedAt: string | null`
8. Create `lib/debate/config.ts` exporting `getDebateConfig()` returning `DebateConfig` with defaults
9. `getDebateConfig()` reads `DEBATE_MAX_ROUNDS` (default: `3`), `DEBATE_CONFIDENCE_THRESHOLD` (default: `0.8`), `DEBATE_MODEL` (default: `'claude-sonnet-4-20250514'`) env vars
10. `DEBATE_ENABLED_RISK_LEVELS` env var (comma-separated) controls `enabledForRiskLevels`, defaulting to `['medium', 'high']`
11. TypeScript compiles with no errors (`npx tsc --noEmit`)
12. All interfaces and the config function are properly documented with JSDoc comments

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/debate-types-and-config
```

### Step 1: Create the lib/debate directory and types file

Create `lib/debate/types.ts` with the following content:

```typescript
/**
 * Debate-based TLM review system type definitions.
 *
 * These types model a structured argumentation system where AI agents
 * take advocate/critic positions to improve code review quality.
 */

/**
 * The position an agent takes in a debate round.
 * - `advocate`: argues in favor of approving the change
 * - `critic`: argues against, identifying risks and issues
 */
export type DebatePosition = 'advocate' | 'critic';

/**
 * A single argument made by an agent during a debate round.
 */
export interface DebateArgument {
  /** The position this argument supports */
  position: DebatePosition;
  /** Unique identifier for the agent making this argument */
  agentId: string;
  /** The primary claim or assertion being made */
  claim: string;
  /** Supporting evidence for the claim (quotes, observations, references) */
  evidence: string[];
  /** Agent's confidence in this argument, between 0 and 1 */
  confidence: number;
  /** File paths in the PR that this argument references */
  referencedFiles: string[];
}

/**
 * A single round of debate, containing arguments from all participating agents.
 */
export interface DebateRound {
  /** 1-indexed round number within the debate session */
  roundNumber: number;
  /** All arguments submitted during this round */
  arguments: DebateArgument[];
  /** ISO 8601 timestamp when this round was recorded */
  timestamp: string;
}

/**
 * Token usage breakdown across all agent roles in a debate session.
 */
export interface DebateTokenUsage {
  /** Tokens consumed by the advocate agent */
  advocate: number;
  /** Tokens consumed by the critic agent */
  critic: number;
  /** Tokens consumed by the judge agent */
  judge: number;
  /** Total tokens across all agents */
  total: number;
}

/**
 * The final outcome of a completed debate session.
 */
export interface DebateOutcome {
  /** Whether agents reached consensus without unresolved disagreements */
  consensus: boolean;
  /**
   * The final verdict produced by the judge:
   * - `approve`: change is safe to merge
   * - `request_changes`: specific changes are required before merging
   * - `escalate`: human review required due to unresolvable disagreement or risk
   */
  finalVerdict: 'approve' | 'request_changes' | 'escalate';
  /** Issues that were raised and resolved during the debate */
  resolvedIssues: string[];
  /** Disagreements that could not be resolved across all rounds */
  unresolvedDisagreements: string[];
  /** Token usage breakdown for cost tracking */
  tokenUsage: DebateTokenUsage;
}

/**
 * Configuration options for the debate system.
 */
export interface DebateConfig {
  /** Maximum number of debate rounds before the judge renders a verdict */
  maxRounds: number;
  /** Minimum confidence threshold (0–1) for an argument to be considered conclusive */
  confidenceThreshold: number;
  /** Claude model identifier to use for debate agents */
  model: string;
  /** Risk levels for which the debate system is activated */
  enabledForRiskLevels: ('low' | 'medium' | 'high')[];
}

/**
 * A complete debate session tied to a specific pull request.
 */
export interface DebateSession {
  /** Unique identifier for this debate session */
  id: string;
  /** GitHub pull request number being reviewed */
  prNumber: number;
  /** GitHub repository in `owner/repo` format */
  repo: string;
  /** Configuration used for this session */
  config: DebateConfig;
  /** Ordered list of debate rounds conducted */
  rounds: DebateRound[];
  /** Final outcome, or null if the session is still in progress */
  outcome: DebateOutcome | null;
  /** ISO 8601 timestamp when the session started */
  startedAt: string;
  /** ISO 8601 timestamp when the session completed, or null if still in progress */
  completedAt: string | null;
}
```

### Step 2: Create the config file

Create `lib/debate/config.ts` with the following content:

```typescript
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
```

### Step 3: Verification

```bash
# Confirm files exist
ls -la lib/debate/

# TypeScript compilation check (no errors expected)
npx tsc --noEmit

# If build script exists, run it too
npm run build 2>/dev/null || echo "No build script / build errors noted above"

# Quick smoke test: verify exports are importable
node -e "
const path = require('path');
// Test that files are syntactically valid JS-compatible modules
try {
  require('./lib/debate/config');
  console.log('config.ts: OK');
} catch(e) {
  // TypeScript files won't run directly via node, that's fine
  console.log('config.ts: exists (TS-only check via tsc above)');
}
"

# Confirm tsc specifically for our new files
npx tsc --noEmit --strict lib/debate/types.ts lib/debate/config.ts 2>/dev/null || npx tsc --noEmit
```

### Step 4: Commit, push, open PR

```bash
git add lib/debate/types.ts lib/debate/config.ts
git commit -m "feat: add debate types and configuration schema

- Add lib/debate/types.ts with DebatePosition, DebateArgument,
  DebateRound, DebateOutcome, DebateConfig, and DebateSession interfaces
- Add lib/debate/config.ts with DEFAULT_DEBATE_CONFIG constant and
  getDebateConfig() function that reads env vars with sensible defaults
- All types documented with JSDoc comments
- Defaults: maxRounds=3, confidenceThreshold=0.8,
  model=claude-sonnet-4-20250514, enabledForRiskLevels=[medium,high]"

git push origin feat/debate-types-and-config

gh pr create \
  --title "feat: add debate types and configuration schema" \
  --body "## Summary

Establishes the foundational TypeScript type definitions and configuration schema for the debate-based TLM review system.

## Changes

### \`lib/debate/types.ts\`
- \`DebatePosition\`: union type \`'advocate' | 'critic'\`
- \`DebateArgument\`: single agent argument with position, claim, evidence, confidence, and referenced files
- \`DebateRound\`: a collection of arguments for one round with timestamp
- \`DebateTokenUsage\`: token breakdown across advocate/critic/judge roles
- \`DebateOutcome\`: final verdict with consensus flag, resolved/unresolved issues, and token usage
- \`DebateConfig\`: runtime configuration options
- \`DebateSession\`: top-level session tied to a PR

### \`lib/debate/config.ts\`
- \`DEFAULT_DEBATE_CONFIG\`: exported constant with all defaults
- \`getDebateConfig()\`: reads \`DEBATE_MAX_ROUNDS\`, \`DEBATE_CONFIDENCE_THRESHOLD\`, \`DEBATE_MODEL\`, \`DEBATE_ENABLED_RISK_LEVELS\` env vars, falls back to defaults

## Acceptance Criteria
- [x] All interfaces exported from \`lib/debate/types.ts\` with correct field types
- [x] \`getDebateConfig()\` returns \`DebateConfig\` with defaults
- [x] Env var overrides supported with graceful fallback
- [x] TypeScript compiles with no errors
- [x] JSDoc comments on all types and functions"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/debate-types-and-config
FILES CHANGED: lib/debate/types.ts, lib/debate/config.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If blocked on TypeScript compilation errors that cannot be resolved (e.g., tsconfig incompatibilities, missing peer types):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "debate-types-and-config",
    "reason": "TypeScript compilation error that cannot be resolved autonomously",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 3: Verification",
      "error": "<paste tsc error output here>",
      "filesChanged": ["lib/debate/types.ts", "lib/debate/config.ts"]
    }
  }'
```