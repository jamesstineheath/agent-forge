# Agent Forge -- Create spike completion handler for PM Agent post-execution actions

## Metadata
- **Branch:** `feat/spike-completion-handler-pm-agent`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** lib/spike-completion.ts, lib/pm-agent.ts, lib/pm-prompts.ts, lib/github.ts, lib/notion.ts

## Context

Agent Forge orchestrates autonomous agents across repositories. A recent feature added spike handoff generation (`lib/spike-handoff.ts`) and a spike execution template. Spikes are exploratory work items dispatched to target repos — when they complete (status `merged`), the PM Agent needs to read the findings, interpret the recommendation (GO / GO_WITH_CHANGES / NO_GO), and take the appropriate action on the parent PRD in Notion.

Relevant existing files:
- `lib/spike-handoff.ts` — spike handoff generator, likely has `SpikeFindings` type and `parseSpikeFindings()` or similar parsing logic referenced from `lib/spike-template.ts`
- `lib/orchestrator.ts` — updated in the spike handoff PR to dispatch spike work items
- `lib/pm-agent.ts` — PM agent with cron cycle phases; needs a new "spike completion" phase
- `lib/pm-prompts.ts` — structured prompt builders for PM agent; needs `buildSpikeCompletionSummaryPrompt()`
- `lib/github.ts` — GitHub API wrapper; may need `readFileContent()` helper
- `lib/notion.ts` — Notion API client for reading/updating project/PRD status
- `lib/types.ts` — shared types including `WorkItem`
- `lib/projects.ts` — project lifecycle transitions (Complete/Failed/Not Feasible)

**Concurrent work to avoid:** `lib/atc/dispatcher.ts` and `lib/inngest/dispatcher.ts` are being modified by another branch (`feat/integrate-wave-scheduler-into-dispatcher-dispatch-`). Do NOT touch those files.

The spike findings doc lives at `spikes/<workItemId>.md` in the target repo, written by the executed spike handoff. The parent PRD is referenced in the work item (likely `workItem.notionPageId` or a similar field on `WorkItem`).

## Requirements

1. `lib/github.ts` must export a `readFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string>` utility if one does not already exist. It should use the existing GitHub API client and throw a descriptive error if the file is not found.
2. `lib/spike-completion.ts` must define a `SpikeCompletionAction` type union with three variants: `{ type: 'GO'; technicalApproach: string }`, `{ type: 'GO_WITH_CHANGES'; suggestedRevisions: string }`, and `{ type: 'NO_GO'; rationale: string }`.
3. `lib/spike-completion.ts` must export `handleSpikeCompletion(workItem: WorkItem): Promise<SpikeCompletionAction>` which: reads `spikes/<workItem.id>.md` from the target repo via `readFileContent`, parses it with `parseSpikeFindings()` from `lib/spike-handoff.ts` (or `lib/spike-template.ts` — check which file exports this), posts a Notion comment summarizing findings on the parent PRD page, and takes the appropriate Notion action based on recommendation.
4. For `GO` recommendation: update the PRD page status to `Draft` via Notion API and append the technical approach as a comment.
5. For `GO_WITH_CHANGES` recommendation: post suggested revisions as a Notion comment; leave PRD at `Idea` status (no status change).
6. For `NO_GO` recommendation: update the PRD page status to `Not Feasible` via Notion API (reuse `lib/projects.ts` pattern or call Notion directly).
7. `lib/pm-prompts.ts` must export `buildSpikeCompletionSummaryPrompt(workItem: WorkItem, findings: SpikeFindings): string` that generates a concise Notion comment body summarizing the spike outcome for human stakeholders.
8. `lib/pm-agent.ts` cron cycle must include a spike completion phase that: queries for work items with `type === 'spike'` and `status === 'merged'` that have not yet been processed, calls `handleSpikeCompletion()` for each, and marks them as processed (e.g., status transition to `verified` or a metadata flag).
9. All new code must pass `npx tsc --noEmit` with no new type errors.
10. The implementation must be resilient: if the spike findings file is missing or unparseable, log an error and skip (do not throw/crash the cron cycle).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spike-completion-handler-pm-agent
```

### Step 1: Audit existing code

Before writing any new code, read these files carefully to understand existing patterns:

```bash
cat lib/github.ts
cat lib/spike-handoff.ts
# Also check if spike-template.ts exists
ls lib/spike-template.ts 2>/dev/null && cat lib/spike-template.ts
cat lib/notion.ts
cat lib/pm-agent.ts
cat lib/pm-prompts.ts
cat lib/types.ts
cat lib/projects.ts
```

Key things to determine:
- Does `lib/github.ts` already have a `readFileContent` or similar helper? If yes, skip Step 2 or just re-export under the canonical name.
- Which file exports `parseSpikeFindings()` — `lib/spike-handoff.ts` or `lib/spike-template.ts`?
- What is the `SpikeFindings` type shape (fields: recommendation, technicalApproach, rationale, suggestedRevisions, etc.)?
- What Notion field name holds the PRD page ID on a `WorkItem`? (likely `notionPageId`, `metadata.notionPageId`, or similar)
- What are the valid Notion status values for PRD pages? (look for how `lib/notion.ts` sets status — probably a select property)
- How does `lib/projects.ts` set "Not Feasible"? Reuse that Notion API call pattern.
- What does the PM agent cron cycle look like — what phases exist and how are they structured?

### Step 2: Add `readFileContent` to `lib/github.ts`

If `readFileContent` does not exist, add it. Follow the existing Octokit/GitHub API patterns in the file:

```typescript
/**
 * Read the raw text content of a file from a GitHub repository.
 * @throws Error if the file is not found or content cannot be decoded.
 */
export async function readFileContent(
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<string> {
  const octokit = getOctokit(); // use whatever the existing getter is
  const params: { owner: string; repo: string; path: string; ref?: string } = {
    owner,
    repo,
    path,
  };
  if (ref) params.ref = ref;

  const { data } = await octokit.rest.repos.getContent(params);

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`Path ${path} is not a file in ${owner}/${repo}`);
  }

  if (!data.content) {
    throw new Error(`File ${path} in ${owner}/${repo} has no content`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}
```

Adapt the Octokit instantiation to match the existing pattern in `lib/github.ts`.

### Step 3: Add `buildSpikeCompletionSummaryPrompt` to `lib/pm-prompts.ts`

Add a new exported function. Match the style of existing prompt builders in that file (they typically take structured inputs and return a string):

```typescript
export function buildSpikeCompletionSummaryPrompt(
  workItem: WorkItem,
  findings: SpikeFindings // import from wherever parseSpikeFindings lives
): string {
  return `You are summarizing the results of a technical spike for a project stakeholder comment in Notion.

Spike work item: ${workItem.id} — ${workItem.title}

Spike findings:
- Recommendation: ${findings.recommendation}
- Technical approach: ${findings.technicalApproach ?? 'N/A'}
- Rationale: ${findings.rationale ?? 'N/A'}
- Suggested revisions: ${findings.suggestedRevisions ?? 'N/A'}
- Risks identified: ${findings.risks ?? 'N/A'}
- Estimated effort: ${findings.estimatedEffort ?? 'N/A'}

Write a concise (3-5 sentence) Notion comment summarizing the spike outcome. 
Start with the recommendation (GO / GO_WITH_CHANGES / NO_GO), explain the key finding, 
and state the next step for the PRD. Use plain language suitable for a non-technical stakeholder.
Do not use markdown headers. Output only the comment text.`;
}
```

**Note:** If the PM prompts pattern uses a different structure (e.g., message arrays for Claude), adapt accordingly based on what you see in Step 1.

### Step 4: Add Notion helpers to `lib/notion.ts` if needed

Check whether `lib/notion.ts` already has:
- A way to update a page's status property (look for `updatePageStatus` or similar)
- A way to append a comment/block to a page

If `updatePageStatus` for PRD pages doesn't exist or doesn't support `Draft` and `Not Feasible` as values, add a targeted helper:

```typescript
/**
 * Update the status select property on a Notion PRD page.
 */
export async function updatePRDStatus(
  pageId: string,
  status: 'Draft' | 'Idea' | 'Not Feasible'
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: {
        select: { name: status },
      },
    },
  });
}

/**
 * Append a comment paragraph to a Notion page.
 */
export async function appendNotionComment(
  pageId: string,
  text: string
): Promise<void> {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: [{ type: 'text', text: { content: text } }],
        },
      },
    ],
  });
}
```

Check if `lib/notion.ts` already uses `@notionhq/client` and has a `notion` client instance — reuse that. If PRD pages use a different property name than `Status` or different values, adjust accordingly based on what you see in Step 1.

**Important:** Also check how `lib/projects.ts` sets the "Not Feasible" status — if it calls a Notion helper, reuse that exact helper rather than creating a duplicate.

### Step 5: Create `lib/spike-completion.ts`

```typescript
import { WorkItem } from './types';
import { readFileContent } from './github';
import { parseSpikeFindings, SpikeFindings } from './spike-handoff'; // adjust import path if needed
import { appendNotionComment, updatePRDStatus } from './notion'; // adjust if helpers differ
import { buildSpikeCompletionSummaryPrompt } from './pm-prompts';
import Anthropic from '@anthropic-ai/sdk'; // or however Claude is invoked in this codebase

export type SpikeCompletionAction =
  | { type: 'GO'; technicalApproach: string }
  | { type: 'GO_WITH_CHANGES'; suggestedRevisions: string }
  | { type: 'NO_GO'; rationale: string };

/**
 * Handles post-execution actions for a completed spike work item.
 * Reads findings from the target repo, posts a Notion comment on the parent PRD,
 * and transitions the PRD status based on the spike recommendation.
 */
export async function handleSpikeCompletion(
  workItem: WorkItem
): Promise<SpikeCompletionAction> {
  // 1. Determine target repo coordinates
  // WorkItem likely has repoOwner/repoName or similar — inspect lib/types.ts
  const [owner, repo] = (workItem.repo ?? workItem.targetRepo ?? '').split('/');
  if (!owner || !repo) {
    throw new Error(`Cannot determine repo for work item ${workItem.id}`);
  }

  // 2. Read spike findings markdown
  const spikePath = `spikes/${workItem.id}.md`;
  const rawFindings = await readFileContent(owner, repo, spikePath);

  // 3. Parse findings
  const findings: SpikeFindings = parseSpikeFindings(rawFindings);

  // 4. Determine the parent PRD Notion page ID
  // Inspect WorkItem type — may be workItem.notionPageId, workItem.metadata?.notionPageId, etc.
  const notionPageId = (workItem as any).notionPageId 
    ?? (workItem as any).metadata?.notionPageId;
  
  if (!notionPageId) {
    throw new Error(`No Notion page ID on work item ${workItem.id} — cannot post PRD update`);
  }

  // 5. Generate summary comment via Claude
  const prompt = buildSpikeCompletionSummaryPrompt(workItem, findings);
  // Use the same Anthropic/Claude invocation pattern as the rest of pm-agent.ts
  // e.g., if pm-agent uses a runClaudeQuery() helper, use that
  const summaryComment = await generateSpikeComment(prompt);

  // 6. Post summary comment on Notion PRD
  await appendNotionComment(notionPageId, summaryComment);

  // 7. Take action based on recommendation
  const rec = findings.recommendation?.toUpperCase();

  if (rec === 'GO') {
    await updatePRDStatus(notionPageId, 'Draft');
    if (findings.technicalApproach) {
      await appendNotionComment(
        notionPageId,
        `**Technical Approach (from spike):**\n${findings.technicalApproach}`
      );
    }
    return { type: 'GO', technicalApproach: findings.technicalApproach ?? '' };
  }

  if (rec === 'GO_WITH_CHANGES') {
    // No status change — PRD stays at Idea
    if (findings.suggestedRevisions) {
      await appendNotionComment(
        notionPageId,
        `**Suggested Revisions (from spike):**\n${findings.suggestedRevisions}`
      );
    }
    return { type: 'GO_WITH_CHANGES', suggestedRevisions: findings.suggestedRevisions ?? '' };
  }

  if (rec === 'NO_GO') {
    await updatePRDStatus(notionPageId, 'Not Feasible');
    return { type: 'NO_GO', rationale: findings.rationale ?? '' };
  }

  throw new Error(`Unknown spike recommendation "${findings.recommendation}" on work item ${workItem.id}`);
}

/**
 * Generate a Notion comment text using Claude.
 * Adapt this to match the Claude invocation pattern in lib/pm-agent.ts.
 */
async function generateSpikeComment(prompt: string): Promise<string> {
  // Look at lib/pm-agent.ts to see how it calls Claude — replicate that exact pattern.
  // Common patterns:
  // Option A: Direct Anthropic SDK
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = msg.content[0];
  return block.type === 'text' ? block.text.trim() : '';
  
  // Option B: If pm-agent uses a shared helper like runClaudeQuery(prompt), use that instead
}
```

**Important adjustments to make based on Step 1 audit:**
- Import `parseSpikeFindings` / `SpikeFindings` from the correct file (`lib/spike-handoff.ts` or `lib/spike-template.ts`)
- Use the actual field names from `WorkItem` type for repo coordinates and Notion page ID
- Replicate the exact Claude invocation pattern from `lib/pm-agent.ts`
- Use existing Notion helper function names if they differ from the stubs above

### Step 6: Modify `lib/pm-agent.ts` — add spike completion phase

Add a new phase to the PM agent cron cycle. Find the main `runPMCycle()` or equivalent function. Add after existing phases (do not disrupt existing logic):

```typescript
// --- Spike Completion Phase ---
// Import at top of file:
import { handleSpikeCompletion } from './spike-completion';
import { getWorkItems, updateWorkItem } from './work-items'; // adjust to actual import

// Inside the cron/sweep function, add:
async function processSpikeCompletions(): Promise<void> {
  console.log('[PM Agent] Running spike completion phase...');
  
  // Query merged spike work items
  // Adjust query to match how work items are fetched in pm-agent.ts
  const allItems = await getWorkItems();
  const mergedSpikes = allItems.filter(
    (item) =>
      item.type === 'spike' &&
      item.status === 'merged' &&
      !item.metadata?.spikeCompletionProcessed
  );

  console.log(`[PM Agent] Found ${mergedSpikes.length} spike(s) awaiting completion processing`);

  for (const workItem of mergedSpikes) {
    try {
      const action = await handleSpikeCompletion(workItem);
      console.log(`[PM Agent] Spike ${workItem.id} completion: ${action.type}`);

      // Mark as processed to prevent re-processing
      await updateWorkItem(workItem.id, {
        status: 'verified',
        metadata: {
          ...workItem.metadata,
          spikeCompletionProcessed: true,
          spikeCompletionAction: action.type,
          spikeCompletionAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error(`[PM Agent] Error processing spike completion for ${workItem.id}:`, err);
      // Don't rethrow — continue processing other spikes
    }
  }
}
```

Then call `processSpikeCompletions()` inside the main cron/sweep function alongside other phases. Match the exact async pattern (sequential awaits or parallel Promise.all depending on existing style).

**Key:** Look at how existing phases in `pm-agent.ts` query work items, update them, and handle errors. Match that exact pattern. Do not import from `lib/atc/dispatcher.ts` or `lib/inngest/dispatcher.ts` (concurrent work).

### Step 7: Type-check and fix any errors

```bash
npx tsc --noEmit 2>&1
```

Common issues to fix:
- `SpikeFindings` fields may differ from what's assumed — adjust field access
- `WorkItem` may not have `notionPageId` at the top level — use type assertion or optional chaining
- Notion property name `Status` may differ — check actual Notion page structure in `lib/notion.ts`
- Claude model name — use whichever model string pm-agent.ts already uses

Iterate until `npx tsc --noEmit` exits 0.

### Step 8: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Run tests if any exist
npm test 2>/dev/null || echo "No test suite found"

# Verify new file exists and exports are correct
node -e "const s = require('./lib/spike-completion'); console.log(Object.keys(s))"
```

Confirm:
- `lib/spike-completion.ts` exists and exports `SpikeCompletionAction` and `handleSpikeCompletion`
- `lib/github.ts` exports `readFileContent`
- `lib/pm-prompts.ts` exports `buildSpikeCompletionSummaryPrompt`
- `lib/pm-agent.ts` imports and calls `processSpikeCompletions()` (or equivalent) in its cycle
- No TypeScript errors

### Step 9: Commit, push, open PR

```bash
git add lib/spike-completion.ts lib/github.ts lib/pm-agent.ts lib/pm-prompts.ts lib/notion.ts
git add -A
git commit -m "feat: add spike completion handler for PM Agent post-execution actions

- Add readFileContent() utility to lib/github.ts
- Add SpikeCompletionAction type union and handleSpikeCompletion() in lib/spike-completion.ts
- Add buildSpikeCompletionSummaryPrompt() in lib/pm-prompts.ts
- Add updatePRDStatus() and appendNotionComment() helpers in lib/notion.ts (if not present)
- Add spike completion phase in lib/pm-agent.ts cron cycle
- GO -> moves PRD to Draft, appends technical approach
- GO_WITH_CHANGES -> posts revisions comment, keeps PRD at Idea
- NO_GO -> moves PRD to Not Feasible"

git push origin feat/spike-completion-handler-pm-agent

gh pr create \
  --title "feat: spike completion handler for PM Agent post-execution actions" \
  --body "## Summary

Implements post-execution handling for spike work items in the PM Agent cron cycle.

## Changes

### lib/github.ts
- Added \`readFileContent(owner, repo, path, ref?)\` utility for reading raw file content from GitHub repos

### lib/spike-completion.ts (new)
- \`SpikeCompletionAction\` type union: \`GO | GO_WITH_CHANGES | NO_GO\`
- \`handleSpikeCompletion(workItem)\`: reads \`spikes/<id>.md\` from target repo, parses findings, posts Notion comment, transitions PRD status

### lib/pm-prompts.ts
- \`buildSpikeCompletionSummaryPrompt(workItem, findings)\`: generates stakeholder-friendly Notion comment text

### lib/notion.ts
- \`updatePRDStatus(pageId, status)\`: sets PRD status to Draft/Idea/Not Feasible
- \`appendNotionComment(pageId, text)\`: appends paragraph block to Notion page

### lib/pm-agent.ts
- Spike completion phase added to cron cycle
- Queries merged spike work items not yet processed
- Calls handleSpikeCompletion() for each, marks as verified with metadata flag

## Acceptance Criteria
- [x] handleSpikeCompletion() reads spike findings markdown from target repo via GitHub API
- [x] GO recommendation: PRD moved to Draft, technical approach appended
- [x] GO_WITH_CHANGES: suggested revisions posted, PRD stays at Idea
- [x] NO_GO: PRD moved to Not Feasible
- [x] PM Agent cron cycle includes spike completion phase for merged spike work items

## No Conflicts
- Did not touch lib/atc/dispatcher.ts or lib/inngest/dispatcher.ts (concurrent wave scheduler work)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/spike-completion-handler-pm-agent
FILES CHANGED: [list files modified so far]
SUMMARY: [what was completed]
ISSUES: [what failed or is ambiguous]
NEXT STEPS: [what remains — e.g., "parseSpikeFindings import path unclear, needs manual check of lib/spike-handoff.ts exports"]
```

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `parseSpikeFindings` may not exist or may be named differently | Audit `lib/spike-handoff.ts` in Step 1; adjust import |
| `WorkItem.notionPageId` field name may differ | Inspect `lib/types.ts` in Step 1; use correct field or `metadata` sub-path |
| Notion property name for status may not be `Status` | Check `lib/notion.ts` and `lib/projects.ts` patterns in Step 1 |
| Claude model string may differ from what's assumed | Copy exact model string from `lib/pm-agent.ts` |
| `spikes/<id>.md` path convention may differ | Check `lib/spike-handoff.ts` for the exact path written during spike execution |
| Spike work items may use different `type` field value | Check work item type used in `lib/spike-handoff.ts` or orchestrator spike dispatch |