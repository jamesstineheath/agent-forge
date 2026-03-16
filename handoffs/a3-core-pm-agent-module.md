# Agent Forge -- A3: Core PM Agent Module

## Metadata
- **Branch:** `feat/a3-core-pm-agent-module`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/pm-agent.ts

## Context

This is the third task in the PM Agent series for Agent Forge. The previous tasks (A1 and A2) have already been merged:

- **A1** added PM Agent types to `lib/types.ts`: `BacklogReview`, `ProjectHealth`, `PMAgentConfig`, `DigestOptions`, `WorkItemRecommendation`, `ProjectHealthMetrics`
- **A2** added `lib/pm-prompts.ts` with `buildBacklogReviewPrompt`, `buildHealthAssessmentPrompt`, `buildNextBatchPrompt`, and `buildDigestPrompt` functions

This task creates the core `lib/pm-agent.ts` module that wires together: work items, Notion projects, ATC pipeline state, Claude AI, Vercel Blob storage, and Gmail.

### Key existing patterns to follow

**Claude API pattern** (from `lib/decomposer.ts`):
```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const { text } = await generateText({
  model: anthropic('claude-opus-4-5'),
  messages: [{ role: 'user', content: prompt }],
  maxTokens: 4096,
});
const parsed = JSON.parse(text);
```

**Vercel Blob storage pattern** (from `lib/storage.ts`):
```typescript
import { readBlob, writeBlob, listBlobs } from './storage';

await writeBlob('af-data/pm-agent/reviews/123.json', JSON.stringify(data));
const raw = await readBlob('af-data/atc/state.json');
```

**ATC state shape** (from `lib/atc.ts`): The ATC state is stored in Vercel Blob at `af-data/atc/state.json`. It contains active executions and concurrency info. Read it to determine in-flight count and available pipeline slots.

**Notion projects** (from `lib/notion.ts`): Use `fetchNotionProjects()` or similar to get active projects. Check the actual export from `lib/notion.ts` for the correct function name.

**Work items** (from `lib/work-items.ts`): Use `listWorkItems()` to get all work items. Work items have status fields: `filed`, `ready`, `queued`, `generating`, `executing`, `reviewing`, `merged`, `blocked`, `parked`, `failed`, `cancelled`.

**Gmail** (from `lib/gmail.ts`): Check the actual export for sending email — look for `sendEmail` or a similar function.

**Escalations**: Escalation records are in Vercel Blob at `escalations/*`. Use `listBlobs('escalations/')` and `readBlob()` to fetch them.

## Requirements

1. `lib/pm-agent.ts` must exist and export `reviewBacklog`, `assessProjectHealth`, `suggestNextBatch`, and `composeDigest` functions with the exact signatures described below
2. `reviewBacklog()` must fetch all work items via `listWorkItems()`, fetch active Notion projects, read ATC pipeline state from Vercel Blob, call Claude via `generateText` using `buildBacklogReviewPrompt()`, parse the JSON response into a `BacklogReview` object, persist the result to `af-data/pm-agent/reviews/{timestamp}.json` via Vercel Blob, send a Gmail summary, and return the `BacklogReview`
3. `assessProjectHealth()` must accept an optional `projectId`, fetch relevant work items and escalations, compute metrics (`completionRate`, `avgTimeInQueue`, `blockedItems`, `escalationCount`), call Claude via `buildHealthAssessmentPrompt()`, and return `ProjectHealth[]`
4. `suggestNextBatch()` must read pipeline available slots, get ready work items, get active projects, call Claude via `buildNextBatchPrompt()`, and return `{ workItemIds: string[]; rationale: string }`
5. `composeDigest()` must optionally invoke `reviewBacklog` and `assessProjectHealth`, compute pipeline deltas, call Claude via `buildDigestPrompt()`, send via Gmail if `recipientEmail` is provided, and return the formatted digest string
6. All Claude responses that are expected to be JSON must be parsed defensively (try/catch with fallback)
7. The project must build successfully with `npm run build` and `npx tsc --noEmit`
8. No new dependencies may be added — use only existing packages already in `package.json`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/a3-core-pm-agent-module
```

### Step 1: Inspect existing code to understand exact APIs

Before writing any code, read the following files to understand exact function signatures and exports:

```bash
cat lib/types.ts        # BacklogReview, ProjectHealth, PMAgentConfig, DigestOptions shapes
cat lib/pm-prompts.ts   # buildBacklogReviewPrompt, buildHealthAssessmentPrompt, etc. signatures
cat lib/work-items.ts   # listWorkItems() signature and return type
cat lib/storage.ts      # readBlob, writeBlob, listBlobs function signatures
cat lib/notion.ts       # project-fetching functions available
cat lib/gmail.ts        # email sending functions available
cat lib/atc.ts          # ATCState shape and how pipeline state is structured
cat lib/decomposer.ts   # Claude API call pattern to replicate exactly
cat lib/escalation.ts   # escalation shape / storage keys
```

Take note of:
- Exact type shapes for `BacklogReview`, `ProjectHealth`, `PMAgentConfig`, `DigestOptions`
- What `buildBacklogReviewPrompt`, `buildHealthAssessmentPrompt`, `buildNextBatchPrompt`, `buildDigestPrompt` accept as parameters
- Exact function name for sending email in `lib/gmail.ts`
- Exact function name for fetching Notion projects in `lib/notion.ts`
- The ATC state JSON shape (active executions array, concurrency limit)
- The escalation record shape

### Step 2: Implement `lib/pm-agent.ts`

Create `lib/pm-agent.ts`. Use the patterns discovered in Step 1. The implementation below is a template — **adjust imports and API calls to match actual function signatures** discovered in Step 1.

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import {
  BacklogReview,
  ProjectHealth,
  PMAgentConfig,
  DigestOptions,
  WorkItem,
} from './types';
import {
  buildBacklogReviewPrompt,
  buildHealthAssessmentPrompt,
  buildNextBatchPrompt,
  buildDigestPrompt,
} from './pm-prompts';
import { listWorkItems } from './work-items';
import { readBlob, writeBlob, listBlobs } from './storage';

// ── Helpers ──────────────────────────────────────────────────────────────────

const CLAUDE_MODEL = 'claude-opus-4-5';

async function callClaude(prompt: string, maxTokens = 4096): Promise<string> {
  const { text } = await generateText({
    model: anthropic(CLAUDE_MODEL),
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
  });
  return text;
}

function safeParseJSON<T>(text: string, fallback: T): T {
  try {
    // Claude sometimes wraps JSON in markdown code fences — strip them
    const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    console.error('[pm-agent] Failed to parse Claude JSON response:', text.slice(0, 500));
    return fallback;
  }
}

async function getATCPipelineState(): Promise<{ inFlight: number; concurrencyLimit: number; availableSlots: number }> {
  try {
    const raw = await readBlob('af-data/atc/state.json');
    if (!raw) return { inFlight: 0, concurrencyLimit: 3, availableSlots: 3 };
    const state = JSON.parse(raw);
    // Adjust field names based on actual ATC state shape discovered in Step 1
    const inFlight = Array.isArray(state.activeExecutions) ? state.activeExecutions.length : 0;
    const concurrencyLimit = state.concurrencyLimit ?? 3;
    return { inFlight, concurrencyLimit, availableSlots: Math.max(0, concurrencyLimit - inFlight) };
  } catch {
    return { inFlight: 0, concurrencyLimit: 3, availableSlots: 3 };
  }
}

async function getActiveProjects(): Promise<unknown[]> {
  try {
    // Import and call the correct Notion function discovered in Step 1
    // e.g., const { fetchNotionProjects } = await import('./notion');
    // return await fetchNotionProjects();
    // Adjust based on actual lib/notion.ts exports:
    const notionModule = await import('./notion');
    // Try common function names:
    if (typeof notionModule.fetchNotionProjects === 'function') {
      return await notionModule.fetchNotionProjects();
    }
    if (typeof notionModule.getActiveProjects === 'function') {
      return await notionModule.getActiveProjects();
    }
    if (typeof notionModule.listProjects === 'function') {
      return await notionModule.listProjects();
    }
    console.warn('[pm-agent] No recognized project-fetching function in lib/notion.ts');
    return [];
  } catch (err) {
    console.error('[pm-agent] Failed to fetch Notion projects:', err);
    return [];
  }
}

async function getEscalations(): Promise<unknown[]> {
  try {
    const keys = await listBlobs('escalations/');
    const results = await Promise.allSettled(
      keys.map(async (key: string) => {
        const raw = await readBlob(key);
        return raw ? JSON.parse(raw) : null;
      })
    );
    return results
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled' && r.value !== null)
      .map((r) => r.value);
  } catch {
    return [];
  }
}

async function sendGmailSummary(subject: string, body: string): Promise<void> {
  try {
    const gmailModule = await import('./gmail');
    // Try common function names discovered in Step 1:
    if (typeof gmailModule.sendEmail === 'function') {
      await gmailModule.sendEmail({ subject, body });
    } else if (typeof gmailModule.sendGmail === 'function') {
      await gmailModule.sendGmail(subject, body);
    } else {
      console.warn('[pm-agent] No recognized email-sending function in lib/gmail.ts');
    }
  } catch (err) {
    console.error('[pm-agent] Failed to send Gmail summary:', err);
    // Non-fatal — don't throw
  }
}

// ── Core exports ──────────────────────────────────────────────────────────────

export async function reviewBacklog(config?: Partial<PMAgentConfig>): Promise<BacklogReview> {
  // 1. Fetch all work items
  const workItems = await listWorkItems();

  // 2. Fetch active projects from Notion
  const projects = await getActiveProjects();

  // 3. Get pipeline state
  const pipelineState = await getATCPipelineState();

  // 4. Build prompt
  const prompt = buildBacklogReviewPrompt(workItems, projects, pipelineState);

  // 5. Call Claude, parse JSON response
  const rawResponse = await callClaude(prompt, 4096);
  const defaultBacklogReview: BacklogReview = {
    reviewedAt: new Date().toISOString(),
    totalItems: workItems.length,
    recommendations: [],
    summary: rawResponse,
  };
  const review = safeParseJSON<BacklogReview>(rawResponse, defaultBacklogReview);
  // Ensure reviewedAt is always set
  review.reviewedAt = review.reviewedAt ?? new Date().toISOString();

  // 6. Persist to Vercel Blob
  const timestamp = Date.now();
  await writeBlob(
    `af-data/pm-agent/reviews/${timestamp}.json`,
    JSON.stringify(review, null, 2)
  );

  // 7. Send Gmail summary
  const subject = `[Agent Forge] Backlog Review — ${new Date().toLocaleDateString()}`;
  const body = review.summary ?? JSON.stringify(review, null, 2);
  await sendGmailSummary(subject, body);

  // 8. Return
  return review;
}

export async function assessProjectHealth(projectId?: string): Promise<ProjectHealth[]> {
  // 1. Fetch all work items and projects
  const allWorkItems = await listWorkItems();
  const allProjects = await getActiveProjects() as Array<{ id: string; name?: string; title?: string }>;
  const escalations = await getEscalations() as Array<{ projectId?: string; status?: string }>;

  // 2. Determine which projects to assess
  const projectsToAssess = projectId
    ? allProjects.filter((p) => p.id === projectId)
    : allProjects;

  // 3. Assess each project
  const healthResults: ProjectHealth[] = await Promise.all(
    projectsToAssess.map(async (project) => {
      const projectItems = (allWorkItems as WorkItem[]).filter(
        (item) => (item as WorkItem & { projectId?: string }).projectId === project.id
      );
      const projectEscalations = escalations.filter((e) => e.projectId === project.id);

      // Calculate metrics
      const total = projectItems.length;
      const merged = projectItems.filter((i) => i.status === 'merged').length;
      const blocked = projectItems.filter((i) => i.status === 'blocked').length;
      const completionRate = total > 0 ? merged / total : 0;
      const escalationCount = projectEscalations.length;

      // avgTimeInQueue: average ms between creation and dispatch for queued/dispatched items
      const queuedItems = projectItems.filter(
        (i) => i.createdAt && (i as WorkItem & { queuedAt?: string }).queuedAt
      );
      const avgTimeInQueue =
        queuedItems.length > 0
          ? queuedItems.reduce((sum, item) => {
              const created = new Date(item.createdAt!).getTime();
              const queued = new Date((item as WorkItem & { queuedAt?: string }).queuedAt!).getTime();
              return sum + (queued - created);
            }, 0) / queuedItems.length
          : 0;

      // Call Claude for AI-powered issue detection
      const prompt = buildHealthAssessmentPrompt(project, projectItems, projectEscalations);
      const rawResponse = await callClaude(prompt, 2048);

      const defaultHealth: ProjectHealth = {
        projectId: project.id,
        projectName: project.name ?? project.title ?? project.id,
        metrics: {
          completionRate,
          avgTimeInQueue,
          blockedItems: blocked,
          escalationCount,
        },
        issues: [],
        recommendations: [],
        assessedAt: new Date().toISOString(),
      };

      const health = safeParseJSON<ProjectHealth>(rawResponse, defaultHealth);
      // Always ensure computed metrics override Claude's (source of truth)
      health.projectId = project.id;
      health.projectName = health.projectName ?? project.name ?? project.title ?? project.id;
      health.assessedAt = health.assessedAt ?? new Date().toISOString();
      health.metrics = {
        ...health.metrics,
        completionRate,
        avgTimeInQueue,
        blockedItems: blocked,
        escalationCount,
      };

      return health;
    })
  );

  return healthResults;
}

export async function suggestNextBatch(): Promise<{ workItemIds: string[]; rationale: string }> {
  // 1. Get pipeline state (available slots)
  const pipelineState = await getATCPipelineState();

  // 2. Get ready items
  const allItems = await listWorkItems();
  const readyItems = (allItems as WorkItem[]).filter((i) => i.status === 'ready');

  // 3. Get active projects
  const projects = await getActiveProjects();

  // 4. Build prompt and call Claude
  const prompt = buildNextBatchPrompt(readyItems, projects, pipelineState);
  const rawResponse = await callClaude(prompt, 2048);

  const fallback = {
    workItemIds: readyItems.slice(0, pipelineState.availableSlots).map((i) => i.id),
    rationale: 'Fallback: selected oldest ready items by default.',
  };
  return safeParseJSON<{ workItemIds: string[]; rationale: string }>(rawResponse, fallback);
}

export async function composeDigest(options: DigestOptions): Promise<string> {
  // 1. Optionally run reviewBacklog and assessProjectHealth
  let backlogReview: BacklogReview | undefined;
  let projectHealthList: ProjectHealth[] | undefined;

  if (options.includeBacklogReview) {
    backlogReview = await reviewBacklog();
  }
  if (options.includeProjectHealth) {
    projectHealthList = await assessProjectHealth();
  }

  // 2. Calculate pipeline delta since last digest
  const allItems = await listWorkItems() as WorkItem[];
  const since = options.since ? new Date(options.since).getTime() : Date.now() - 24 * 60 * 60 * 1000;
  const recentItems = allItems.filter((i) => {
    const updatedAt = (i as WorkItem & { updatedAt?: string }).updatedAt;
    return updatedAt && new Date(updatedAt).getTime() > since;
  });
  const delta = {
    merged: recentItems.filter((i) => i.status === 'merged').length,
    failed: recentItems.filter((i) => i.status === 'failed').length,
    blocked: recentItems.filter((i) => i.status === 'blocked').length,
    total: recentItems.length,
  };

  // 3. Build prompt and call Claude
  const prompt = buildDigestPrompt(backlogReview, projectHealthList, delta, options);
  const digest = await callClaude(prompt, 3000);

  // 4. Send via Gmail if recipientEmail provided
  if (options.recipientEmail) {
    await sendGmailSummary(
      `[Agent Forge] Pipeline Digest — ${new Date().toLocaleDateString()}`,
      digest
    );
  }

  // 5. Return formatted digest
  return digest;
}
```

### Step 3: Reconcile with actual type shapes

After writing the initial implementation, check the actual type definitions in `lib/types.ts` for `BacklogReview`, `ProjectHealth`, `PMAgentConfig`, and `DigestOptions`. Adjust:

1. The `defaultBacklogReview` fallback object field names to match the actual `BacklogReview` type
2. The `defaultHealth` fallback object field names to match the actual `ProjectHealth` type
3. The `metrics` sub-object structure to match `ProjectHealthMetrics` if it differs
4. The `DigestOptions` fields (`includeBacklogReview`, `includeProjectHealth`, `since`, `recipientEmail`) to match the actual type

Also check `buildBacklogReviewPrompt`, `buildHealthAssessmentPrompt`, `buildNextBatchPrompt`, `buildDigestPrompt` parameter types in `lib/pm-prompts.ts` and adjust call sites accordingly.

### Step 4: Fix any TypeScript errors

```bash
npx tsc --noEmit 2>&1
```

Common issues to fix:
- Import not found: adjust the import path or use dynamic import pattern
- Type mismatch on `WorkItem`: check if `projectId` is on the base `WorkItem` type or needs casting
- `listBlobs` return type: check if it returns `string[]` or an object with `.blobs` array
- `writeBlob`/`readBlob` signature differences: check actual signatures in `lib/storage.ts`
- Missing fields on fallback objects: add required fields from the actual type definitions

If `listBlobs` in `lib/storage.ts` returns an object (e.g., `{ blobs: BlobObject[] }`), adjust accordingly:
```typescript
const result = await listBlobs('escalations/');
const keys = Array.isArray(result) ? result : result.blobs?.map((b: { url: string; pathname: string }) => b.pathname) ?? [];
```

### Step 5: Build verification

```bash
npm run build 2>&1
```

Fix any remaining type or compilation errors. The build must pass cleanly.

### Step 6: Verify exports

```bash
node -e "
const mod = require('./.next/server/chunks/ssr/lib_pm-agent_ts.js');
console.log('exports:', Object.keys(mod));
" 2>/dev/null || echo "Module check via TS source:"
grep -E '^export (async )?function' lib/pm-agent.ts
```

Confirm all four functions are exported: `reviewBacklog`, `assessProjectHealth`, `suggestNextBatch`, `composeDigest`.

### Step 7: Commit, push, open PR

```bash
git add lib/pm-agent.ts
git add -A
git commit -m "feat: A3 core PM Agent module with reviewBacklog, assessProjectHealth, suggestNextBatch, composeDigest"
git push origin feat/a3-core-pm-agent-module
gh pr create \
  --title "feat: A3 Core PM Agent Module" \
  --body "## Summary

Implements \`lib/pm-agent.ts\` with the four core PM Agent functions as specified in the A3 work item.

## What's included

- \`reviewBacklog(config?)\` — fetches work items + Notion projects + ATC pipeline state, calls Claude with backlog review prompt, persists result to \`af-data/pm-agent/reviews/{timestamp}.json\`, sends Gmail summary
- \`assessProjectHealth(projectId?)\` — computes per-project metrics (completionRate, avgTimeInQueue, blockedItems, escalationCount) + Claude-powered issue detection
- \`suggestNextBatch()\` — reads available pipeline slots, ready items, and active projects; returns Claude-recommended item IDs + rationale
- \`composeDigest(options)\` — optionally runs backlog review and health assessment, computes pipeline delta, formats digest via Claude, sends via Gmail if recipientEmail provided

## Implementation notes

- Claude calls use \`generateText\` from \`@ai-sdk/anthropic\` matching the \`lib/decomposer.ts\` pattern
- JSON parsing is defensive with try/catch and sensible fallbacks
- Gmail and Notion integrations use dynamic imports to match actual export names
- ATC pipeline state read from \`af-data/atc/state.json\` in Vercel Blob
- Escalations fetched from \`escalations/\` prefix in Vercel Blob

## Testing

- \`npx tsc --noEmit\` passes
- \`npm run build\` passes

Closes A3 work item." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit whatever compiles: `git add -A && git commit -m "wip: A3 pm-agent partial implementation" && git push origin feat/a3-core-pm-agent-module`
2. Open PR with partial status: `gh pr create --title "wip: A3 Core PM Agent Module (partial)" --body "Partial implementation — see ISSUES below" --base main`
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/a3-core-pm-agent-module
FILES CHANGED: lib/pm-agent.ts
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [e.g., "Fix type mismatch on BacklogReview.recommendations field — actual type uses X but template assumed Y"]
```

If you encounter a blocker that requires human judgment (e.g., the `BacklogReview` or `ProjectHealth` types from A1 don't exist in `lib/types.ts`, or the pm-prompts functions from A2 are missing), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "a3-core-pm-agent-module",
    "reason": "<describe the missing dependency or ambiguity>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error message>",
      "filesChanged": ["lib/pm-agent.ts"]
    }
  }'
```