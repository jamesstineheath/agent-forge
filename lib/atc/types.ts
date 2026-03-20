import type { ATCEvent, ATCState, HLOLifecycleState, WorkItem } from "../types";
import type { PR } from "../github";
import type { AgentTrace } from "./tracing";

// Re-export for convenience
export type { ATCEvent, ATCState, HLOLifecycleState, WorkItem, PR };

/**
 * Shared context for an agent cycle (dispatcher or health monitor).
 */
export interface CycleContext {
  now: Date;
  events: ATCEvent[];
  trace?: AgentTrace;
}

// --- Constants ---

export const ATC_STATE_KEY = "atc/state";
export const ATC_EVENTS_KEY = "atc/events";
export const ATC_BRANCH_CLEANUP_KEY = "atc/last-branch-cleanup";
export const SUPERVISOR_LAST_DRIFT_CHECK_KEY = "supervisor/last-drift-check";
export const ATC_LOCK_KEY = "atc/cycle-lock";

export const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const LOCK_HARD_CEILING_MS = 10 * 60 * 1000; // 10 minutes — force-clear zombie locks
export const CYCLE_TIMEOUT_MS = 780 * 1000; // 780s — generous ceiling for Opus API calls (Pro Fluid Compute supports 800s)

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

// --- Decomposer failure reason classification ---

export type DecomposerFailureReason =
  | 'empty_plan'
  | 'no_components'
  | 'parse_failure'
  | 'no_target_repo'
  | 'claude_refusal'
  | 'empty_context'
  | 'validation_failure'
  | 'unknown';

// --- Spec review stall thresholds ---

export const SPEC_REVIEW_STALL_WARN_MINUTES = 30;
export const SPEC_REVIEW_STALL_FAIL_MINUTES = 45;

// --- Architecture planner empty context threshold ---

export const MIN_REPO_CONTEXT_LENGTH = 200;

export type TaskType =
  | "decomposition"
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
  /** Optional complexity signal for routing analysis */
  complexity?: string;
  /** Optional criteria signal for routing analysis */
  criteria?: unknown;
}

export interface ModelEscalationEvent {
  eventType: 'model_escalation';
  timestamp: string;
  workItemId?: string;
  taskType: TaskType;
  fromModel: string;
  toModel: string;
  reason: string;
  confidenceScore?: number;
  step?: string;
}

export type ModelEvent = ModelCallEvent | ModelEscalationEvent;

export const MODEL_EVENTS_KEY = "atc/model-events";

// --- Supervisor Phase Prioritization (PRD-50) ---

export interface PhaseConfig {
  name: string;
  /** Static priority (higher = more important). Range 0-100. */
  basePriority: number;
  /** Budget fraction (0-1) — how much of total budget this phase should get */
  budgetFraction: number;
  /** Phase dependencies — names of phases that must run first */
  dependsOn?: string[];
}

/**
 * Phase priority configuration for the Supervisor.
 * Phases are sorted by priority (descending) before execution.
 * Higher priority phases run first so they aren't skipped under time pressure.
 */
export const SUPERVISOR_PHASES: PhaseConfig[] = [
  // Critical: human escalations must be handled first
  { name: "escalation_management", basePriority: 95, budgetFraction: 0.10 },
  // High: new work intake and plan generation
  { name: "criteria_import", basePriority: 85, budgetFraction: 0.05 },
  { name: "architecture_planning", basePriority: 80, budgetFraction: 0.15, dependsOn: ["criteria_import"] },
  { name: "decomposition_trigger", basePriority: 75, budgetFraction: 0.15, dependsOn: ["architecture_planning"] },
  // Medium-high: budget safety
  { name: "spend_monitoring", basePriority: 70, budgetFraction: 0.05 },
  // Medium: status tracking and verification
  { name: "hlo_polling", basePriority: 60, budgetFraction: 0.08 },
  { name: "intent_validation", basePriority: 55, budgetFraction: 0.10 },
  { name: "agent_trace_health_check", basePriority: 50, budgetFraction: 0.03 },
  { name: "agent_staleness_check", basePriority: 50, budgetFraction: 0.03 },
  { name: "drift_detection", basePriority: 45, budgetFraction: 0.05 },
  // Low: housekeeping
  { name: "pm_sweep_and_reindex", basePriority: 35, budgetFraction: 0.10 },
  { name: "branch_cleanup", basePriority: 25, budgetFraction: 0.05 },
  { name: "blob_reconciliation", basePriority: 20, budgetFraction: 0.05 },
];

/**
 * Get phases sorted by priority (highest first).
 * Respects dependency ordering: a phase won't appear before its dependencies.
 */
export function getPrioritizedPhases(): PhaseConfig[] {
  const sorted = [...SUPERVISOR_PHASES].sort((a, b) => b.basePriority - a.basePriority);

  // Topological adjustment: ensure dependencies come before dependents
  const result: PhaseConfig[] = [];
  const placed = new Set<string>();

  function place(phase: PhaseConfig) {
    if (placed.has(phase.name)) return;
    for (const dep of phase.dependsOn ?? []) {
      const depPhase = sorted.find((p) => p.name === dep);
      if (depPhase && !placed.has(dep)) {
        place(depPhase);
      }
    }
    result.push(phase);
    placed.add(phase.name);
  }

  for (const phase of sorted) {
    place(phase);
  }

  return result;
}
