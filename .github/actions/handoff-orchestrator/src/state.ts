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
  | { type: "retry_triggered" };

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
      if (
        current === HandoffState.CodeReviewComplete ||
        current === HandoffState.NeedsHumanReview ||
        current === HandoffState.CIPassed
      ) {
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
  [HandoffState.Merged]: "Merged",
  [HandoffState.Failed]: "Failed",
};

export function getStateLabel(state: HandoffState): string {
  return STATE_LABELS[state] || state;
}
