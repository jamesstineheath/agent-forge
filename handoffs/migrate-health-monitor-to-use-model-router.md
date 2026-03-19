# Agent Forge -- Migrate Health Monitor to Use Model Router

## Metadata
- **Branch:** `feat/migrate-health-monitor-model-router`
- **Priority:** high
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** lib/atc/health-monitor.ts

## Context

The Agent Forge codebase has a centralized model router (`lib/model-router.ts`) that was introduced to standardize all Anthropic API calls across the system. The decomposer was recently migrated to use this pattern (see recent PR: "refactor: migrate decomposer to use model router").

The `lib/atc/health-monitor.ts` agent currently makes direct Anthropic SDK calls for its AI-powered operations (health assessment, stall analysis, recovery decisions). These need to be migrated to go through `routedAnthropicCall` from `lib/model-router.ts`.

The model router provides:
- Centralized telemetry emission
- Task-type-aware model selection
- Consistent error handling patterns

The relevant pattern from `lib/model-router.ts` is:
```typescript
import { routedAnthropicCall, WorkItemSignals } from '../model-router';

// Usage:
const response = await routedAnthropicCall({
  taskType: 'health_assessment',
  signals: workItemSignals,
  messages: [...],
  system: '...',
  max_tokens: 1024,
});
```

`WorkItemSignals` is extracted from a work item to give the router context about what's being processed. Look at how the decomposer extracts these signals from work items for reference.

## Requirements

1. `lib/atc/health-monitor.ts` must no longer import from the Anthropic SDK (`@anthropic-ai/sdk`) for completion calls
2. All Anthropic completion API calls in `lib/atc/health-monitor.ts` must be replaced with `routedAnthropicCall` using `taskType: 'health_assessment'`
3. `WorkItemSignals` must be correctly extracted from the work item(s) being analyzed at each call site
4. The direct Anthropic SDK import (`import Anthropic from '@anthropic-ai/sdk'` or similar) must be removed if it is no longer used after the migration
5. The project must compile successfully with `npx tsc --noEmit` and `npm run build`
6. No behavioral changes — only the API call mechanism changes; all prompts, logic, and response parsing remain identical

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/migrate-health-monitor-model-router
```

### Step 1: Understand the model router interface

Read the model router to understand exact function signatures and types:
```bash
cat lib/model-router.ts
```

Note:
- The exact signature of `routedAnthropicCall`
- The shape of `WorkItemSignals` (fields like `id`, `title`, `repo`, `priority`, `type`, etc.)
- How `WorkItemSignals` is constructed — look at any existing call sites in the codebase

Also look at how the decomposer was migrated for a concrete example:
```bash
cat lib/decomposer.ts
```

### Step 2: Audit all Anthropic SDK usage in health-monitor.ts

```bash
cat lib/atc/health-monitor.ts
```

Identify:
1. All `import` statements referencing `@anthropic-ai/sdk` or a shared Anthropic client
2. Every location where `anthropic.messages.create(...)` (or equivalent) is called
3. What work item context is available at each call site (the work item object being analyzed)
4. The message arrays, system prompts, and `max_tokens` values at each call site

Make a mental note of each call site before modifying anything.

### Step 3: Add the model router import

At the top of `lib/atc/health-monitor.ts`, add the import:

```typescript
import { routedAnthropicCall, WorkItemSignals } from '../model-router';
```

(Adjust the relative path if the file structure differs — verify with `ls lib/atc/` and `ls lib/`.)

### Step 4: Replace each Anthropic SDK call site

For each call site found in Step 2, replace the direct SDK call with `routedAnthropicCall`. Follow this pattern:

**Before (example):**
```typescript
const response = await anthropic.messages.create({
  model: 'claude-...',
  system: systemPrompt,
  messages: messageArray,
  max_tokens: 1024,
});
const text = response.content[0].type === 'text' ? response.content[0].text : '';
```

**After:**
```typescript
// Extract WorkItemSignals from the work item being analyzed
const signals: WorkItemSignals = {
  id: workItem.id,
  title: workItem.title,
  repo: workItem.repo,
  priority: workItem.priority,
  type: workItem.type,
  // add other fields as required by the WorkItemSignals type
};

const response = await routedAnthropicCall({
  taskType: 'health_assessment',
  signals,
  system: systemPrompt,
  messages: messageArray,
  max_tokens: 1024,
});
const text = response.content[0].type === 'text' ? response.content[0].text : '';
```

Important notes:
- Keep all prompt text, system prompts, message arrays, and response parsing logic **exactly the same** — only the call mechanism changes
- If a call site does not have a single work item in scope (e.g., it operates on a batch), construct `WorkItemSignals` from the most relevant work item, or the first item in the batch
- If `WorkItemSignals` has required fields that aren't available (e.g., the health monitor analyzes system-level state rather than a specific work item), check whether `routedAnthropicCall` accepts a partial signals object or a null — consult the model router type definitions
- Preserve existing `try/catch` blocks and error handling around each call site

### Step 5: Remove the direct Anthropic SDK import

After replacing all call sites, check whether the Anthropic SDK is still referenced anywhere in the file:

```bash
grep -n 'anthropic\|Anthropic\|@anthropic-ai' lib/atc/health-monitor.ts
```

If the only remaining references are the SDK import and the `new Anthropic()` client instantiation (i.e., no other usage remains), remove them. If the SDK is used for other purposes (e.g., type imports), retain only what is still needed.

### Step 6: Verify compilation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `WorkItemSignals` missing required fields → add them from the work item object
- Return type of `routedAnthropicCall` differs slightly from direct SDK return → adjust response parsing if needed (but keep content extraction logic equivalent)
- Relative import path wrong → correct to the right number of `../` levels

### Step 7: Run the build

```bash
npm run build
```

Resolve any build errors. Do not proceed to commit if the build fails.

### Step 8: Sanity check the diff

```bash
git diff lib/atc/health-monitor.ts
```

Verify:
- No prompt text has changed
- No response parsing logic has changed
- Only imports and call sites are different
- `routedAnthropicCall` is called at every former SDK call site
- `taskType: 'health_assessment'` is present at every call

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "refactor: migrate health monitor to use model router"
git push origin feat/migrate-health-monitor-model-router
gh pr create \
  --title "refactor: migrate health monitor to use model router" \
  --body "## Summary

Migrates all direct Anthropic SDK calls in \`lib/atc/health-monitor.ts\` to go through the centralized \`routedAnthropicCall\` from \`lib/model-router.ts\`, using \`taskType: 'health_assessment'\`.

## Changes
- \`lib/atc/health-monitor.ts\`: replaced all \`anthropic.messages.create\` calls with \`routedAnthropicCall\`, extracted \`WorkItemSignals\` at each call site, removed direct Anthropic SDK import

## No Behavioral Changes
All prompts, system messages, response parsing, and error handling are preserved exactly. Only the API call mechanism has changed.

## Acceptance Criteria
- [x] No direct Anthropic SDK completion calls remain in health-monitor.ts
- [x] All calls use \`routedAnthropicCall\` with \`taskType: 'health_assessment'\`
- [x] \`WorkItemSignals\` correctly extracted at each call site
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/migrate-health-monitor-model-router
FILES CHANGED: [lib/atc/health-monitor.ts]
SUMMARY: [what was done]
ISSUES: [what failed or is unclear]
NEXT STEPS: [what remains — e.g., "2 call sites remain unmigrateddue to missing WorkItemSignals context"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., `routedAnthropicCall` does not accept the parameters available at a call site, `WorkItemSignals` type is incompatible, or the model router does not export the expected symbols):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "migrate-health-monitor-model-router",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/health-monitor.ts"]
    }
  }'
```