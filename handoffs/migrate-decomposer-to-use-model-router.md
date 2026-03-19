# Agent Forge -- Migrate decomposer to use model router

## Metadata
- **Branch:** `feat/migrate-decomposer-to-use-model-router`
- **Priority:** high
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** lib/decomposer.ts

## Context

The agent-forge control plane uses Claude (Anthropic SDK) in several places for AI-powered operations. A centralized model router (`lib/model-router.ts`) has been introduced to standardize how these calls are made — enabling routing logic, task-type classification, signal extraction for model selection, and unified observability.

This task migrates `lib/decomposer.ts` to use the model router instead of calling the Anthropic SDK directly. The decomposer is responsible for converting Notion project plans into ordered work items with a dependency DAG.

**Concurrent work to be aware of:** `feat/migrate-orchestrator-to-use-model-router` is modifying `lib/orchestrator.ts`. There is **no file overlap** with this task (`lib/decomposer.ts` only), but be careful not to accidentally modify `lib/orchestrator.ts` or other shared files that the concurrent branch may be touching.

Before starting, read `lib/model-router.ts` and `lib/decomposer.ts` in full to understand the exact API signatures.

## Requirements

1. `lib/decomposer.ts` must not import `Anthropic` or `@anthropic-ai/sdk` after this change (unless used for type-only imports that cannot be eliminated).
2. All Anthropic completion calls in `lib/decomposer.ts` must be replaced with `routedAnthropicCall` imported from `lib/model-router.ts`.
3. Each `routedAnthropicCall` invocation must pass `taskType: 'decomposition'` and a valid `workItemSignals` object.
4. `workItemSignals` must extract real values from the plan context:
   - `criteriaCount`: number of acceptance criteria or requirements extracted from the plan content
   - `repoCount`: number of target repos mentioned in the plan or project metadata
   - `complexity`: derived from plan metadata (e.g. number of sections, total word count, or an explicit complexity field if present)
5. The refactored code must preserve all existing decomposer behavior (same prompts, same output parsing, same error handling).
6. `npm run build` passes with no TypeScript errors.
7. No changes to `lib/orchestrator.ts`, `lib/model-router.ts`, or any other file outside `lib/decomposer.ts` (unless a type import adjustment is strictly necessary in an adjacent types file).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/migrate-decomposer-to-use-model-router
```

### Step 1: Read and understand the existing code

Read these files carefully before making any changes:

```bash
cat lib/decomposer.ts
cat lib/model-router.ts
```

From `lib/model-router.ts`, identify:
- The exact export name and signature of the routed call function (likely `routedAnthropicCall` or similar)
- The shape of `WorkItemSignals` (likely fields: `criteriaCount`, `repoCount`, `complexity` — confirm exact field names and types)
- The shape of the call options object (likely `{ taskType, workItemSignals, messages, system?, maxTokens? }`)
- The return type (should be compatible with what the decomposer currently expects)

From `lib/decomposer.ts`, identify:
- All imports from `@anthropic-ai/sdk` or `anthropic`
- Every location where `anthropic.messages.create(...)` or equivalent is called
- What data is available at each call site (plan object, project metadata, repo config) to extract `WorkItemSignals`
- The system prompt and message structure passed to each call
- How the response is parsed/used

### Step 2: Implement the migration in lib/decomposer.ts

Apply the following changes:

**2a. Replace Anthropic SDK import with model router import**

Remove:
```typescript
import Anthropic from '@anthropic-ai/sdk';
// or: import { Anthropic } from '@anthropic-ai/sdk';
// and any: const anthropic = new Anthropic(...);
```

Add:
```typescript
import { routedAnthropicCall } from './model-router';
// Adjust the relative path if decomposer.ts is not at the root of lib/
```

If `Anthropic` types (e.g. `Anthropic.Messages.MessageParam`) are used in type annotations, replace them with inline types or import from `@anthropic-ai/sdk` as type-only:
```typescript
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
```
Only keep type-only imports if strictly necessary for the code to compile.

**2b. Extract a WorkItemSignals helper**

Add a private helper function near the top of the decomposer logic to extract signals from the plan:

```typescript
function extractDecomposerSignals(plan: <PlanType>): import('./model-router').WorkItemSignals {
  // criteriaCount: count acceptance criteria / requirements bullets in plan content
  // Look for fields like plan.criteria, plan.requirements, plan.acceptanceCriteria
  // Fall back to counting list items in plan description/body if no explicit field
  const criteriaCount = Array.isArray(plan.criteria)
    ? plan.criteria.length
    : Array.isArray(plan.requirements)
    ? plan.requirements.length
    : 0;

  // repoCount: number of distinct repos mentioned in plan metadata or target repos
  // Look for plan.repos, plan.targetRepos, plan.repositories
  const repoCount = Array.isArray(plan.repos)
    ? plan.repos.length
    : Array.isArray(plan.targetRepos)
    ? plan.targetRepos.length
    : 1; // default to 1 if unknown

  // complexity: derive from plan size/structure
  // Use plan.complexity if present, otherwise estimate from content length or section count
  const complexity = typeof plan.complexity === 'number'
    ? plan.complexity
    : typeof plan.body === 'string'
    ? Math.min(10, Math.ceil(plan.body.split('\n').length / 10))
    : 3; // sensible default

  return { criteriaCount, repoCount, complexity };
}
```

**NOTE:** The exact field names above are illustrative. Read the actual `Plan` type in `lib/decomposer.ts` (and `lib/types.ts`) to use the real field names. Adapt the helper accordingly.

**2c. Replace each Anthropic SDK call with routedAnthropicCall**

For each call site, replace:
```typescript
const response = await anthropic.messages.create({
  model: 'claude-...',
  max_tokens: N,
  system: systemPrompt,
  messages: [...],
});
```

With:
```typescript
const response = await routedAnthropicCall({
  taskType: 'decomposition',
  workItemSignals: extractDecomposerSignals(plan),
  messages: [...],
  system: systemPrompt,
  maxTokens: N,
});
```

Preserve the exact same `messages` array and `system` prompt content — do not alter prompts.

**2d. Verify response consumption is compatible**

After replacing calls, check that the code consuming `response` is still valid. The model router should return the same response shape as the Anthropic SDK (`response.content`, `response.content[0].text`, etc.). If the router wraps or transforms the response, adapt the consumption code accordingly — but do **not** change any downstream parsing logic beyond what's needed for type compatibility.

### Step 3: Verify no direct SDK usage remains

```bash
grep -n "anthropic" lib/decomposer.ts
grep -n "@anthropic-ai/sdk" lib/decomposer.ts
grep -n "new Anthropic" lib/decomposer.ts
```

The only remaining matches should be `import type` statements (if any). There must be no `new Anthropic(...)` and no direct `.messages.create(...)` calls.

### Step 4: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Do not suppress errors with `// @ts-ignore` or `as any` unless the model router's types are genuinely incompatible in a way that cannot be resolved structurally — and if you do use a cast, leave an inline comment explaining why.

If `npm run build` fails due to an issue in a file other than `lib/decomposer.ts`, investigate whether it's a pre-existing failure on `main` before assuming you caused it. Check:
```bash
git stash
npm run build
git stash pop
```

### Step 5: Confirm no collateral changes

```bash
git diff --name-only
```

Output must only include `lib/decomposer.ts` (and optionally `lib/types.ts` if a type-only adjustment was needed). If any other files appear in the diff, review and revert unintended changes:
```bash
git checkout -- <unintended-file>
```

### Step 6: Commit, push, open PR

```bash
git add lib/decomposer.ts
# Add lib/types.ts only if you made a necessary type-only change there
git commit -m "refactor: migrate decomposer to use model router

- Replace direct Anthropic SDK calls with routedAnthropicCall
- Pass taskType 'decomposition' and extracted WorkItemSignals
- Extract criteriaCount, repoCount, complexity from plan context
- Remove direct Anthropic SDK imports from decomposer.ts"

git push origin feat/migrate-decomposer-to-use-model-router

gh pr create \
  --title "refactor: migrate decomposer to use model router" \
  --body "## Summary
Migrates \`lib/decomposer.ts\` to use the centralized model router (\`routedAnthropicCall\`) instead of calling the Anthropic SDK directly.

## Changes
- Removed direct \`@anthropic-ai/sdk\` imports and \`Anthropic\` client instantiation from \`lib/decomposer.ts\`
- Added \`routedAnthropicCall\` import from \`lib/model-router.ts\`
- Added \`extractDecomposerSignals(plan)\` helper to derive \`WorkItemSignals\` from plan context
- All completion calls now pass \`taskType: 'decomposition'\` with extracted signals

## WorkItemSignals extraction
- \`criteriaCount\`: count of acceptance criteria/requirements in plan
- \`repoCount\`: number of target repos in plan metadata (default 1)
- \`complexity\`: from plan.complexity field or estimated from content size

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- No changes to prompts, parsing logic, or behavior — pure routing migration

## Concurrent work
This PR only touches \`lib/decomposer.ts\`. The concurrent branch \`feat/migrate-orchestrator-to-use-model-router\` touches \`lib/orchestrator.ts\` — no overlap." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add lib/decomposer.ts
git commit -m "wip: partial decomposer model router migration"
git push origin feat/migrate-decomposer-to-use-model-router
```

2. Open the PR with partial status:
```bash
gh pr create --title "wip: migrate decomposer to use model router" --body "Partial implementation — see ISSUES below." --base main
```

3. If blocked by an unresolvable error, escalate:
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "migrate-decomposer-to-use-model-router",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error message>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```

4. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/migrate-decomposer-to-use-model-router
FILES CHANGED: lib/decomposer.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g. "routedAnthropicCall return type incompatible with response.content[0].text access", "WorkItemSignals type not exported from model-router.ts"]
NEXT STEPS: [what remains]
```

## Key Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `routedAnthropicCall` returns a different shape than Anthropic SDK | Read model-router.ts return type carefully in Step 1; adapt response consumption in Step 2d |
| `WorkItemSignals` field names differ from what's described here | Read the actual exported type from model-router.ts in Step 1 |
| Plan type fields don't match the helper template | Read the actual `Plan` / project types from lib/types.ts in Step 1 |
| Build breaks due to pre-existing failure on main | Stash changes, run build clean, determine baseline before debugging |
| Concurrent branch causes merge conflict on shared imports | This branch only touches lib/decomposer.ts — conflicts are unlikely, but check `git status` before committing |