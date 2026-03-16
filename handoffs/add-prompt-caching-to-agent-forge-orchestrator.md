# Agent Forge -- Add Prompt Caching to Orchestrator

## Metadata
- **Branch:** `feat/orchestrator-prompt-caching`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/orchestrator.ts, lib/prompt-cache.ts

## Context

The Agent Forge orchestrator (`lib/orchestrator.ts`) generates handoff files by calling the Anthropic Claude API. The prompt it constructs has three logical layers:

1. **Handoff format template** (static — never changes between calls)
2. **Repo context** (semi-static — CLAUDE.md, system map, ADRs; rarely changes for a given target repo)
3. **Work item details** (dynamic — unique per handoff generation request)

Anthropic's prompt caching (prefix caching) allows marking the boundary of cacheable content with `cache_control: { type: 'ephemeral' }`. Content up to and including the last cache-marked block is cached for ~5 minutes, reducing latency and cost on repeated calls to the same repo.

A prompt caching utility was previously merged at `lib/prompt-cache.ts`. Check if that file exists before deciding how to import from it vs. implementing inline.

The orchestrator currently uses either `@ai-sdk/anthropic` (AI SDK) or the direct `@anthropic-ai/sdk`. The implementation must match whichever is actually used.

**Goal:** Structure the Anthropic API call so that static and semi-static blocks carry `cache_control: { type: 'ephemeral' }` metadata, with the dynamic work-item block last and unmarked.

## Requirements

1. The orchestrator's handoff generation function must pass `cache_control: { type: 'ephemeral' }` on the last block of the handoff format template content.
2. Repo context blocks (CLAUDE.md, system map, ADRs) must also carry `cache_control: { type: 'ephemeral' }` on the last such block in the message array.
3. Work item-specific content must appear last in the message array with no `cache_control`.
4. If `lib/prompt-cache.ts` exists, import and use its helpers rather than duplicating logic.
5. If `lib/prompt-cache.ts` does not exist, implement `cache_control` formatting inline with a local helper.
6. The existing orchestrator behavior (prompt content, model selection, temperature, output parsing) must be fully preserved — only the message structure changes.
7. `npx tsc --noEmit` must pass with zero errors.
8. No new runtime dependencies. Only use the SDK already installed (`@ai-sdk/anthropic` or `@anthropic-ai/sdk`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/orchestrator-prompt-caching
```

### Step 1: Audit existing code

Read the relevant files to understand the current implementation before making any changes:

```bash
cat lib/orchestrator.ts
cat lib/prompt-cache.ts 2>/dev/null || echo "prompt-cache.ts NOT FOUND"
cat package.json | grep -E '"@ai-sdk|anthropic"'
```

Key things to determine:
- Which Anthropic SDK is used for the handoff generation call (`@ai-sdk/anthropic` `generateText`/`streamText`, or direct `anthropic.messages.create`)
- How the prompt is currently structured (single string, messages array, system prompt, etc.)
- Whether `lib/prompt-cache.ts` exists and what it exports
- The exact function name that generates handoff files (likely something like `generateHandoff` or similar)

### Step 2: Understand the prompt structure

Identify where inside `lib/orchestrator.ts` the following content lives:
- The handoff v3 format template (the large static markdown block describing the handoff format)
- The repo context assembly (where CLAUDE.md, system map, ADR content is concatenated)
- The work item details injection

Map each to a variable or string concatenation point. You need to split the prompt at these boundaries.

### Step 3: Implement cache_control block helpers

**If `lib/prompt-cache.ts` exists and exports a helper for adding `cache_control`**, import it:

```typescript
import { withCacheControl } from './prompt-cache';
// or whatever it actually exports — check the file
```

**If `lib/prompt-cache.ts` does NOT exist**, add a local helper near the top of `orchestrator.ts` (or in a small inline section):

```typescript
// Inline cache_control helper — prefer importing from lib/prompt-cache if available
function ephemeral<T extends { type: string }>(block: T): T & { cache_control: { type: 'ephemeral' } } {
  return { ...block, cache_control: { type: 'ephemeral' } };
}
```

### Step 4: Refactor the prompt into structured message blocks

The goal is to transform what is likely a single concatenated string prompt into structured content blocks that the Anthropic SDK accepts with `cache_control`.

**Pattern for `@ai-sdk/anthropic` (AI SDK `generateText`/`streamText`):**

The AI SDK passes `providerOptions` or uses `anthropic` provider-specific message extensions. Check the AI SDK anthropic docs — as of `@ai-sdk/anthropic` ≥ 0.0.39, you can pass content blocks with `cache_control` via the `messages` array using the provider's block format.

Typical shape:

```typescript
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const result = await generateText({
  model: anthropic('claude-3-5-sonnet-20241022'),
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: HANDOFF_FORMAT_TEMPLATE,
          // @ts-ignore if needed for provider-specific field
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: repoContextBlock,   // CLAUDE.md + system map + ADRs
          // @ts-ignore if needed
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: workItemBlock,      // dynamic — no cache_control
        },
      ],
    },
  ],
});
```

**Pattern for direct Anthropic SDK (`anthropic.messages.create`):**

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 4096,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: HANDOFF_FORMAT_TEMPLATE,
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: repoContextBlock,
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: workItemBlock,
          // no cache_control — dynamic content
        },
      ],
    },
  ],
});
```

**Important implementation rules:**
- Extract the handoff format template into a named constant `HANDOFF_FORMAT_TEMPLATE` at module scope (so it is truly static and not rebuilt each call).
- Build `repoContextBlock` by concatenating CLAUDE.md + system map + ADR content — this was likely already assembled; just separate it from the work item text.
- Build `workItemBlock` from the work item fields (title, description, acceptance criteria, etc.).
- If the orchestrator currently uses a `system` prompt for the template and a `user` message for context + work item, you may need to move the template into the first user content block to support `cache_control` (the system prompt in the AI SDK does support `cache_control` via provider options — check what's simpler given the existing code).

### Step 5: Handle TypeScript types

The `cache_control` field may not be in the SDK's TypeScript types depending on the version. Use one of:

**Option A — type assertion on the content array:**
```typescript
const content = [
  { type: 'text' as const, text: HANDOFF_FORMAT_TEMPLATE, cache_control: { type: 'ephemeral' as const } },
  { type: 'text' as const, text: repoContextBlock, cache_control: { type: 'ephemeral' as const } },
  { type: 'text' as const, text: workItemBlock },
] as Parameters<typeof client.messages.create>[0]['messages'][0]['content'];
```

**Option B — cast the entire messages array:**
```typescript
messages: messages as Anthropic.MessageParam[],
```

**Option C — check if `lib/prompt-cache.ts` already exports typed wrappers** (preferred if the file exists).

Pick whichever approach compiles cleanly. The goal is zero `tsc` errors without suppressing them globally.

### Step 6: Verify the content blocks are non-empty

Add a guard before the API call to ensure the template and context strings are non-empty, preventing degenerate cache blocks:

```typescript
if (!HANDOFF_FORMAT_TEMPLATE || HANDOFF_FORMAT_TEMPLATE.length < 100) {
  throw new Error('HANDOFF_FORMAT_TEMPLATE is unexpectedly empty');
}
```

This is a cheap safety check.

### Step 7: Preserve all existing behavior

Double-check that:
- The model name used in the API call is unchanged.
- `max_tokens`, `temperature`, and any other parameters are unchanged.
- The output parsing (extracting the handoff markdown from the response) is unchanged.
- Any error handling / retry logic is unchanged.
- The function signature and return type of the handoff generation function are unchanged.

### Step 8: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- `cache_control` not in content block type → use type assertion or `// @ts-ignore` as last resort with a comment explaining why.
- Import path issues → check `lib/prompt-cache.ts` export names match what you import.

### Step 9: Smoke test (if possible)

If there is a way to run the orchestrator locally or in a test harness, do a quick smoke test:

```bash
npm run build 2>&1 | head -50
```

If there are integration tests:
```bash
npm test -- --testPathPattern=orchestrator 2>&1 | tail -30
```

### Step 10: Verification

```bash
npx tsc --noEmit
npm run build
```

Confirm:
- Zero TypeScript errors
- Build succeeds
- `lib/orchestrator.ts` now contains `cache_control` on the static/semi-static content blocks
- The handoff format template is extracted to a module-level constant

### Step 11: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add prompt caching to orchestrator handoff generation

- Extract HANDOFF_FORMAT_TEMPLATE to module-level constant
- Structure API call as multi-block content array
- Apply cache_control: ephemeral to template and repo context blocks
- Work item details block has no cache_control (dynamic)
- Import from lib/prompt-cache if available, else inline helper"

git push origin feat/orchestrator-prompt-caching

gh pr create \
  --title "feat: add prompt caching to orchestrator handoff generation" \
  --body "## Summary
Applies Anthropic prefix caching to the orchestrator's handoff generation prompt.

## Changes
- \`lib/orchestrator.ts\`: Restructured the Anthropic API call to use multi-block content arrays with \`cache_control: { type: 'ephemeral' }\` on the static handoff format template and semi-static repo context blocks (CLAUDE.md, system map, ADRs). Work item-specific content remains as the final uncached block.
- Extracted the handoff format template into a module-level constant so it is not rebuilt on each invocation.

## Why
Reduces latency and API cost for repeated handoff generations targeting the same repo. The repo context (CLAUDE.md + system map + ADRs) is typically hundreds of tokens that are identical across sequential work items in the same repo.

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Existing orchestrator behavior (prompt content, model, output parsing) is fully preserved

## Risk
Low — only the message structure changes, not the content or logic."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/orchestrator-prompt-caching
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed — e.g. "SDK version does not support cache_control on content blocks, needs @anthropic-ai/sdk upgrade"]
NEXT STEPS: [what remains]
```

**Most likely blockers and resolutions:**
- *SDK version too old for `cache_control` on content blocks*: Check `package.json` for `@anthropic-ai/sdk` version; `cache_control` on messages requires ≥ 0.26.0. If too old, escalate rather than upgrading SDK unilaterally.
- *Orchestrator uses a single string prompt rather than messages array*: Restructure to messages array as shown in Step 4 — this is the expected refactor.
- *`lib/prompt-cache.ts` exports don't match expected API*: Read the file carefully and adapt import accordingly.