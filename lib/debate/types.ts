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
