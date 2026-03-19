# Agent Forge -- Migrate Orchestrator to Use Model Router

## Metadata
- **Branch:** `feat/migrate-orchestrator-to-model-router`
- **Priority:** high
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** lib/orchestrator.ts

## Context

Agent Forge uses a centralized model router (`lib/model-router.ts`) to route Anthropic API calls with task-type-aware model selection, telemetry, and signal extraction. The decomposer was recently migrated to use `routedAnthropicCall` (see PR: "refactor: migrate decomposer to use model router"). The orchestrator (`lib/orchestrator.ts`) still makes direct Anthropic SDK calls and needs to be migrated for consistency.

The model router exports a `routedAnthropicCall` function that accepts:
```typescript
routedAnthropicCall({
  taskType: string,           // e.g. 'handoff_generation'
  workItemSignals: WorkItemSignals,
  messages: MessageParam[],
  system?: string,
  maxTokens?: number,
})
```

`WorkItemSignals` is defined in `lib/model-router.ts` and looks approximately like:
```typescript
interface WorkItemSignals {
  criteriaCount?: number;
  repoCount?: number;
  workItemType?: string;
  complexity?: string;
}
```

Check `lib/model-router.ts` and `lib/decomposer.ts` (post-migration) for exact interface shapes and usage patterns before writing any code.

The orchestrator is responsible for reading repo context (CLAUDE.md, system map, ADRs) and generating handoff files via Claude. The handoff generation logic is the primary call site to migrate.

## Requirements

1. `lib/orchestrator.ts` no longer imports `Anthropic` from `@anthropic-ai/sdk` for completions (import may remain only if used for non-completion purposes like type imports — remove it entirely if unused)
2. All Anthropic completion/message calls in `lib/orchestrator.ts` are replaced with `routedAnthropicCall`
3. Each call uses `taskType: 'handoff_generation'`
4. `WorkItemSignals` are correctly extracted from the work item being processed:
   - `criteriaCount`: number of acceptance criteria items (count array length or parse from string)
   - `repoCount`: number of target repos (typically 1, but extract from work item if present)
   - `workItemType`: the work item's `type` field
   - `complexity`: the work item's `complexity` field (if present)
5. Direct Anthropic SDK import is removed if it is no longer used after the migration
6. `npm run build` passes with no TypeScript errors
7. Existing orchestrator functionality is preserved — handoff generation logic, prompts, and output are unchanged

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/migrate-orchestrator-to-model-router
```

### Step 1: Read the model router interface

Read `lib/model-router.ts` in full to understand:
- The exact `WorkItemSignals` interface shape
- The `routedAnthropicCall` function signature (parameters, return type)
- Any required imports

```bash
cat lib/model-router.ts
```

### Step 2: Read the migrated decomposer for usage patterns

Read `lib/decomposer.ts` to see how `routedAnthropicCall` was used in a prior migration. Pay attention to:
- How `workItemSignals` are constructed
- How the return value is used (it likely returns a typed response — check if it wraps the SDK response or returns content directly)

```bash
cat lib/decomposer.ts
```

### Step 3: Read the orchestrator fully

Read `lib/orchestrator.ts` in full to identify:
- All Anthropic SDK imports
- Every location where `anthropic.messages.create` (or equivalent) is called
- The work item object shape available at each call site
- How the response content is accessed and used after each call

```bash
cat lib/orchestrator.ts
cat lib/types.ts   # to understand the WorkItem type shape
```

### Step 4: Implement the migration in lib/orchestrator.ts

For each Anthropic SDK call site found:

1. **Replace the import** — remove `import Anthropic from '@anthropic-ai/sdk'` (and any `new Anthropic(...)` instantiation) if no longer needed. Add:
   ```typescript
   import { routedAnthropicCall } from './model-router';
   ```

2. **Extract WorkItemSignals** at each call site. Example pattern (adapt to actual work item shape):
   ```typescript
   const workItemSignals = {
     criteriaCount: Array.isArray(workItem.acceptanceCriteria)
       ? workItem.acceptanceCriteria.length
       : typeof workItem.acceptanceCriteria === 'string'
         ? workItem.acceptanceCriteria.split('\n').filter(Boolean).length
         : 0,
     repoCount: workItem.repoName ? 1 : 0,
     workItemType: workItem.type,
     complexity: workItem.complexity,
   };
   ```

3. **Replace the call**:
   ```typescript
   // Before:
   const response = await anthropic.messages.create({
     model: '...',
     system: systemPrompt,
     messages: [...],
     max_tokens: 4096,
   });
   const content = response.content[0].type === 'text' ? response.content[0].text : '';

   // After:
   const response = await routedAnthropicCall({
     taskType: 'handoff_generation',
     workItemSignals,
     messages: [...],
     system: systemPrompt,
     maxTokens: 4096,
   });
   // Adapt content extraction to match routedAnthropicCall's return type
   // (check model-router.ts — it likely returns the SDK MessageParam response directly)
   ```

4. **Preserve all prompt content** — do not modify system prompts, user messages, or any logic that constructs them. Only replace the SDK call mechanism.

5. **Remove unused imports/variables** — if `Anthropic`, `anthropic` client instance, or related env var reads are no longer needed, remove them cleanly.

### Step 5: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `routedAnthropicCall` return type may differ from the raw SDK response — check the return type in `model-router.ts` and update content extraction accordingly
- `WorkItemSignals` fields may be optional — ensure extracted values are compatible (use `?? undefined` as needed)

### Step 6: Build verification

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 7: Verify no direct Anthropic SDK usage remains for completions

```bash
grep -n "anthropic" lib/orchestrator.ts
grep -n "@anthropic-ai/sdk" lib/orchestrator.ts
grep -n "messages.create" lib/orchestrator.ts
```

Expected: no remaining direct SDK completion calls. The only `anthropic`-related content should be the `routedAnthropicCall` import from `./model-router`.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "refactor: migrate orchestrator to use model router"
git push origin feat/migrate-orchestrator-to-model-router
gh pr create \
  --title "refactor: migrate orchestrator to use model router" \
  --body "## Summary

Replaces direct Anthropic SDK calls in \`lib/orchestrator.ts\` with calls through the centralized \`routedAnthropicCall\` function from \`lib/model-router.ts\`.

## Changes
- Removed direct \`@anthropic-ai/sdk\` import and client instantiation from orchestrator
- All handoff generation API calls now go through \`routedAnthropicCall\` with \`taskType: 'handoff_generation'\`
- \`WorkItemSignals\` extracted from work item at each call site (criteriaCount, repoCount, workItemType, complexity)

## Motivation
Consistent with the decomposer migration (refactor: migrate decomposer to use model router). Centralizes model selection, telemetry, and routing logic.

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- No direct Anthropic SDK calls remain in orchestrator.ts
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/migrate-orchestrator-to-model-router
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter a blocker (e.g., `routedAnthropicCall` return type is incompatible in a non-obvious way, `WorkItemSignals` interface doesn't match what's available on the work item, or the orchestrator has multiple heterogeneous call sites with different response shapes), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "migrate-orchestrator-to-model-router",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/orchestrator.ts"]
    }
  }'
```