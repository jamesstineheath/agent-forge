# Agent Forge -- A3: Core PM Agent Module

## Metadata
- **Branch:** `feat/a3-pm-agent-core`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/pm-agent.ts

## Context

This is the third task in the PM Agent series. A1 added types to `lib/types.ts` (BacklogReview, ProjectHealth, ProjectHealthReport, PMAgentConfig, DigestOptions) and A2 created the prompts library in `lib/pm-prompts.ts`. This task wires those together into the core PM Agent module.

The pattern to follow is `lib/decomposer.ts`, which uses `@ai-sdk/anthropic` and `generateText` from the `ai` package to call Claude. Look at that file before writing anything — match its import style, model string, error handling, and API call pattern exactly.

Key dependencies already in the repo:
- `lib/types.ts` — all PM Agent types (BacklogReview, ProjectHealth, ProjectHealthReport, PMAgentConfig, DigestOptions, WorkItem, Project, etc.)
- `lib/pm-prompts.ts` — buildBacklogReviewPrompt, buildHealthAssessmentPrompt, buildNextBatchPrompt, buildDigestPrompt
- `lib/work-items.ts` — work item CRUD (getAllWorkItems or equivalent)
- `lib/projects.ts` — project state reads
- `lib/notion.ts` — Notion API client
- `lib/gmail.ts` — send email summaries
- `lib/storage.ts` — Vercel Blob read/write (saveData, loadData or equivalent)
- `@ai-sdk/anthropic` + `ai` — already installed

Storage paths:
- `af-data/pm-agent/latest-review.json`
- `af-data/pm-agent/latest-health.json`
- `af-data/pm-agent/latest-digest.json`

ATC state lives in Vercel Blob at `af-data/atc/` — look at `lib/atc.ts` to understand the exact keys used for active executions and queue state before reading them in pm-agent.ts.

## Requirements

1. `lib/pm-agent.ts` exists and exports `reviewBacklog`, `assessProjectHealth`, `suggestNextBatch`, and `composeDigest`
2. `reviewBacklog()` fetches work items and projects, builds prompt via `buildBacklogReviewPrompt()`, calls Claude API (model: `claude-sonnet-4-5`), parses response into `BacklogReview`, persists to `af-data/pm-agent/latest-review.json`, sends Gmail summary, and returns the result
3. `assessProjectHealth()` computes per-project metrics (completion rate, escalation count, avg time in queue, blocked items), builds prompt via `buildHealthAssessmentPrompt()`, calls Claude API, parses response into `ProjectHealthReport`, persists to `af-data/pm-agent/latest-health.json`, and returns the result
4. `suggestNextBatch()` reads pipeline state and available items, builds prompt via `buildNextBatchPrompt()`, calls Claude API, and returns `{items: string[], rationale: string}`
5. `composeDigest(options: DigestOptions)` aggregates stats from recent reviews/health assessments, builds prompt via `buildDigestPrompt()`, calls Claude API, persists to `af-data/pm-agent/latest-digest.json`, and returns a formatted string
6. All functions use prompts from `lib/pm-prompts.ts` — no inline prompt strings
7. File compiles without TypeScript errors
8. Claude API call pattern matches `lib/decomposer.ts` exactly (same import, same model string format, same generateText usage)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/a3-pm-agent-core
```

### Step 1: Read existing code for patterns

Read these files carefully before writing anything:

```bash
cat lib/decomposer.ts       # Claude API call pattern — must match this exactly
cat lib/types.ts            # All PM Agent types
cat lib/pm-prompts.ts       # All prompt builder functions and their signatures
cat lib/work-items.ts       # How to fetch work items (find getAllWorkItems or equivalent)
cat lib/projects.ts         # How to fetch projects
cat lib/gmail.ts            # How to send email summaries (find the send function)
cat lib/storage.ts          # saveData / loadData signatures
cat lib/atc.ts              # ATC state keys in Vercel Blob (look for af-data/atc/ reads)
```

Note the exact:
- Import path for `anthropic` from `@ai-sdk/anthropic`
- Import for `generateText` from `ai`
- Model string used (e.g., `claude-sonnet-4-5` or whatever decomposer.ts uses)
- How `generateText` is called (prompt vs messages, temperature, etc.)
- How storage save/load is called
- How Gmail send is called
- Exact ATC blob keys for active executions and queue depth

### Step 2: Implement lib/pm-agent.ts

Create `lib/pm-agent.ts`. The structure below is a guide — adapt function signatures and imports to match what actually exists in the dependency files.

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { getAllWorkItems } from './work-items';         // adjust to actual export name
import { getProjects } from './projects';               // adjust to actual export name
import { sendEmailSummary } from './gmail';             // adjust to actual export name
import { saveData, loadData } from './storage';         // adjust to actual export names
import {
  buildBacklogReviewPrompt,
  buildHealthAssessmentPrompt,
  buildNextBatchPrompt,
  buildDigestPrompt,
} from './pm-prompts';
import type {
  BacklogReview,
  ProjectHealth,
  ProjectHealthReport,
  PMAgentConfig,
  DigestOptions,
  WorkItem,
  Project,
} from './types';

// Storage keys
const STORAGE_KEYS = {
  latestReview: 'af-data/pm-agent/latest-review.json',
  latestHealth: 'af-data/pm-agent/latest-health.json',
  latestDigest: 'af-data/pm-agent/latest-digest.json',
} as const;

// ATC state keys — confirm these against lib/atc.ts
const ATC_KEYS = {
  activeExecutions: 'af-data/atc/active-executions.json',
  queue: 'af-data/atc/queue.json',
} as const;

// Model — must match decomposer.ts
const MODEL = 'claude-sonnet-4-5';  // replace with whatever decomposer.ts uses

/**
 * Reads pipeline state from ATC blob storage.
 * Returns inFlightCount and queueDepth.
 */
async function getPipelineState(): Promise<{ inFlightCount: number; queueDepth: number }> {
  try {
    const [activeRaw, queueRaw] = await Promise.all([
      loadData(ATC_KEYS.activeExecutions),
      loadData(ATC_KEYS.queue),
    ]);
    const active = activeRaw ? JSON.parse(activeRaw) : {};
    const queue = queueRaw ? JSON.parse(queueRaw) : [];
    const inFlightCount = Array.isArray(active) ? active.length : Object.keys(active).length;
    const queueDepth = Array.isArray(queue) ? queue.length : 0;
    return { inFlightCount, queueDepth };
  } catch {
    return { inFlightCount: 0, queueDepth: 0 };
  }
}

/**
 * Calls Claude API with a prompt string.
 * Matches the pattern in lib/decomposer.ts exactly.
 */
async function callClaude(prompt: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic(MODEL),
    prompt,
  });
  return text;
}

/**
 * Safely parse JSON from Claude response.
 * Claude sometimes wraps JSON in markdown code fences — strip them first.
 */
function parseJson<T>(raw: string): T {
  const stripped = raw
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  return JSON.parse(stripped) as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. reviewBacklog
// ─────────────────────────────────────────────────────────────────────────────

export async function reviewBacklog(): Promise<BacklogReview> {
  // Fetch all data needed for the review
  const [workItems, projects, pipelineState] = await Promise.all([
    getAllWorkItems(),
    getProjects(),
    getPipelineState(),
  ]);

  // Build prompt using pm-prompts.ts
  const prompt = buildBacklogReviewPrompt({
    workItems,
    projects,
    pipelineState,
  });

  // Call Claude
  const raw = await callClaude(prompt);

  // Parse response
  const review = parseJson<BacklogReview>(raw);

  // Persist to Vercel Blob
  await saveData(STORAGE_KEYS.latestReview, JSON.stringify(review, null, 2));

  // Send Gmail summary
  // Adjust sendEmailSummary call to match actual gmail.ts signature
  await sendEmailSummary({
    subject: `PM Agent: Backlog Review — ${new Date().toLocaleDateString()}`,
    body: `Backlog review completed.\n\nSummary:\n${review.summary ?? JSON.stringify(review, null, 2)}`,
  }).catch((err) => {
    console.error('[pm-agent] Gmail send failed (non-fatal):', err);
  });

  return review;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. assessProjectHealth
// ─────────────────────────────────────────────────────────────────────────────

export async function assessProjectHealth(): Promise<ProjectHealthReport> {
  const [workItems, projects] = await Promise.all([
    getAllWorkItems(),
    getProjects(),
  ]);

  // Compute per-project metrics
  const projectHealthInputs = projects.map((project: Project) => {
    const projectItems = workItems.filter(
      (item: WorkItem) => item.projectId === project.id
    );
    const totalItems = projectItems.length;
    const mergedItems = projectItems.filter(
      (item: WorkItem) => item.status === 'merged'
    ).length;
    const blockedItems = projectItems.filter(
      (item: WorkItem) => item.status === 'blocked'
    ).length;
    const escalationCount = projectItems.filter(
      (item: WorkItem) => item.status === 'blocked'
    ).length; // adjust if escalation is tracked differently

    // Avg time in queue (ms) for items that have left queued state
    const queuedItems = projectItems.filter(
      (item: WorkItem) => item.queuedAt && item.executingAt
    );
    const avgTimeInQueue =
      queuedItems.length > 0
        ? queuedItems.reduce((sum: number, item: WorkItem) => {
            const queued = item.queuedAt ? new Date(item.queuedAt).getTime() : 0;
            const executing = item.executingAt
              ? new Date(item.executingAt).getTime()
              : 0;
            return sum + (executing - queued);
          }, 0) / queuedItems.length
        : 0;

    const completionRate = totalItems > 0 ? mergedItems / totalItems : 0;

    return {
      project,
      metrics: {
        totalItems,
        mergedItems,
        blockedItems,
        escalationCount,
        avgTimeInQueueMs: avgTimeInQueue,
        completionRate,
      },
    };
  });

  // Build prompt
  const prompt = buildHealthAssessmentPrompt({ projectHealthInputs });

  // Call Claude
  const raw = await callClaude(prompt);

  // Parse response
  const healthReport = parseJson<ProjectHealthReport>(raw);

  // Persist
  await saveData(STORAGE_KEYS.latestHealth, JSON.stringify(healthReport, null, 2));

  return healthReport;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. suggestNextBatch
// ─────────────────────────────────────────────────────────────────────────────

export async function suggestNextBatch(): Promise<{ items: string[]; rationale: string }> {
  const [workItems, pipelineState] = await Promise.all([
    getAllWorkItems(),
    getPipelineState(),
  ]);

  // Filter to ready, non-blocked items
  const availableItems = workItems.filter(
    (item: WorkItem) => item.status === 'ready'
  );

  // Build prompt
  const prompt = buildNextBatchPrompt({
    availableItems,
    pipelineState,
  });

  // Call Claude
  const raw = await callClaude(prompt);

  // Parse response
  const result = parseJson<{ items: string[]; rationale: string }>(raw);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. composeDigest
// ─────────────────────────────────────────────────────────────────────────────

export async function composeDigest(options: DigestOptions): Promise<string> {
  // Load recent review and health data (may not exist yet — handle gracefully)
  const [reviewRaw, healthRaw] = await Promise.all([
    loadData(STORAGE_KEYS.latestReview).catch(() => null),
    loadData(STORAGE_KEYS.latestHealth).catch(() => null),
  ]);

  const latestReview: BacklogReview | null = reviewRaw
    ? parseJson<BacklogReview>(reviewRaw)
    : null;
  const latestHealth: ProjectHealthReport | null = healthRaw
    ? parseJson<ProjectHealthReport>(healthRaw)
    : null;

  // Aggregate stats
  const [workItems, pipelineState] = await Promise.all([
    getAllWorkItems(),
    getPipelineState(),
  ]);

  const stats = {
    totalWorkItems: workItems.length,
    byStatus: workItems.reduce((acc: Record<string, number>, item: WorkItem) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {}),
    pipelineState,
  };

  // Build prompt
  const prompt = buildDigestPrompt({
    options,
    latestReview,
    latestHealth,
    stats,
  });

  // Call Claude
  const digestText = await callClaude(prompt);

  // Persist
  const digestRecord = {
    generatedAt: new Date().toISOString(),
    options,
    digest: digestText,
  };
  await saveData(STORAGE_KEYS.latestDigest, JSON.stringify(digestRecord, null, 2));

  return digestText;
}
```

**Important notes while implementing:**

1. **Match decomposer.ts exactly** for Claude API calls — if it uses `messages` instead of `prompt`, use that. If it passes `temperature`, include it. Do not guess; read the file first.

2. **Match actual function signatures** from each dependency. The code above uses placeholder names like `getAllWorkItems()`, `getProjects()`, `sendEmailSummary()`, `saveData()`, `loadData()` — replace with whatever is actually exported.

3. **Match actual type field names** — `item.projectId`, `item.status`, `item.queuedAt`, `item.executingAt` are guesses based on the work item domain. Check `lib/types.ts` for the real field names.

4. **Match prompt builder signatures** — `buildBacklogReviewPrompt({ workItems, projects, pipelineState })` is illustrative. Check `lib/pm-prompts.ts` for the actual parameter shapes and adjust accordingly.

5. **ATC state shape** — check `lib/atc.ts` for how active executions and queue are stored. The blob keys and JSON shape may differ from the placeholders above.

6. **Gmail send signature** — `lib/gmail.ts` may have a different function name or signature. Read it and adapt.

7. **Model string** — use whatever model string `lib/decomposer.ts` actually uses, not the placeholder above.

### Step 3: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `WorkItem` field names not matching what's in `lib/types.ts`
- Prompt builder parameter shapes not matching `lib/pm-prompts.ts`
- `loadData`/`saveData` not accepting string content (may need `Buffer` or specific types)
- `getProjects()` returning a different type than `Project[]`

### Step 4: Lint check

```bash
npm run lint 2>&1 | head -50
```

Fix any lint errors in `lib/pm-agent.ts`.

### Step 5: Build check

```bash
npm run build 2>&1 | tail -30
```

If build fails due to environment variables not available at build time, verify that `lib/pm-agent.ts` doesn't do any top-level awaits or module-level side effects that require env vars. All data fetching must be inside the exported functions.

### Step 6: Commit, push, open PR

```bash
git add lib/pm-agent.ts
git commit -m "feat: A3 core PM Agent module (reviewBacklog, assessProjectHealth, suggestNextBatch, composeDigest)"
git push origin feat/a3-pm-agent-core
gh pr create \
  --title "feat: A3 Core PM Agent Module" \
  --body "## Summary

Creates \`lib/pm-agent.ts\` — the core PM Agent module with four exported functions:

- \`reviewBacklog()\` — fetches work items + projects, calls Claude, persists to \`af-data/pm-agent/latest-review.json\`, sends Gmail summary
- \`assessProjectHealth()\` — computes per-project metrics, calls Claude, persists to \`af-data/pm-agent/latest-health.json\`
- \`suggestNextBatch()\` — reads pipeline state + available items, calls Claude, returns recommendations
- \`composeDigest(options)\` — aggregates recent review/health data, calls Claude, returns formatted email body

## Dependencies
- A1: PM Agent Types (lib/types.ts) ✅
- A2: PM Agent Prompts Library (lib/pm-prompts.ts) ✅

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes

## Storage Keys
- \`af-data/pm-agent/latest-review.json\`
- \`af-data/pm-agent/latest-health.json\`
- \`af-data/pm-agent/latest-digest.json\`
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
   ```bash
   git add lib/pm-agent.ts
   git commit -m "feat: A3 PM agent module (partial)"
   git push origin feat/a3-pm-agent-core
   ```
2. Open PR with partial status:
   ```bash
   gh pr create --title "feat: A3 Core PM Agent Module [PARTIAL]" --body "Partial implementation — see issues below."
   ```
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/a3-pm-agent-core
FILES CHANGED: lib/pm-agent.ts
SUMMARY: [what was implemented]
ISSUES: [what failed — include tsc error output if relevant]
NEXT STEPS: [e.g., "fix type mismatch in WorkItem.projectId — actual field name is X per lib/types.ts"]
```