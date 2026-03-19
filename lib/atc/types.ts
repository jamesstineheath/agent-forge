import type { ATCEvent, ATCState, HLOLifecycleState, WorkItem } from "../types";
import type { PR } from "../github";

// Re-export for convenience
export type { ATCEvent, ATCState, HLOLifecycleState, WorkItem, PR };

/**
 * Shared context for an agent cycle (dispatcher or health monitor).
 */
export interface CycleContext {
  now: Date;
  events: ATCEvent[];
}

// --- Constants ---

export const ATC_STATE_KEY = "atc/state";
export const ATC_EVENTS_KEY = "atc/events";
export const ATC_BRANCH_CLEANUP_KEY = "atc/last-branch-cleanup";
export const SUPERVISOR_LAST_DRIFT_CHECK_KEY = "supervisor/last-drift-check";
export const ATC_LOCK_KEY = "atc/cycle-lock";

export const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const LOCK_HARD_CEILING_MS = 10 * 60 * 1000; // 10 minutes — force-clear zombie locks
export const CYCLE_TIMEOUT_MS = 240 * 1000; // 240s — abort before Vercel's 300s Fluid Compute limit

// Stage-aware stall timeouts:
export const STALL_TIMEOUT_EXECUTING_NO_RUN_MINUTES = 20;
export const STALL_TIMEOUT_EXECUTING_WITH_RUN_MINUTES = 35;
export const STALL_TIMEOUT_REVIEWING_NO_PR_MINUTES = 30;
export const CONFLICT_CHECK_DELAY_MINUTES = 15;

export const GLOBAL_CONCURRENCY_LIMIT = 7;
export const MAX_EVENTS = 1000;
export const CLEANUP_THROTTLE_MINUTES = 60;
export const STALE_BRANCH_HOURS = 48;
export const MAX_BRANCHES_PER_REPO = 20;
export const MAX_RETRIES = 2;

// Projects with human-authored plans that predate the PM quality gate.
export const QUALITY_GATE_EXEMPT_PROJECTS = new Set([
  "PRJ-9",  // PA Real Estate Agent v2 — human-authored plan
]);

/**
 * Timeout error thrown when a cycle exceeds CYCLE_TIMEOUT_MS.
 */
export class CycleTimeoutError extends Error {
  constructor(ms: number) {
    super(`ATC cycle timed out after ${ms}ms`);
    this.name = "CycleTimeoutError";
  }
}

export interface HLOStateEntry {
  workItem: WorkItem;
  hloState: HLOLifecycleState | null;
  prInfo: PR | null;
}

// --- Model event types ---

export type TaskType =
  | "dispatch"
  | "health_monitor"
  | "project_manager"
  | "supervisor"
  | "spec_review"
  | "code_review"
  | "execution";

export interface ModelCallEvent {
  eventType: 'model_call';
  timestamp: string;
  workItemId?: string;
  taskType: TaskType;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  success: boolean;
  error?: string;
}

export interface ModelEscalationEvent {
  eventType: 'model_escalation';
  timestamp: string;
  workItemId?: string;
  taskType: TaskType;
  reason: string;
  confidenceScore?: number;
  step?: string;
}

export type ModelEvent = ModelCallEvent | ModelEscalationEvent;

export const MODEL_EVENTS_KEY = "atc/model-events";
