// lib/pm-prompts.ts
// Structured prompt-generation functions for the PM Agent capabilities.
// Each function accepts a typed context object and returns a prompt string
// to be sent to Claude via the AI SDK.

export function buildBacklogReviewPrompt(context: {
  workItems: {
    id: string;
    title: string;
    status: string;
    repo: string;
    priority: string;
    createdAt: string;
  }[];
  projects: {
    id: string;
    name: string;
    status: string;
  }[];
  pipelineState: {
    inFlight: number;
    concurrencyLimit: number;
    recentMerges: number;
    recentFailures: number;
  };
}): string {
  return `## Task
You are an autonomous PM Agent for a software development orchestration platform (Agent Forge).
Review the current backlog of work items and categorize each one by recommended action.

## Pipeline State
\`\`\`json
${JSON.stringify(context.pipelineState, null, 2)}
\`\`\`

## Active Projects
\`\`\`json
${JSON.stringify(context.projects, null, 2)}
\`\`\`

## Work Items (Backlog)
\`\`\`json
${JSON.stringify(context.workItems, null, 2)}
\`\`\`

## Instructions
For each work item, assign exactly one of the following actions:
- **dispatch**: Ready to execute now (dependencies met, pipeline has capacity, priority warrants it)
- **defer**: Not ready yet (blocked, low priority, pipeline saturated, or waiting on dependency)
- **kill**: Should be cancelled (stale, duplicate, superseded, or no longer relevant)
- **escalate**: Needs human attention (stuck, ambiguous, requires decision beyond automation)

Consider the pipeline state (in-flight vs concurrency limit, recent failure rate) when making dispatch recommendations.
Provide a brief rationale for each item. Then provide an overall summary.

## Output Format
Respond with valid JSON only. No markdown outside the JSON block. Use this schema:

\`\`\`json
{
  "summary": "Brief overall assessment of backlog health",
  "recommendations": [
    {
      "workItemId": "string",
      "action": "dispatch | defer | kill | escalate",
      "rationale": "One sentence explanation"
    }
  ],
  "stats": {
    "dispatch": 0,
    "defer": 0,
    "kill": 0,
    "escalate": 0
  }
}
\`\`\``;
}

export function buildHealthAssessmentPrompt(context: {
  project: {
    id: string;
    name: string;
    status: string;
  };
  workItems: {
    id: string;
    title: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }[];
  escalations: {
    id: string;
    status: string;
    createdAt: string;
  }[];
}): string {
  return `## Task
You are an autonomous PM Agent for Agent Forge, a dev orchestration platform.
Assess the health of the following project and identify any stalling signals or issues requiring attention.

## Project
\`\`\`json
${JSON.stringify(context.project, null, 2)}
\`\`\`

## Work Items
\`\`\`json
${JSON.stringify(context.workItems, null, 2)}
\`\`\`

## Escalations
\`\`\`json
${JSON.stringify(context.escalations, null, 2)}
\`\`\`

## Instructions
Analyze the project health by considering:
- Work item velocity (are items moving through statuses or stalling?)
- Age of items in non-terminal statuses (filed, queued, executing, reviewing)
- Ratio of pending escalations to total work items
- Time since last status update (use updatedAt vs current time context)
- Whether the project is on track, at risk, or blocked

Identify specific stalling signals: items stuck in "executing" >24h, items in "blocked" state, unresolved escalations older than 48h, etc.

## Output Format
Respond with valid JSON only. No markdown outside the JSON block. Use this schema:

\`\`\`json
{
  "healthStatus": "healthy | at-risk | blocked | stalled",
  "completionRate": 0.0,
  "stallingSignals": [
    {
      "type": "string (e.g., stuck_executing | unresolved_escalation | stale_item)",
      "workItemId": "string or null",
      "description": "Brief description of the issue",
      "severity": "low | medium | high"
    }
  ],
  "summary": "2-3 sentence overall health assessment",
  "recommendedAction": "string describing what should happen next, or null if healthy"
}
\`\`\``;
}

export function buildNextBatchPrompt(context: {
  pipelineState: {
    inFlight: number;
    concurrencyLimit: number;
    availableSlots: number;
  };
  readyItems: {
    id: string;
    title: string;
    repo: string;
    priority: string;
    complexity: string;
  }[];
  activeProjects: {
    id: string;
    name: string;
    status: string;
    pendingItems: number;
  }[];
}): string {
  return `## Task
You are an autonomous PM Agent for Agent Forge, a dev orchestration platform.
Recommend the next batch of work items to dispatch into the execution pipeline.

## Pipeline State
\`\`\`json
${JSON.stringify(context.pipelineState, null, 2)}
\`\`\`

## Ready Items (Eligible for Dispatch)
\`\`\`json
${JSON.stringify(context.readyItems, null, 2)}
\`\`\`

## Active Projects
\`\`\`json
${JSON.stringify(context.activeProjects, null, 2)}
\`\`\`

## Instructions
Select 3-5 items from the ready items list to dispatch next. Optimize for:
1. **Priority**: Higher priority items first
2. **Pipeline balance**: Avoid saturating a single repo; spread load across repos when possible
3. **Project momentum**: Prefer items belonging to projects with high pendingItems to unblock projects
4. **Complexity fit**: In a saturated pipeline (availableSlots <= 1), prefer simple items; when slots are available, complex items are acceptable
5. **Do not exceed availableSlots**: Never recommend more items than there are available slots

If availableSlots is 0, recommend an empty list.

## Output Format
Respond with valid JSON only. No markdown outside the JSON block. Use this schema:

\`\`\`json
{
  "recommended": [
    {
      "workItemId": "string",
      "reason": "One sentence explaining why this item was selected"
    }
  ],
  "skipped": [
    {
      "workItemId": "string",
      "reason": "One sentence explaining why this item was not selected"
    }
  ],
  "summary": "Brief explanation of the overall dispatch strategy for this batch"
}
\`\`\``;
}

export function buildDigestPrompt(context: {
  backlogReview?: {
    summary: string;
    recommendations: {
      action: string;
      count: number;
    }[];
  };
  projectHealths: {
    name: string;
    status: string;
    completionRate: number;
  }[];
  pipelineDelta: {
    merged: number;
    failed: number;
    blocked: number;
    escalationsPending: number;
  };
}): string {
  return `## Task
You are an autonomous PM Agent for Agent Forge, a dev orchestration platform.
Compose a concise, scannable progress digest email summarizing current system state.

## Pipeline Delta (Since Last Digest)
\`\`\`json
${JSON.stringify(context.pipelineDelta, null, 2)}
\`\`\`

## Project Health Summary
\`\`\`json
${JSON.stringify(context.projectHealths, null, 2)}
\`\`\`

${
  context.backlogReview
    ? `## Backlog Review Summary
\`\`\`json
${JSON.stringify(context.backlogReview, null, 2)}
\`\`\``
    : `## Backlog Review
No backlog review available for this digest period.`
}

## Instructions
Compose a digest email that is:
- **Scannable**: Use bullet points and short sections, not dense paragraphs
- **Action-oriented**: Highlight items needing human attention first
- **Concise**: Entire email should be readable in under 2 minutes
- **Honest**: Surface failures and blockers clearly, not buried

Structure the email with these sections (include only sections with relevant content):
1. **🚦 Status at a Glance** — one-line summary of system health
2. **✅ Progress** — merged count, any notable completions
3. **⚠️ Attention Required** — failures, blocked items, pending escalations
4. **📋 Backlog** — brief backlog action summary (if backlogReview is provided)
5. **🏗️ Projects** — per-project status with completion rates

## Output Format
Respond with valid JSON only. No markdown outside the JSON block. Use this schema:

\`\`\`json
{
  "subject": "Agent Forge Digest — [date/period summary]",
  "body": "Full email body as a plain text string with newlines (\\n) for line breaks. Use emoji section headers as described above.",
  "urgencyLevel": "normal | attention-needed | critical",
  "highlights": [
    "One-line bullet string summarizing a key point"
  ]
}
\`\`\``;
}
