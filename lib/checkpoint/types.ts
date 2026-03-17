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
