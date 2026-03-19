// --- Event Bus Types ---

export type GitHubEventType =
  | "github.pr.opened"
  | "github.pr.merged"
  | "github.pr.closed"
  | "github.pr.review_submitted"
  | "github.ci.passed"
  | "github.ci.failed"
  | "github.workflow.completed"
  | "github.push";

export interface WebhookEvent {
  id: string;
  type: GitHubEventType;
  timestamp: string;
  repo: string;
  payload: WebhookEventPayload;
}

export interface WebhookEventPayload {
  /** PR number, if applicable */
  prNumber?: number;
  /** Branch name */
  branch?: string;
  /** Commit SHA */
  commitSha?: string;
  /** Workflow name, if applicable */
  workflowName?: string;
  /** Workflow conclusion (success, failure, etc.) */
  conclusion?: string;
  /** Action that triggered the event (opened, closed, completed, etc.) */
  action?: string;
  /** Short summary for display */
  summary?: string;
  /** GitHub username of the reviewer (pull_request_review events) */
  reviewer?: string;
  /** Review state: approved, changes_requested, commented (pull_request_review events) */
  reviewState?: string;
  /** Review body text (pull_request_review events) */
  reviewBody?: string;
}

export interface EventQueryOptions {
  since?: string;
  types?: GitHubEventType[];
  repo?: string;
  limit?: number;
}
