# Agent Forge -- Define checkpoint types and interfaces

## Metadata
- **Branch:** `feat/checkpoint-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/checkpoint/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams across multiple repositories. The system manages work items through a defined lifecycle: `filed → ready → queued → generating → executing → reviewing → merged` with side states `blocked` and `parked`.

This task creates the foundational TypeScript types and interfaces for a checkpoint-based fault tolerance system. These types will be the shared data structures consumed by all other checkpoint components (store implementations, recovery logic, ATC integration). The task is purely type definitions — no runtime code, no external dependencies.

The existing work item lifecycle is defined in `lib/types.ts` and documented in `docs/SYSTEM_MAP.md`. The `PipelineStage` enum must match the 9 stages from the work item lifecycle exactly.

## Requirements

1. Create `lib/checkpoint/types.ts` with all specified types and interfaces
2. `PipelineStage` must be a TypeScript string union type (or enum) covering all 9 stages: `filed`, `ready`, `queued`, `generating`, `executing`, `reviewing`, `merged`, `blocked`, `parked`
3. `CheckpointState` interface must include: `id`, `workItemId`, `stage`, `data`, `timestamp`, `version`, `metadata`
4. `CheckpointMetadata` interface must include: `attemptNumber`, `previousCheckpointId`, `elapsedMs`, and optional `agentId` and `error`
5. `CheckpointStore` interface must define all four methods: `save`, `load`, `loadAll`, `delete` with correct signatures
6. `CheckpointOptions` interface must include: `maxRetries`, `retryDelayMs`, `enableTimeTravel`
7. `RecoveryAction` must be a union type of exactly: `'resume' | 'retry-stage' | 'rollback' | 'escalate'`
8. `RecoveryDecision` interface must include: `action`, optional `targetCheckpointId`, and `reason`
9. All types must be exported
10. No runtime dependencies — pure type definitions only
11. `npx tsc --noEmit` must pass with no errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/checkpoint-types
```

### Step 1: Create the checkpoint directory and types file

Create the directory and file `lib/checkpoint/types.ts`:

```bash
mkdir -p lib/checkpoint
```

Create `lib/checkpoint/types.ts` with the following content:

```typescript
/**
 * Core types and interfaces for the checkpoint-based fault tolerance system.
 * No runtime dependencies — pure type definitions only.
 */

/**
 * Represents each stage in the work item pipeline lifecycle.
 * Matches the work item lifecycle defined in docs/SYSTEM_MAP.md.
 */
export type PipelineStage =
  | 'filed'
  | 'ready'
  | 'queued'
  | 'generating'
  | 'executing'
  | 'reviewing'
  | 'merged'
  | 'blocked'
  | 'parked';

/**
 * Metadata associated with a checkpoint, capturing retry context and timing.
 */
export interface CheckpointMetadata {
  /** Which attempt this checkpoint was created on (1-indexed). */
  attemptNumber: number;
  /** ID of the previous checkpoint in the chain, or null if this is the first. */
  previousCheckpointId: string | null;
  /** Elapsed milliseconds since the work item entered its current stage. */
  elapsedMs: number;
  /** Optional identifier for the agent that created this checkpoint. */
  agentId?: string;
  /** Optional error message if this checkpoint captures a failure state. */
  error?: string;
}

/**
 * A snapshot of pipeline state at a specific stage, used for resumption and recovery.
 */
export interface CheckpointState {
  /** Unique identifier for this checkpoint. */
  id: string;
  /** The work item this checkpoint belongs to. */
  workItemId: string;
  /** The pipeline stage at which this checkpoint was captured. */
  stage: PipelineStage;
  /** Arbitrary stage-specific data payload for resumption. */
  data: Record<string, unknown>;
  /** ISO 8601 timestamp when this checkpoint was created. */
  timestamp: string;
  /** Monotonically increasing version number for ordering checkpoints. */
  version: number;
  /** Contextual metadata about this checkpoint. */
  metadata: CheckpointMetadata;
}

/**
 * Persistence interface for checkpoint storage backends.
 * Implementations may use Vercel Blob, in-memory, or other stores.
 */
export interface CheckpointStore {
  /**
   * Persist a checkpoint. If a checkpoint with the same id already exists,
   * it should be overwritten.
   */
  save(checkpoint: CheckpointState): Promise<void>;

  /**
   * Load the most recent checkpoint for a work item, optionally filtered by stage.
   * Returns null if no matching checkpoint exists.
   */
  load(workItemId: string, stage?: PipelineStage): Promise<CheckpointState | null>;

  /**
   * Load all checkpoints for a work item, ordered by version ascending.
   * Returns an empty array if no checkpoints exist.
   */
  loadAll(workItemId: string): Promise<CheckpointState[]>;

  /**
   * Delete a checkpoint by its unique ID.
   * Should be a no-op if the checkpoint does not exist.
   */
  delete(checkpointId: string): Promise<void>;
}

/**
 * Configuration options for checkpoint-based fault tolerance behavior.
 */
export interface CheckpointOptions {
  /** Maximum number of retry attempts before escalating. */
  maxRetries: number;
  /** Base delay in milliseconds between retry attempts. */
  retryDelayMs: number;
  /** Whether time-travel debugging (loading arbitrary historical checkpoints) is enabled. */
  enableTimeTravel: boolean;
}

/**
 * The set of recovery actions available when a pipeline failure is detected.
 */
export type RecoveryAction = 'resume' | 'retry-stage' | 'rollback' | 'escalate';

/**
 * A structured decision about how to recover from a pipeline failure.
 */
export interface RecoveryDecision {
  /** The recovery action to take. */
  action: RecoveryAction;
  /** For 'rollback' actions, the specific checkpoint ID to roll back to. */
  targetCheckpointId?: string;
  /** Human-readable explanation of why this recovery decision was made. */
  reason: string;
}
```

### Step 2: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are errors, inspect the output carefully. Common issues:
- If `tsconfig.json` doesn't include `lib/checkpoint/types.ts`, check `include` patterns — the existing config should already cover `lib/**/*.ts`
- Fix any type errors before proceeding

### Step 3: Verify the file structure

```bash
# Confirm the file exists
ls -la lib/checkpoint/types.ts

# Confirm all exports are present
grep -E "^export" lib/checkpoint/types.ts
```

Expected exports:
- `PipelineStage`
- `CheckpointMetadata`
- `CheckpointState`
- `CheckpointStore`
- `CheckpointOptions`
- `RecoveryAction`
- `RecoveryDecision`

### Step 4: Run the build to confirm no regressions

```bash
npm run build
```

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "feat: define checkpoint types and interfaces"
git push origin feat/checkpoint-types
gh pr create \
  --title "feat: define checkpoint types and interfaces" \
  --body "## Summary

Creates \`lib/checkpoint/types.ts\` with all core TypeScript types and interfaces for the checkpoint-based fault tolerance system.

## Changes

- **New file**: \`lib/checkpoint/types.ts\`
  - \`PipelineStage\` — union type covering all 9 work item lifecycle stages
  - \`CheckpointMetadata\` — retry context and timing metadata
  - \`CheckpointState\` — full checkpoint snapshot interface
  - \`CheckpointStore\` — persistence backend interface (save/load/loadAll/delete)
  - \`CheckpointOptions\` — fault tolerance configuration
  - \`RecoveryAction\` — union type of recovery strategies
  - \`RecoveryDecision\` — structured recovery outcome interface

## Notes

- Pure type definitions only, no runtime code or external dependencies
- \`PipelineStage\` matches the 9-stage lifecycle from \`docs/SYSTEM_MAP.md\`
- \`npx tsc --noEmit\` passes with no errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/checkpoint-types
FILES CHANGED: lib/checkpoint/types.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If a blocker cannot be resolved autonomously (e.g., tsconfig excludes `lib/checkpoint/`, conflicting type definitions in `lib/types.ts`, or build infrastructure issues):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "define-checkpoint-types-and-interfaces",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/checkpoint/types.ts"]
    }
  }'
```