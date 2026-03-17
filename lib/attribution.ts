import { WorkItem, ComponentAttribution, AgentComponent } from "./types";

// ---------------------------------------------------------------------------
// Attribution Context — signals available for failure analysis
// ---------------------------------------------------------------------------

export interface AttributionContext {
  prDescription?: string;
  ciLogs?: string;
  reviewComments?: string;
  specReviewOutput?: string;
  executionLog?: string;
}

// ---------------------------------------------------------------------------
// Rule-based heuristics for failure attribution
// ---------------------------------------------------------------------------

interface Rule {
  match: (workItem: WorkItem, context: AttributionContext) => boolean;
  component: AgentComponent;
  confidence: number;
  evidence: (workItem: WorkItem, context: AttributionContext) => string;
  failureMode: string;
}

const RULES: Rule[] = [
  // CI failed with build/type errors → executor (high)
  {
    match: (_wi, ctx) =>
      !!ctx.ciLogs &&
      /\b(type\s?error|build\s?failed|compilation\s?error|tsc.*error|cannot find module|syntax\s?error)\b/i.test(
        ctx.ciLogs,
      ),
    component: "executor",
    confidence: 0.9,
    evidence: (_wi, ctx) => {
      const match = ctx.ciLogs!.match(
        /\b(type\s?error|build\s?failed|compilation\s?error|tsc.*error|cannot find module|syntax\s?error)[^\n]*/i,
      );
      return `CI build/type error: ${match?.[0]?.slice(0, 200) ?? "detected in logs"}`;
    },
    failureMode: "build-or-type-error",
  },

  // TLM code review rejected → executor or spec-reviewer
  {
    match: (_wi, ctx) =>
      !!ctx.reviewComments &&
      /\b(rejected|request\s?changes|changes\s?requested|nack)\b/i.test(ctx.reviewComments),
    component: "executor",
    confidence: 0.7,
    evidence: (_wi, ctx) => {
      const isSpecIssue =
        /\b(spec|handoff|requirements|unclear|ambiguous)\b/i.test(ctx.reviewComments!);
      return isSpecIssue
        ? "Code review rejected due to spec/requirements issues"
        : "Code review rejected the implementation";
    },
    failureMode: "code-review-rejection",
  },
  {
    match: (_wi, ctx) =>
      !!ctx.reviewComments &&
      /\b(rejected|request\s?changes|changes\s?requested|nack)\b/i.test(ctx.reviewComments) &&
      /\b(spec|handoff|requirements|unclear|ambiguous)\b/i.test(ctx.reviewComments),
    component: "spec-reviewer",
    confidence: 0.6,
    evidence: () =>
      "Code review rejection mentions spec/requirements issues — spec review may have been insufficient",
    failureMode: "inadequate-spec-review",
  },

  // PR has merge conflicts → orchestrator (branch management)
  {
    match: (_wi, ctx) =>
      (!!ctx.ciLogs && /\b(merge conflict|conflicting files)\b/i.test(ctx.ciLogs)) ||
      (!!ctx.prDescription && /\b(merge conflict)\b/i.test(ctx.prDescription)),
    component: "orchestrator",
    confidence: 0.85,
    evidence: () => "PR has merge conflicts indicating branch management issues",
    failureMode: "merge-conflict",
  },

  // Missing dependencies when dispatched → decomposer
  {
    match: (wi, ctx) =>
      (wi.dependencies.length > 0 &&
        !!ctx.executionLog &&
        /\b(missing dependency|dependency not found|depends on.*not merged|blocked by)\b/i.test(
          ctx.executionLog,
        )) ||
      (!!ctx.executionLog &&
        /\b(missing dependency|dependency not met)\b/i.test(ctx.executionLog)),
    component: "decomposer",
    confidence: 0.8,
    evidence: (wi) =>
      `Work item dispatched with unmet dependencies: [${wi.dependencies.join(", ")}]`,
    failureMode: "unmet-dependencies",
  },

  // QA smoke tests failed → qa-agent or executor
  {
    match: (_wi, ctx) =>
      !!ctx.ciLogs &&
      /\b(smoke\s?test.*fail|e2e.*fail|integration\s?test.*fail)\b/i.test(ctx.ciLogs),
    component: "executor",
    confidence: 0.65,
    evidence: () => "QA/smoke tests failed — implementation likely has functional issues",
    failureMode: "qa-test-failure",
  },
  {
    match: (_wi, ctx) =>
      !!ctx.ciLogs &&
      /\b(smoke\s?test.*fail|e2e.*fail|integration\s?test.*fail)\b/i.test(ctx.ciLogs),
    component: "qa-agent",
    confidence: 0.4,
    evidence: () =>
      "QA/smoke tests failed — test definitions may need updating if implementation is correct",
    failureMode: "qa-test-failure",
  },

  // No PR created at all → executor (execution failure)
  {
    match: (wi) => wi.status === "failed" && !wi.execution?.prNumber && !wi.execution?.prUrl,
    component: "executor",
    confidence: 0.95,
    evidence: () => "Work item failed with no PR created — executor did not produce output",
    failureMode: "no-pr-created",
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attribute a work item failure to one or more pipeline components using
 * rule-based heuristics. Returns attributions sorted by confidence descending.
 */
export async function attributeFailure(
  workItem: WorkItem,
  context: AttributionContext,
): Promise<ComponentAttribution[]> {
  const attributions: ComponentAttribution[] = [];

  for (const rule of RULES) {
    if (rule.match(workItem, context)) {
      attributions.push({
        component: rule.component,
        confidence: rule.confidence,
        evidence: rule.evidence(workItem, context),
        failureMode: rule.failureMode,
      });
    }
  }

  // Sort by confidence descending
  attributions.sort((a, b) => b.confidence - a.confidence);

  return attributions;
}

/**
 * Return a human-readable summary of attributions.
 */
export function getAttributionSummary(attributions: ComponentAttribution[]): string {
  if (attributions.length === 0) {
    return "No failure attribution could be determined.";
  }

  const lines = attributions.map((a) => {
    const level = a.confidence >= 0.8 ? "high" : a.confidence >= 0.5 ? "medium" : "low";
    return `- ${a.component} (${level} confidence): ${a.evidence}`;
  });

  return `Failure attribution (${attributions.length} signal${attributions.length > 1 ? "s" : ""}):\n${lines.join("\n")}`;
}

/**
 * Return the highest-confidence attribution, or null if none.
 */
export function getTopAttribution(
  attributions: ComponentAttribution[],
): ComponentAttribution | null {
  if (attributions.length === 0) return null;
  return attributions.reduce((best, cur) => (cur.confidence > best.confidence ? cur : best));
}
