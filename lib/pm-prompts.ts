/**
 * PM Agent Prompts Library
 *
 * Pure functions returning structured prompt strings for PM Agent capabilities.
 * Prompts are separated from orchestration logic for independent iteration.
 */

// ─── Context Types ───────────────────────────────────────────────────────────

export interface WorkItemSummary {
  id: string;
  title: string;
  repo: string;
  status: string;
  priority: string;
  triagePriority?: string;
  rank?: number;
  createdAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
}

export interface PipelineState {
  inFlight: number;
  queued: number;
  concurrencyLimit: number;
}

export interface BacklogReviewContext {
  workItems: WorkItemSummary[];
  projects: ProjectSummary[];
  pipelineState: PipelineState;
}

export interface ProjectHealthSummary {
  id: string;
  name: string;
  status: string;
  itemCount: number;
  completedCount: number;
  escalations: number;
  blockedItems: number;
  avgQueueTime: number; // minutes
}

export interface HealthAssessmentContext {
  projects: ProjectHealthSummary[];
}

export interface AvailableItem {
  id: string;
  title: string;
  repo: string;
  priority: string;
  triagePriority?: string;
  rank?: number;
  dependencies: string[];
}

export interface NextBatchPipelineState {
  inFlight: number;
  queued: number;
  recentlyMerged: string[];
  recentlyFailed: string[];
}

export interface NextBatchContext {
  pipelineState: NextBatchPipelineState;
  availableItems: AvailableItem[];
}

export interface DigestProjectSummary {
  name: string;
  status: string;
  delta: string;
}

export interface BugsSummary {
  newCount: number;
  fixedCount: number;
  fixedWithPRs: Array<{ title: string; prUrl: string }>;
  openBySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface DigestContext {
  period: string;
  stats: {
    merged: number;
    failed: number;
    blocked: number;
    escalations: number;
  };
  projectSummaries: DigestProjectSummary[];
  recommendations: string[];
  bugs?: BugsSummary;
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

/**
 * Builds a prompt instructing Claude to review the work item backlog and produce
 * prioritized dispatch/defer/kill recommendations.
 *
 * Expected output: JSON matching BacklogReview structure.
 */
export function buildBacklogReviewPrompt(context: BacklogReviewContext): string {
  const { workItems, projects, pipelineState } = context;

  const workItemsJson = JSON.stringify(workItems, null, 2);
  const projectsJson = JSON.stringify(projects, null, 2);
  const capacity = pipelineState.concurrencyLimit - pipelineState.inFlight;

  return `You are a PM Agent responsible for managing a software development pipeline. Your job is to review the current work item backlog and produce clear, actionable prioritization recommendations.

## Current Pipeline State

- In-flight executions: ${pipelineState.inFlight}
- Queued items: ${pipelineState.queued}
- Concurrency limit: ${pipelineState.concurrencyLimit}
- Available capacity: ${capacity} slot(s)

## Active Projects

${projectsJson}

## Work Items Backlog

${workItemsJson}

## Your Task

Review all work items above and produce prioritized recommendations. For each item, decide one of:
- **dispatch**: Should be dispatched now (high value, unblocked, fits capacity)
- **defer**: Should wait (lower priority, dependencies not met, or pipeline at capacity)
- **kill**: Should be cancelled (stale, duplicate, no longer relevant, or permanently blocked)

## Constraints

- Be specific: always cite item IDs in your recommendations
- Provide a concise rationale (1–2 sentences) for each recommendation
- Consider repo distribution — avoid saturating a single repo
- Prioritize items that unblock other items (dependency-chain awareness)
- Use \`triagePriority\` (P0/P1/P2) and \`rank\` (lower = higher priority) when present to inform dispatch ordering
- Flag any items that appear stale (created long ago, low priority, no project linkage)
- Respect the concurrency limit — do not recommend dispatching more items than available capacity

## Output Format

Respond with a single JSON object matching this structure exactly:

{
  "recommendations": [
    {
      "itemId": "<work item id>",
      "action": "dispatch" | "defer" | "kill",
      "rationale": "<1-2 sentence explanation>",
      "priority": <number 1-10, 10 = highest>
    }
  ],
  "summary": "<2-3 sentence overall backlog health assessment>",
  "dispatchOrder": ["<itemId>", ...],
  "flags": [
    {
      "itemId": "<work item id>",
      "issue": "<description of concern>"
    }
  ]
}

Do not include any text outside the JSON object.`;
}

/**
 * Builds a prompt instructing Claude to assess the health of each project,
 * flagging stalling projects, high escalation rates, and long queue times.
 *
 * Expected output: JSON matching ProjectHealthReport structure.
 */
export function buildHealthAssessmentPrompt(context: HealthAssessmentContext): string {
  const { projects } = context;
  const projectsJson = JSON.stringify(projects, null, 2);

  return `You are a PM Agent responsible for monitoring project health in a software development pipeline. Your job is to assess the health of each active project and surface risks early.

## Projects Under Review

${projectsJson}

## Field Definitions

- \`itemCount\`: total work items in the project
- \`completedCount\`: work items that have been merged/completed
- \`escalations\`: number of escalations raised in this project
- \`blockedItems\`: items currently in blocked state
- \`avgQueueTime\`: average minutes work items spend in queue before execution

## Your Task

For each project, assess its health and assign a status of:
- **healthy**: progressing well, no significant concerns
- **at_risk**: showing warning signs — flag the specific concern
- **stalling**: little or no progress, intervention likely needed
- **critical**: severe issues requiring immediate human attention

## Constraints

- Always cite the project ID when referencing a project
- Flag any project where escalations > 2 as at minimum at_risk
- Flag any project where blockedItems / itemCount > 0.3 (30%) as at minimum at_risk
- Flag any project where avgQueueTime > 120 minutes as at minimum at_risk
- Flag any project where completedCount / itemCount < 0.1 and itemCount > 5 as potentially stalling
- Provide specific, actionable recommendations — not vague advice

## Output Format

Respond with a single JSON object matching this structure exactly:

{
  "projectReports": [
    {
      "projectId": "<project id>",
      "projectName": "<project name>",
      "healthStatus": "healthy" | "at_risk" | "stalling" | "critical",
      "completionRate": <number 0.0-1.0>,
      "concerns": ["<specific concern>", ...],
      "recommendations": ["<specific actionable recommendation>", ...],
      "urgency": "low" | "medium" | "high" | "immediate"
    }
  ],
  "overallPipelineHealth": "healthy" | "at_risk" | "stalling" | "critical",
  "topRisks": ["<risk description citing project IDs>", ...],
  "immediateActions": ["<action item>", ...]
}

Do not include any text outside the JSON object.`;
}

/**
 * Builds a prompt instructing Claude to recommend the next 3–5 items to dispatch,
 * considering dependencies, repo distribution, and recent failures.
 *
 * Expected output: JSON array of item IDs with rationale.
 */
export function buildNextBatchPrompt(context: NextBatchContext): string {
  const { pipelineState, availableItems } = context;

  const availableItemsJson = JSON.stringify(availableItems, null, 2);
  const recentlyMerged = pipelineState.recentlyMerged.length > 0
    ? pipelineState.recentlyMerged.join(', ')
    : 'none';
  const recentlyFailed = pipelineState.recentlyFailed.length > 0
    ? pipelineState.recentlyFailed.join(', ')
    : 'none';

  return `You are a PM Agent responsible for deciding which work items to dispatch next in a software development pipeline. Your goal is to maximize throughput while avoiding conflicts and respecting dependencies.

## Current Pipeline State

- In-flight executions: ${pipelineState.inFlight}
- Queued items: ${pipelineState.queued}
- Recently merged item IDs: ${recentlyMerged}
- Recently failed item IDs: ${recentlyFailed}

## Available Items for Dispatch

These items are ready to dispatch (dependencies met, not blocked):

${availableItemsJson}

## Your Task

Select the next 3–5 items to dispatch from the available items list. Your selection should optimize for:

1. **Dependency unblocking**: prefer items that will unblock many downstream items
2. **Repo distribution**: avoid dispatching multiple items to the same repo simultaneously
3. **Priority**: higher priority items should generally be preferred. Use \`triagePriority\` (P0 > P1 > P2) and \`rank\` (lower number = higher priority) when present
4. **Failure avoidance**: do not re-dispatch recently failed items without good reason — if you recommend a recently failed item, explain why
5. **Parallelism**: prefer items that can safely run in parallel (different repos, no shared dependencies)

## Constraints

- Only recommend items from the available items list (cite their exact IDs)
- Recommend between 3 and 5 items total
- Do not recommend more items than would keep total in-flight + queued under a reasonable limit
- Provide a specific rationale for each selection citing the item ID
- If a recently failed item is recommended, explicitly acknowledge the failure and justify re-dispatch
- If fewer than 3 items are available, recommend all available items and explain

## Output Format

Respond with a single JSON array matching this structure exactly:

[
  {
    "itemId": "<work item id>",
    "title": "<item title>",
    "repo": "<target repo>",
    "rationale": "<specific reason this item should be dispatched now>",
    "dispatchOrder": <integer 1-5, 1 = dispatch first>
  }
]

Do not include any text outside the JSON array.`;
}

/**
 * Builds a prompt instructing Claude to compose a scannable progress digest email body
 * including a scorecard, per-project status, and action items.
 *
 * Expected output: plain text email body.
 */
export function buildDigestPrompt(context: DigestContext): string {
  const { period, stats, projectSummaries, recommendations } = context;

  const projectSummariesText = projectSummaries
    .map(p => `  - ${p.name} [${p.status}]: ${p.delta}`)
    .join('\n');

  const recommendationsText = recommendations
    .map((r, i) => `  ${i + 1}. ${r}`)
    .join('\n');

  let bugsSection = '';
  if (context.bugs) {
    const { newCount, fixedCount, fixedWithPRs, openBySeverity } = context.bugs;
    const { critical, high, medium, low } = openBySeverity;
    const totalOpen = critical + high + medium + low;

    const fixedPRList =
      fixedWithPRs.length > 0
        ? fixedWithPRs.map((b) => `  - ${b.title}: ${b.prUrl}`).join('\n')
        : '';

    bugsSection = `
## Bugs (last 24h)

- New bugs filed: ${newCount}
- Bugs fixed: ${fixedCount}
${fixedWithPRs.length > 0 ? `  Fixed bugs with PRs:\n${fixedPRList}\n` : ''}- Open bugs: ${totalOpen} total (${critical} critical, ${high} high, ${medium} medium, ${low} low)

Generate a concise bugs paragraph summarizing the above. Highlight if there are critical open bugs or a spike in new filings.
`;
  }

  return `You are a PM Agent composing a concise, scannable progress digest email for a software development pipeline. Your audience is a technical project owner who reviews this digest quickly — keep it clear, direct, and actionable.

## Digest Period

${period}

## Pipeline Scorecard

- Items merged (completed): ${stats.merged}
- Items failed: ${stats.failed}
- Items currently blocked: ${stats.blocked}
- Escalations raised: ${stats.escalations}

## Per-Project Status

${projectSummariesText}

## Recommended Actions

${recommendationsText}
${bugsSection}
## Your Task

Compose a plain text email body for this digest. The email should be:
- Scannable: use clear section headers, short paragraphs, and bullet points
- Specific: reference project names and concrete numbers
- Action-oriented: make it obvious what (if anything) requires human attention
- Concise: total length should be under 400 words

## Email Structure

Your digest must include these sections in order:
1. **Subject line** (prefix with "SUBJECT: " on its own line)
2. **Summary** (2-3 sentences: overall pipeline health this period)
3. **Scorecard** (formatted table or bullet list of the key metrics)
4. **Project Status** (one line per project with status indicator: ✅ healthy, ⚠️ at risk, 🔴 critical)
5. **Action Items** (numbered list — only include if there are actual actions needed; omit section if none)
6. **Closing** (single sentence, e.g., "Next digest in 24 hours." or similar)

## Constraints

- Use plain text only — no HTML, no markdown headers with #, no code blocks
- Section headers should be in ALL CAPS followed by a colon (e.g., SCORECARD:)
- Keep each project status line to one line maximum
- If stats.escalations > 0, the summary must mention escalations explicitly
- If stats.failed > 0, the summary must mention failures explicitly
- Action items must be specific and reference project names or item counts

## Output Format

Output the plain text email body only. Begin with the SUBJECT: line. Do not include any preamble or explanation outside the email body itself.`;
}

/**
 * Builds a prompt instructing Claude to detect technical uncertainty in a PRD
 * and recommend a feasibility spike if uncertainty signals are found.
 *
 * Expected output: JSON with uncertaintySignals, recommendedScope, technicalQuestion.
 */
export function buildUncertaintyDetectionPrompt(prdContent: string): string {
  return `You are a PM Agent analyzing a PRD (Product Requirements Document) for technical uncertainty. Your job is to identify signals that suggest a feasibility spike is needed before committing to full implementation.

## PRD Content

${prdContent}

## Uncertainty Signal Categories

Look for the following categories of uncertainty:

1. **Unknown API access**: References to APIs, services, or data sources where access, availability, or rate limits are unclear
2. **New platforms**: Mentions of platforms, frameworks, or environments the team hasn't used before
3. **Unproven approaches**: Novel algorithms, architectures, or techniques that haven't been validated
4. **External service dependencies**: Reliance on third-party services where reliability, cost, or integration complexity is uncertain
5. **Hardware integrations**: References to hardware, devices, sensors, or physical systems
6. **Explicit uncertainty language**: Phrases like "not sure if", "need to investigate", "TBD", "to be determined", "might not work", "unclear whether", "research needed", "unknown if", "may require"

## Your Task

Analyze the PRD content above and identify any technical uncertainty signals. For each signal found, provide a concise description of the uncertainty.

If uncertainty signals are found, also provide:
- A recommended scope for a feasibility spike (1-2 sentences describing what to investigate)
- A single technical question that the spike should answer

If NO uncertainty signals are found, return empty values.

## Output Format

Respond with a single JSON object matching this structure exactly:

{
  "uncertaintySignals": ["<signal description>", ...],
  "recommendedScope": "<1-2 sentence spike scope, or empty string if no uncertainty>",
  "technicalQuestion": "<the key technical question to answer, or empty string if no uncertainty>"
}

Do not include any text outside the JSON object.`;
}

