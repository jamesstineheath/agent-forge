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

The Agent Forge decomposer (`lib/decomposer.ts`) converts Notion architecture plan pages into ordered DAGs of work items. It makes a large Claude API call with a substantial static prompt covering decomposition guidelines, work item format specifications, and dependency constraints — these can exceed 2000+ tokens and are repeated on every decomposition run.

Anthropic's prompt caching (prefix caching) allows us to mark static/semi-static content blocks with `cache_control: { type: 'ephemeral' }` so the API caches those token prefixes and charges reduced rates on cache hits. The rule is: place `cache_control` on the **last** content block in each static segment. Dynamic content (the actual plan text) should appear last with no cache_control.

The AI SDK (`@ai-sdk/anthropic`) supports passing `providerOptions` or experimental message extensions to thread cache_control through to the Anthropic API. However, since the decomposer likely calls the Anthropic SDK directly (or via the AI SDK), we need to inspect the current call pattern and apply cache_control accordingly.

Looking at the repo's tech stack: `@ai-sdk/anthropic` + `ai` are used. The AI SDK's `generateText`/`streamText` support provider-specific message parts. For Anthropic cache_control, the pattern is to use the Anthropic SDK directly with `anthropic.messages.create()` passing content blocks with `cache_control`, OR to use the AI SDK's `experimental_providerMetadata` on message parts.

## Requirements

1. The decomposer's API call must use `cache_control: { type: 'ephemeral' }` on static content blocks (decomposition rules + work item format spec).
2. Static decomposition guidelines must appear first in the content/message structure.
3. Repo context (semi-static) must appear after guidelines but before the plan, with `cache_control` applied to the last semi-static block (the repo context block).
4. The architecture plan content must appear last in the message with no `cache_control`.
5. TypeScript compiles with no errors (`npx tsc --noEmit` passes).
6. The decomposer's functional output (work item DAG) must be unchanged — this is purely a caching optimization.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decomposer-prompt-caching
```

### Step 1: Inspect the current decomposer implementation

Read `lib/decomposer.ts` in full to understand:
- How the Anthropic/AI SDK is invoked (direct SDK vs AI SDK's `generateText`/`streamText`)
- How the prompt is currently structured (system prompt, user messages, single string vs content array)
- What static vs dynamic sections exist and their variable names

```bash
cat lib/decomposer.ts
```

Also check what Anthropic-related packages are installed:
```bash
cat package.json | grep -E "anthropic|ai-sdk|@ai-sdk"
```

### Step 2: Understand the caching approach for the SDK in use

**If using the Anthropic SDK directly** (`@anthropic-ai/sdk` / `import Anthropic from '@anthropic-ai/sdk'`):

Structure the `messages.create()` call with explicit content blocks:

```typescript
const response = await anthropic.messages.create({
  model: 'claude-opus-4-5', // or whatever model is currently used
  max_tokens: 8192,
  system: [
    {
      type: 'text',
      text: DECOMPOSITION_GUIDELINES, // static rules block
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: repoContext, // semi-static: CLAUDE.md + system map
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: planContent, // dynamic: the actual Notion plan — NO cache_control
        },
      ],
    },
  ],
});
```

**If using AI SDK's `generateText` with `@ai-sdk/anthropic`**:

The AI SDK supports Anthropic cache_control via `experimental_providerMetadata`:

```typescript
import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const result = await generateText({
  model: anthropic('claude-opus-4-5'),
  system: DECOMPOSITION_GUIDELINES, // system prompt stays as-is OR move to messages
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: repoContext,
          experimental_providerMetadata: {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          },
        },
        {
          type: 'text',
          text: planContent,
          // no cacheControl here — dynamic content
        },
      ],
    },
  ],
});
```

However, the **system prompt** in AI SDK doesn't directly support cache_control via the standard interface. If cache_control on the system prompt is needed and the current code uses AI SDK, consider switching the system prompt to be the first `user` message content block with cache_control, or use the Anthropic SDK directly for this call.

**Recommended approach if either SDK is available**: Use the Anthropic SDK directly for the decomposer call (it's already a dependency via `@ai-sdk/anthropic` which wraps it), as it gives full control over content block cache_control placement.

### Step 3: Refactor `lib/decomposer.ts`

Based on Step 1 findings, apply the following transformation. The exact edit depends on the current structure, but the pattern is:

**3a. Extract static prompt sections into named constants** (if not already separated):

```typescript
// At the top of the file or in a dedicated const block:
const DECOMPOSITION_SYSTEM_PROMPT = `You are an expert software architect and project decomposer...
[all the static decomposition rules, work item format spec, dependency constraints]
...`;
```

**3b. Restructure the API call** to use content blocks with cache_control.

If currently using a single concatenated string prompt, split it into:
1. `DECOMPOSITION_SYSTEM_PROMPT` — static guidelines (cache this)
2. `repoContext` — semi-static repo CLAUDE.md + system map (cache this, it's the last semi-static block before dynamic content)
3. `planContent` — the Notion plan text (do NOT cache)

**3c. Apply cache_control** following the pattern in Step 2 appropriate to the SDK in use.

Key rules:
- `cache_control` goes on the **last** block of each static segment
- If system prompt is one block → put `cache_control` on that block
- If user message has [repoContext, planContent] → put `cache_control` on `repoContext` only
- Never put `cache_control` on the final dynamic `planContent` block

### Step 4: Ensure TypeScript types are satisfied

The Anthropic SDK types for `cache_control` on content blocks and system prompt are:

```typescript
// System prompt with cache_control (Anthropic SDK direct):
system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>

// Content blocks with cache_control (Anthropic SDK direct):
content: Array<{
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}>
```

If you get TypeScript errors about `cache_control` not existing on the type, you may need to:
- Ensure `@anthropic-ai/sdk` is up to date (cache_control was added in SDK v0.20+)
- Use a type assertion: `as any` as a last resort, but prefer proper typing

Check the installed version:
```bash
cat node_modules/@anthropic-ai/sdk/package.json | grep '"version"'
# or
cat node_modules/@ai-sdk/anthropic/package.json | grep '"version"'
```

### Step 5: Verification

```bash
# TypeScript check — must pass with zero errors
npx tsc --noEmit

# Build check
npm run build

# If there are unit tests for the decomposer, run them
npm test -- --testPathPattern=decomposer 2>/dev/null || echo "No decomposer tests found"
```

The decomposer is invoked during plan decomposition flows. We are not changing any logic, only the structure of the API call — the output (array of work items with dependencies) should be identical.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add prompt caching to decomposer API call

Apply cache_control: { type: 'ephemeral' } to static content blocks
in the Plan Decomposer's Anthropic API call.

- Static decomposition guidelines cached in system prompt block
- Repo context (semi-static) cached as first user content block
- Architecture plan content appears last with no cache_control

Decomposition prompts are 2000+ tokens of static rules, making this
a high-impact caching target for repeated decomposition runs."

git push origin feat/decomposer-prompt-caching

gh pr create \
  --title "feat: add prompt caching to decomposer API call" \
  --body "## Summary
Applies Anthropic prefix caching to the Plan Decomposer's API call by structuring content blocks with \`cache_control: { type: 'ephemeral' }\` on static segments.

## Changes
- \`lib/decomposer.ts\`: Restructured API call to use explicit content blocks with cache_control on static decomposition guidelines and semi-static repo context

## Caching Structure
1. **System prompt / decomposition guidelines** → \`cache_control: { type: 'ephemeral' }\` (static, 2000+ tokens)
2. **Repo context** (CLAUDE.md + system map) → \`cache_control: { type: 'ephemeral' }\` (semi-static, refreshed per repo)
3. **Architecture plan content** → no cache_control (dynamic, changes every call)

## Why
Decomposition prompts are large (2000+ tokens of static rules/format specs). Caching these blocks reduces cost and latency on repeated decomposition runs against the same repo.

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- No logic changes — output (work item DAG) is functionally identical"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decomposer-prompt-caching
FILES CHANGED: [lib/decomposer.ts]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., SDK version doesn't support cache_control types, or prompt structure is more complex than expected]
NEXT STEPS: [what remains — e.g., need to handle multipart system prompt, or upgrade SDK version]
```

## Escalation

If you encounter blockers you cannot resolve autonomously (e.g., the decomposer uses a completely different SDK pattern not covered above, cache_control types are missing from the installed SDK version and cannot be worked around, or the prompt structure requires architectural changes beyond this task's scope):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-decomposer-prompt-caching",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```