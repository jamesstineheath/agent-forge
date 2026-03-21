# Agent Forge -- Add Uncertainty Detection and Spike Recommendation to PM Agent

## Metadata
- **Branch:** `feat/pm-agent-uncertainty-detection`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/pm-agent.ts, lib/pm-prompts.ts, lib/notion.ts (conditional — only if comment method doesn't exist)

## Context

Agent Forge's PM Agent (`lib/pm-agent.ts`) performs backlog review, health assessment, and project decomposition. It interacts with Notion projects via `lib/notion.ts` and uses structured Claude prompt builders in `lib/pm-prompts.ts`.

We need to extend the backlog review phase to detect technical uncertainty in PRDs and recommend feasibility spikes. This only applies to **Idea-status PRDs** (not Backlog-status PRDs). When uncertainty signals are found, a structured Notion comment is posted on the PRD.

Key existing patterns to follow:
- `lib/pm-prompts.ts` exports named `build*Prompt(...)` functions that return strings with structured Claude prompts and JSON output schemas
- `lib/pm-agent.ts` calls Claude directly (via `Anthropic` SDK), parses JSON responses, and calls `lib/notion.ts` for Notion API operations
- `lib/notion.ts` is a wrapper around the Notion SDK — check what comment-posting method it exposes
- The PM Agent is invoked via Inngest (`lib/inngest/pm-sweep.ts`, `lib/inngest/pm-cycle.ts`) and also via the API route at `app/api/pm-agent/route.ts`
- The codebase uses `lib/types.ts` for shared types and Claude JSON-mode responses parsed with `JSON.parse`

## Requirements

1. Add `buildUncertaintyDetectionPrompt(prdContent: string): string` to `lib/pm-prompts.ts` that:
   - Lists 6+ uncertainty signal categories: unknown API access, new platforms, unproven approaches, external service dependencies, hardware integrations, and explicit uncertainty language ("not sure if", "need to investigate", "TBD", etc.)
   - Returns a structured prompt instructing Claude to output a JSON object with `uncertaintySignals: string[]`, `recommendedScope: string`, and `technicalQuestion: string`
   - Instructs Claude to return `{ uncertaintySignals: [], recommendedScope: "", technicalQuestion: "" }` when no uncertainty is detected

2. Add a `detectAndCommentUncertainty(...)` helper in `lib/pm-agent.ts` that:
   - Calls `buildUncertaintyDetectionPrompt` and invokes Claude to analyze the PRD content
   - Uses the **same model** already used in the backlog review phase (do NOT hardcode a model name — reuse the existing constant or string)
   - Parses the JSON response
   - If `uncertaintySignals.length > 0`, posts a Notion comment on the PRD page recommending a feasibility spike with the `recommendedScope` and `technicalQuestion` values

3. Integrate uncertainty detection into the PM Agent's backlog review phase:
   - Iterate over PRDs with **Idea** status only
   - Explicitly skip PRDs with **Backlog** status (add a log line noting the skip)
   - Call the uncertainty detection function for each Idea-status PRD
   - Include idempotency: if a PRD already has a comment containing "Uncertainty Detected — Feasibility Spike Recommended", skip it (or if checking existing comments is not feasible with the current Notion wrapper, accept that duplicate comments are possible on repeated sweeps and note this as a known limitation in the PR description)

4. The Notion comment body should be clearly structured:
   ```
   🔍 Uncertainty Detected — Feasibility Spike Recommended

   Signals found:
     • <signal 1>
     • <signal 2>

   Recommended spike scope: <recommendedScope>

   Technical question to answer: <technicalQuestion>
   ```

5. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup