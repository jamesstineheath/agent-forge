# Agent Forge -- Add debate types and configuration schema

## Metadata
- **Branch:** `fix/add-debate-types-and-configuration-schema`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/types.ts, lib/debate/config.ts, lib/debate/index.ts

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
11. Create `lib/debate/index.ts` barrel export re-exporting everything from `types.ts` and `config.ts`
12. TypeScript compiles with no errors (`npx tsc --noEmit`)
13. All interfaces and the config function are properly documented with JSDoc comments

## Execution Steps

### Step 0: Pre-flight checks