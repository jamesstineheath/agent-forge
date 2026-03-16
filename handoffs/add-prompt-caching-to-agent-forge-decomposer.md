# Agent Forge -- Add prompt caching to Agent Forge decomposer

## Metadata
- **Branch:** `feat/decomposer-prompt-caching`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/decomposer.ts

## Context

The Agent Forge decomposer (`lib/decomposer.ts`) converts architecture plan pages (from Notion) into ordered DAGs of work items. It uses a substantial prompt containing:

1. Static decomposition guidelines and constraints
2. Static work item format specification
3. Semi-static repo context (CLAUDE.md, system map, ADRs from target repo)
4. Dynamic plan content (the specific Notion plan page being decomposed)

Decomposition prompts tend to be large (2000+ tokens for the system instructions alone). By applying Anthropic prefix caching (`cache_control: { type: 'ephemeral' }`) to the static and semi-static portions, we can significantly reduce token costs and latency on repeated or similar decomposition calls — mirroring the same pattern already applied to the orchestrator (`lib/orchestrator.ts`).

A recent merged PR (`feat: add prompt caching to orchestrator handoff generation`) applied this pattern to `lib/orchestrator.ts`. The decomposer should follow the same approach.

## Requirements

1. The decomposer's API call uses `cache_control: { type: 'ephemeral' }` on the last static/semi-static content block
2. Static decomposition guidelines appear first in the message content array
3. Repo context appears after guidelines but before the plan content, with `cache_control` on the last semi-static block (repo context)
4. The architecture plan text appears last in the content array without `cache_control`
5. TypeScript compiles with no errors (`npx tsc --noEmit` passes)
6. Existing decomposer behavior (output shape, work item generation) is unchanged

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decomposer-prompt-caching
```

### Step 1: Read the current decomposer implementation

```bash
cat lib/decomposer.ts
```

Understand the full current implementation before modifying. Pay attention to:
- How the Anthropic client is instantiated (look for `@ai-sdk/anthropic`, `anthropic` SDK direct usage, or `ai` SDK)
- The current message/prompt structure passed to the model
- Where the static guidelines, repo context, and plan content are assembled
- Any existing TypeScript types in use

Also check the orchestrator for the exact caching pattern already in use:
```bash
cat lib/orchestrator.ts
```

### Step 2: Understand the caching pattern from orchestrator

The orchestrator already uses prompt caching. The pattern (using the Anthropic SDK directly or via AI SDK) involves structuring content as an array of blocks where `cache_control: { type: 'ephemeral' }` is placed on the last block that should be cached. Example shape:

```typescript
// If using Anthropic SDK directly:
const response = await anthropic.messages.create({
  model: "claude-...",
  max_tokens: ...,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: STATIC_GUIDELINES_TEXT,
          cache_control: { type: "ephemeral" }, // cache up through here if no repo context
        },
        {
          type: "text",
          text: repoContextText,
          cache_control: { type: "ephemeral" }, // cache up through repo context (last semi-static block)
        },
        {
          type: "text",
          text: planContent, // dynamic — NO cache_control
        },
      ],
    },
  ],
});
```

Match whatever SDK and pattern is already used in `lib/orchestrator.ts` exactly.

### Step 3: Restructure the decomposer API call

Modify `lib/decomposer.ts` to structure the prompt as ordered content blocks:

**Block 1 — Static decomposition guidelines** (the rules, constraints, output format specification):
- This is the large static system-level text about how to decompose plans into work items
- Include `cache_control: { type: 'ephemeral' }` ONLY if there is no separate repo context block (i.e., if repo context is empty or not provided). If repo context is present, do NOT put `cache_control` here — it goes on the last semi-static block.

**Block 2 — Repo context** (CLAUDE.md, system map, ADRs — semi-static per target repo):
- Apply `cache_control: { type: 'ephemeral' }` here (this is the last semi-static block)
- If repo context is absent/empty, move `cache_control` to Block 1 instead

**Block 3 — Plan content** (the specific Notion plan being decomposed — dynamic):
- No `cache_control`
- This is what changes on every call

The key invariant: `cache_control` goes on the **last block that is static or semi-static**, so the cache prefix covers all content up to and including that block.

### Step 4: Handle the case where repo context may be absent

If the decomposer can be called without repo context (e.g., when no target repo is registered), ensure `cache_control` falls back to the static guidelines block:

```typescript
// Pseudo-logic:
const contentBlocks = [];

if (repoContext) {
  contentBlocks.push({ type: "text", text: STATIC_PROMPT });
  contentBlocks.push({ type: "text", text: repoContext, cache_control: { type: "ephemeral" } });
} else {
  contentBlocks.push({ type: "text", text: STATIC_PROMPT, cache_control: { type: "ephemeral" } });
}

contentBlocks.push({ type: "text", text: planContent }); // always last, no cache_control
```

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- If the SDK type for content blocks doesn't include `cache_control`, you may need to cast or use the Anthropic SDK's `TextBlockParam` type with the `cache_control` field. Check how orchestrator.ts handles this.
- If using the `ai` SDK (`generateObject`/`generateText`), check whether it supports `cache_control` on content parts or whether the decomposer needs to use the Anthropic SDK directly (as the orchestrator likely does).

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Confirm no type errors and the build succeeds.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add prompt caching to decomposer"
git push origin feat/decomposer-prompt-caching
gh pr create \
  --title "feat: add prompt caching to decomposer" \
  --body "## Summary

Applies Anthropic prefix caching to the Plan Decomposer's prompt, following the same pattern used in the orchestrator (merged in a recent PR).

## Changes

- \`lib/decomposer.ts\`: Restructured the API call to use an ordered content block array with \`cache_control: { type: 'ephemeral' }\` on the last static/semi-static block (repo context, or static guidelines if no repo context is present). The plan content block remains dynamic with no cache annotation.

## Cache structure

1. Static decomposition guidelines (large, ~2000+ tokens)
2. Repo context / CLAUDE.md / system map — \`cache_control: { type: 'ephemeral' }\` ← cache prefix ends here
3. Plan content (dynamic, changes per call) — no cache_control

## Impact

Reduces cost and latency on repeated decomposition calls, particularly impactful because decomposition prompts are large. No behavioral changes to work item output."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decomposer-prompt-caching
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If you encounter a blocker you cannot resolve autonomously (e.g., the decomposer uses a fundamentally different SDK than the orchestrator and `cache_control` is not supported, or there are ambiguous architectural decisions), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "decomposer-prompt-caching",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```