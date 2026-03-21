# Agent Forge -- Add Uncertainty Detection and Spike Recommendation to PM Agent

## Metadata
- **Branch:** `feat/pm-agent-uncertainty-detection`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/pm-agent.ts, lib/pm-prompts.ts

## Context

Agent Forge's PM Agent (`lib/pm-agent.ts`) performs backlog review, health assessment, and project decomposition. It interacts with Notion projects via `lib/notion.ts` and uses structured Claude prompt builders in `lib/pm-prompts.ts`.

We need to extend the backlog review phase to detect technical uncertainty in PRDs and recommend feasibility spikes. This only applies to **Idea-status PRDs** (not Backlog-status PRDs). When uncertainty signals are found, a structured Notion comment is posted on the PRD.

Key existing patterns to follow:
- `lib/pm-prompts.ts` exports named `build*Prompt(...)` functions that return strings with structured Claude prompts and JSON output schemas
- `lib/pm-agent.ts` calls Claude directly (via `Anthropic` SDK), parses JSON responses, and calls `lib/notion.ts` for Notion API operations
- `lib/notion.ts` has methods for reading page content and posting comments — check for `postComment` or equivalent
- The PM Agent is invoked via Inngest (`lib/inngest/pm-sweep.ts`, `lib/inngest/pm-cycle.ts`) and also via the API route at `app/api/pm-agent/route.ts`

Recent PRs show the codebase uses `lib/types.ts` for shared types and the pattern of Claude JSON-mode responses parsed with `JSON.parse`.

## Requirements

1. Add `buildUncertaintyDetectionPrompt(prdContent: string): string` to `lib/pm-prompts.ts` that:
   - Lists 6+ uncertainty signal categories: unknown API access, new platforms, unproven approaches, external service dependencies, hardware integrations, and explicit uncertainty language ("not sure if", "need to investigate", "TBD", etc.)
   - Returns a structured prompt instructing Claude to output a JSON object with `uncertaintySignals: string[]`, `recommendedScope: string`, and `technicalQuestion: string`
   - Instructs Claude to return `{ uncertaintySignals: [], recommendedScope: "", technicalQuestion: "" }` when no uncertainty is detected

2. Add an `detectUncertainty(prdContent: string, pageId: string): Promise<void>` function (or equivalent private helper) in `lib/pm-agent.ts` that:
   - Calls `buildUncertaintyDetectionPrompt` and invokes Claude to analyze the PRD content
   - Parses the JSON response
   - If `uncertaintySignals.length > 0`, posts a Notion comment on the PRD page recommending a feasibility spike with the `recommendedScope` and `technicalQuestion` values

3. Integrate uncertainty detection into the PM Agent's backlog review phase:
   - Iterate over PRDs with **Idea** status only
   - Explicitly skip PRDs with **Backlog** status (add a log line noting the skip)
   - Call the uncertainty detection function for each Idea-status PRD

4. The Notion comment body should be clearly structured, e.g.:
   ```
   🔍 Uncertainty Detected — Feasibility Spike Recommended

   Signals found: <list>
   Recommended spike scope: <recommendedScope>
   Technical question to answer: <technicalQuestion>
   ```

5. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/pm-agent-uncertainty-detection
```

### Step 1: Understand existing code structure

Read the relevant files before writing any code:

```bash
cat lib/pm-prompts.ts
cat lib/pm-agent.ts
cat lib/notion.ts
```

Pay attention to:
- How existing `build*Prompt` functions are structured in `lib/pm-prompts.ts`
- How `lib/pm-agent.ts` instantiates the Anthropic client and calls Claude (look for `client.messages.create` or similar)
- How Claude JSON responses are parsed (look for `JSON.parse` usage and error handling patterns)
- What method `lib/notion.ts` exposes for posting comments on a page (look for `createComment`, `postComment`, `appendComment`, or similar; check if it uses `notion.comments.create`)
- What type/shape represents a PRD/project with a status field — check `lib/types.ts` and `lib/notion.ts` return types

### Step 2: Add `buildUncertaintyDetectionPrompt` to `lib/pm-prompts.ts`

Append the following export to `lib/pm-prompts.ts` (adapt formatting to match existing style in the file):

```typescript
export function buildUncertaintyDetectionPrompt(prdContent: string): string {
  return `You are a technical project manager reviewing a Product Requirements Document (PRD) for signs of technical uncertainty that would benefit from a feasibility spike before committing to full implementation.

Analyze the following PRD content for these uncertainty signal categories:
1. **Unknown API access** - integrations with APIs not yet confirmed accessible, undocumented APIs, or APIs requiring approval
2. **New platforms** - deployment targets, operating systems, or runtime environments the team has not used before
3. **Unproven approaches** - algorithms, architectures, or techniques that are novel or untested in this codebase
4. **External service dependencies** - third-party services with unknown reliability, pricing, rate limits, or SLA requirements
5. **Hardware integrations** - physical devices, sensors, embedded systems, or platform-specific hardware features
6. **Explicit uncertainty language** - phrases such as "not sure if", "need to investigate", "TBD", "to be determined", "unclear how", "unknown whether", "might be possible", "need to verify"

Return ONLY a valid JSON object in this exact shape — no markdown, no explanation:
{
  "uncertaintySignals": ["<signal 1>", "<signal 2>"],
  "recommendedScope": "<one-paragraph description of what a feasibility spike should investigate>",
  "technicalQuestion": "<the single most important yes/no or how-to question the spike must answer>"
}

If no uncertainty signals are detected, return:
{ "uncertaintySignals": [], "recommendedScope": "", "technicalQuestion": "" }

PRD Content:
---
${prdContent}
---`;
}
```

### Step 3: Add uncertainty detection logic to `lib/pm-agent.ts`

#### 3a: Add private helper function

After reading `lib/pm-agent.ts`, identify the correct location to add a private helper. Add a function that detects uncertainty and posts a Notion comment. Adapt the Anthropic call pattern to match what already exists in the file:

```typescript
async function detectAndCommentUncertainty(
  anthropicClient: Anthropic, // or whatever the client type is — match existing usage
  notionClient: NotionClientType, // match existing notion client type/instance
  prdContent: string,
  pageId: string,
  pageTitle: string
): Promise<void> {
  const prompt = buildUncertaintyDetectionPrompt(prdContent);

  let parsed: {
    uncertaintySignals: string[];
    recommendedScope: string;
    technicalQuestion: string;
  };

  try {
    // Match the exact Anthropic call pattern used elsewhere in this file
    const response = await anthropicClient.messages.create({
      model: "claude-opus-4-5", // use the same model constant already used in the file
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    parsed = JSON.parse(text);
  } catch (err) {
    console.error(
      `[PM Agent] Uncertainty detection failed for page ${pageId} ("${pageTitle}"):`,
      err
    );
    return;
  }

  if (!parsed.uncertaintySignals || parsed.uncertaintySignals.length === 0) {
    console.log(
      `[PM Agent] No uncertainty signals detected for PRD "${pageTitle}" (${pageId})`
    );
    return;
  }

  const signalList = parsed.uncertaintySignals
    .map((s) => `  • ${s}`)
    .join("\n");

  const commentBody = [
    "🔍 Uncertainty Detected — Feasibility Spike Recommended",
    "",
    `Signals found:\n${signalList}`,
    "",
    `Recommended spike scope: ${parsed.recommendedScope}`,
    "",
    `Technical question to answer: ${parsed.technicalQuestion}`,
  ].join("\n");

  try {
    // Use whichever Notion comment method exists — adapt to actual API
    await notionClient.comments.create({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: commentBody } }],
    });
    console.log(
      `[PM Agent] Posted spike recommendation comment on PRD "${pageTitle}" (${pageId})`
    );
  } catch (err) {
    console.error(
      `[PM Agent] Failed to post Notion comment on page ${pageId}:`,
      err
    );
  }
}
```

> **Important:** Match the exact Anthropic client instantiation, model name/constant, and Notion client usage pattern found in the existing file. Do not introduce new imports that aren't already present or easily added.

#### 3b: Integrate into the backlog review phase

Find the section in `lib/pm-agent.ts` where backlog review iterates over projects/PRDs. This is likely inside a function named something like `runBacklogReview`, `performBacklogReview`, or called from `lib/inngest/pm-sweep.ts`.

Add the uncertainty detection call inside the loop, gated on Idea status:

```typescript
// Inside the PRD/project iteration loop:
for (const project of projects) {
  // ... existing logic ...

  // Uncertainty detection: Idea-status PRDs only
  if (project.status === "Idea") {
    // Fetch PRD content if not already available — use existing pattern
    const prdContent = project.description ?? project.content ?? "";
    if (prdContent.trim().length > 0) {
      await detectAndCommentUncertainty(
        anthropicClient,
        notionClient,
        prdContent,
        project.id, // Notion page ID
        project.title ?? project.name ?? project.id
      );
    }
  } else if (project.status === "Backlog") {
    console.log(
      `[PM Agent] Skipping uncertainty detection for Backlog-status PRD "${project.title ?? project.id}"`
    );
  }

  // ... rest of existing loop body ...
}
```

> **Important:** Read the actual loop structure carefully. The field names (`project.status`, `project.id`, `project.title`, `project.description`) must match the actual type returned by the Notion query. Check `lib/types.ts` and the Notion fetch function return type.

### Step 4: Import `buildUncertaintyDetectionPrompt` in `lib/pm-agent.ts`

Ensure `buildUncertaintyDetectionPrompt` is imported at the top of `lib/pm-agent.ts`:

```typescript
import { buildUncertaintyDetectionPrompt } from "./pm-prompts";
// (only add if not already imported — check existing import for pm-prompts)
```

### Step 5: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors:
- If the Notion client type doesn't expose `comments.create`, check what comment-posting method actually exists in `lib/notion.ts` and use that instead
- If the Anthropic client type differs from what's used above, match the existing pattern exactly
- If `project.status` uses a different field name or type (e.g., an enum), update accordingly

### Step 6: Run build

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add uncertainty detection and spike recommendation to PM Agent"
git push origin feat/pm-agent-uncertainty-detection
gh pr create \
  --title "feat: add uncertainty detection and spike recommendation to PM Agent" \
  --body "## Summary
Extends the PM Agent's backlog review phase with uncertainty detection for Idea-status PRDs.

## Changes
- \`lib/pm-prompts.ts\`: Added \`buildUncertaintyDetectionPrompt(prdContent)\` with 6 signal categories and structured JSON output schema
- \`lib/pm-agent.ts\`: Added \`detectAndCommentUncertainty\` helper and integrated it into the backlog review loop (Idea-status only, Backlog-status explicitly skipped)

## Behavior
- During backlog review, each Idea-status PRD is analyzed by Claude for technical uncertainty signals
- If signals are detected, a structured Notion comment is posted recommending a feasibility spike with scope and key technical question
- Backlog-status PRDs are skipped with a log line
- No change to existing backlog review logic for other statuses

## Acceptance Criteria
- [x] Uncertainty detection runs for Idea-status PRDs only
- [x] Backlog-status PRDs are explicitly skipped
- [x] \`buildUncertaintyDetectionPrompt\` lists 6+ signal categories
- [x] Notion comment posted when signals detected
- [x] TypeScript compiles without errors"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/pm-agent-uncertainty-detection
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., `lib/notion.ts` has no comment-posting method and would require a new Notion API integration, or the PM Agent backlog review loop is structured in a way that makes injecting the uncertainty phase architecturally ambiguous):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "pm-agent-uncertainty-detection",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/pm-prompts.ts", "lib/pm-agent.ts"]
    }
  }'
```