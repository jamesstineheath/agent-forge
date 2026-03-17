export enum HandoffState {
  SpecReview = "SpecReview",
  SpecReviewComplete = "SpecReviewComplete",
  Executing = "Executing",
  ExecutionComplete = "ExecutionComplete",
  ExecutionFailed = "ExecutionFailed",
  CIRunning = "CIRunning",
  CIPassed = "CIPassed",
  CIFailed = "CIFailed",
  RetryingExecution = "RetryingExecution",
  CodeReview = "CodeReview",
  CodeReviewComplete = "CodeReviewComplete",
  RequestedChanges = "RequestedChanges",
  NeedsHumanReview = "NeedsHumanReview",
  ConflictDetected = "ConflictDetected",
  Merged = "Merged",
  Failed = "Failed",
}

export interface Transition {
  from: HandoffState;
  to: HandoffState;
  trigger: string;
  timestamp: string;
  details?: string;
}

export interface HandoffLifecycle {
  state: HandoffState;
  branch: string;
  handoffFile: string;
  retryCount: number;
  transitions: Transition[];
  startedAt: string;
  completedAt: string | null;
  totalCost: number | null;
}

export type TriggerEvent =
  | { type: "spec_review_completed"; conclusion: "success" | "failure" }
  | { type: "execution_completed"; conclusion: "success" | "failure" }
  | { type: "ci_completed"; conclusion: "success" | "failure" }
  | { type: "code_review_completed"; decision: "approve" | "request_changes" | "flag_for_human" }
  | { type: "pr_merged" }
  | { type: "pr_closed" }
  | { type: "retry_triggered" }
  | { type: "conflict_detected"; resolution: "rebased" | "closed" | "escalated" };

const TERMINAL_STATES = new Set([
  HandoffState.Merged,
  HandoffState.Failed,
]);

export function isTerminal(state: HandoffState): boolean {
  return TERMINAL_STATES.has(state);
}

export function createLifecycle(branch: string, handoffFile: string): HandoffLifecycle {
  return {
    state: HandoffState.SpecReview,
    branch,
    handoffFile,
    retryCount: 0,
    transitions: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    totalCost: null,
  };
}

export function applyTransition(
  lifecycle: HandoffLifecycle,
  event: TriggerEvent,
  details?: string
): HandoffLifecycle {
  const now = new Date().toISOString();
  const current = lifecycle.state;

  const nextState = getNextState(current, event);
  if (!nextState) {
    throw new Error(
      `Invalid transition: cannot apply ${event.type} in state ${current}`
    );
  }

  const transition: Transition = {
    from: current,
    to: nextState,
    trigger: event.type,
    timestamp: now,
    details,
  };

  const updated: HandoffLifecycle = {
    ...lifecycle,
    state: nextState,
    transitions: [...lifecycle.transitions, transition],
  };

  if (nextState === HandoffState.RetryingExecution) {
    updated.retryCount = lifecycle.retryCount + 1;
  }

  if (isTerminal(nextState)) {
    updated.completedAt = now;
  }

  return updated;
}

/**
 * Try to apply a transition, advancing through intermediate states if needed.
 * This handles out-of-order events (e.g., receiving execution_completed when
 * state is SpecReview because the spec_review_completed event was missed).
 */
export function applyTransitionResilient(
  lifecycle: HandoffLifecycle,
  event: TriggerEvent,
  details?: string
): HandoffLifecycle {
  // First try direct transition
  const directNext = getNextState(lifecycle.state, event);
  if (directNext) {
    return applyTransition(lifecycle, event, details);
  }

  // Try advancing through intermediate states to reach a state that accepts this event
  const advancePath = findAdvancePath(lifecycle.state, event);
  if (advancePath) {
    let current = lifecycle;
    // Apply intermediate transitions to advance state
    for (const intermediateState of advancePath) {
      const now = new Date().toISOString();
      current = {
        ...current,
        state: intermediateState,
        transitions: [
          ...current.transitions,
          {
            from: current.state,
            to: intermediateState,
            trigger: "state_advanced",
            timestamp: now,
            details: `Auto-advanced to handle ${event.type}`,
          },
        ],
      };
    }
    // Now apply the actual event
    return applyTransition(current, event, details);
  }

  throw new Error(
    `Invalid transition: cannot apply ${event.type} in state ${lifecycle.state}`
  );
}

/**
 * Find a sequence of intermediate states to advance through so that
 * the given event can be applied. Returns the intermediate states
 * (not including the final event-driven transition), or null if no path exists.
 */
function findAdvancePath(
  current: HandoffState,
  event: TriggerEvent
): HandoffState[] | null {
  // Define the natural progression of states
  const STATE_ORDER: HandoffState[] = [
    HandoffState.SpecReview,
    HandoffState.SpecReviewComplete,
    HandoffState.Executing,
    HandoffState.ExecutionComplete,
    HandoffState.CIRunning,
    HandoffState.CIPassed,
    HandoffState.CodeReview,
    HandoffState.CodeReviewComplete,
  ];

  const currentIdx = STATE_ORDER.indexOf(current);
  if (currentIdx === -1) return null;

  // Try each subsequent state as a potential target where the event is valid
  for (let i = currentIdx + 1; i < STATE_ORDER.length; i++) {
    const candidateState = STATE_ORDER[i];
    if (getNextState(candidateState, event) !== null) {
      // Found a state that accepts this event - return the path to get there
      return STATE_ORDER.slice(currentIdx + 1, i + 1);
    }
  }

  return null;
}

function getNextState(
  current: HandoffState,
  event: TriggerEvent
): HandoffState | null {
  switch (event.type) {
    case "spec_review_completed":
      if (current === HandoffState.SpecReview) {
        return event.conclusion === "success"
          ? HandoffState.SpecReviewComplete
          : HandoffState.Failed;
      }
      return null;

    case "execution_completed":
      if (
        current === HandoffState.SpecReviewComplete ||
        current === HandoffState.Executing ||
        current === HandoffState.RetryingExecution
      ) {
        return event.conclusion === "success"
          ? HandoffState.ExecutionComplete
          : HandoffState.ExecutionFailed;
      }
      return null;

    case "ci_completed":
      if (
        current === HandoffState.ExecutionComplete ||
        current === HandoffState.CIRunning
      ) {
        return event.conclusion === "success"
          ? HandoffState.CIPassed
          : HandoffState.CIFailed;
      }
      return null;

    case "code_review_completed":
      if (
        current === HandoffState.CIPassed ||
        current === HandoffState.CodeReview
      ) {
        if (event.decision === "approve") return HandoffState.CodeReviewComplete;
        if (event.decision === "request_changes") return HandoffState.RequestedChanges;
        if (event.decision === "flag_for_human") return HandoffState.NeedsHumanReview;
      }
      return null;

    case "pr_merged":
      if (!isTerminal(current)) {
        return HandoffState.Merged;
      }
      return null;

    case "pr_closed":
      if (!isTerminal(current)) {
        return HandoffState.Failed;
      }
      return null;

    case "retry_triggered":
      if (current === HandoffState.CIFailed) {
        return HandoffState.RetryingExecution;
      }
      if (current === HandoffState.ExecutionFailed) {
        return HandoffState.RetryingExecution;
      }
      return null;

    case "conflict_detected":
      if (!isTerminal(current)) {
        if (event.resolution === "rebased") {
          // Rebase succeeded — stay in current state, CI will re-run
          return current === HandoffState.CodeReview ||
            current === HandoffState.CodeReviewComplete ||
            current === HandoffState.CIPassed
            ? HandoffState.CIRunning
            : current;
        }
        // Closed or escalated — transition through ConflictDetected to Failed
        return HandoffState.ConflictDetected;
      }
      return null;

    default:
      return null;
  }
}

const STATE_LABELS: Record<HandoffState, string> = {
  [HandoffState.SpecReview]: "Spec Review",
  [HandoffState.SpecReviewComplete]: "Spec Review Complete",
  [HandoffState.Executing]: "Executing",
  [HandoffState.ExecutionComplete]: "Execution Complete",
  [HandoffState.ExecutionFailed]: "Execution Failed",
  [HandoffState.CIRunning]: "CI Running",
  [HandoffState.CIPassed]: "CI Passed",
  [HandoffState.CIFailed]: "CI Failed",
  [HandoffState.RetryingExecution]: "Retrying Execution",
  [HandoffState.CodeReview]: "Code Review",
  [HandoffState.CodeReviewComplete]: "Code Review Complete",
  [HandoffState.RequestedChanges]: "Requested Changes",
  [HandoffState.NeedsHumanReview]: "Needs Human Review",
  [HandoffState.ConflictDetected]: "Conflict Detected",
  [HandoffState.Merged]: "Merged",
  [HandoffState.Failed]: "Failed",
};

export function getStateLabel(state: HandoffState): string {
  return STATE_LABELS[state] || state;
}
