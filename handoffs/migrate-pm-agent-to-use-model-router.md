# Agent Forge -- Migrate PM Agent to Use Model Router

## Metadata
- **Branch:** `feat/migrate-pm-agent-to-model-router`
- **Priority:** high
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** lib/pm-agent.ts

## Context

The project uses a centralized model router (`lib/model-router.ts`) that handles Anthropic API calls with telemetry emission, routing logic, and consistent configuration. Recent work has migrated the decomposer (`lib/decomposer.ts`) to use this router pattern (see merged PR: "refactor: migrate decomposer to use model router").

The PM agent (`lib/pm-agent.ts`) currently makes direct Anthropic SDK calls for three operations:
1. **Backlog review** — Claude-powered backlog analysis
2. **Health assessment** — Project health evaluation
3. **Decomposition** — Plan decomposition into work items

This task replaces all direct Anthropic SDK calls in `lib/pm-agent.ts` with calls through `routedAnthropicCall` from `lib/model-router.ts`, passing the appropriate `taskType` and `WorkItemSignals` context for each call site.

**Concurrent work notice:** The work item "Migrate orchestrator to use model router" is running concurrently on branch `feat/migrate-orchestrator-to-use-model-router` modifying `lib/orchestrator.ts`. There is **no file overlap** — this task only touches `lib/pm-agent.ts`. No coordination required, but rebase from `main` before starting to ensure you have the latest `lib/model-router.ts`.

### Model Router Pattern (from lib/model-router.ts)

Based on the decomposer migration pattern, the router exposes:

```typescript
import { routedAnthropicCall } from './model-router';

// WorkItemSignals type (likely defined in model-router.ts or types.ts)
type WorkItemSignals = {
  taskType: string;
  priority?: string;
  complexity?: string;
  // ... other signal fields
};

const response = await routedAnthropicCall({
  taskType: 'decomposition', // or 'backlog_review', 'health_assessment'
  signals: workItemSignals,
  messages: [...],
  system: '...',
  max_tokens: 4096,
});
```

## Requirements

1. `lib/pm-agent.ts` must no longer import `Anthropic` directly from `@anthropic-ai/sdk` for completions — if Anthropic types are still needed for type annotations, document why.
2. All Anthropic API completion calls in `lib/pm-agent.ts` must be replaced with `routedAnthropicCall`.
3. Each call site must pass the correct `taskType`:
   - Backlog review → `'backlog_review'`
   - Health assessment → `'health_assessment'`
   - Decomposition → `'decomposition'`
4. `WorkItemSignals` must be extracted from the relevant context at each call site (priority, complexity, repo, etc.) and passed to `routedAnthropicCall`.
5. The response handling after each call must remain functionally identical to the pre-migration behavior.
6. `npm run build` passes with no TypeScript errors.
7. No changes to `lib/orchestrator.ts`, `lib/model-router.ts`, or any file outside `lib/pm-agent.ts`.

## Execution Steps

### Step 0: Branch setup

```bash
git checkout main && git pull
git checkout -b feat/migrate-pm-agent-to-model-router
```

### Step 1: Read and understand the current model router API

Before touching `lib/pm-agent.ts`, read the router to understand the exact function signature:

```bash
cat lib/model-router.ts
```

Key things to confirm:
- The exact name of the exported function (likely `routedAnthropicCall`)
- The shape of the options object (fields: `taskType`, `signals`, `messages`, `system`, `max_tokens`, etc.)
- The `WorkItemSignals` type definition and its required vs optional fields
- What the function returns (likely the raw Anthropic response or `.content[0].text`)

Also read the decomposer migration for a concrete usage example:
```bash
cat lib/decomposer.ts
```

### Step 2: Audit all Anthropic SDK call sites in lib/pm-agent.ts

```bash
cat lib/pm-agent.ts
```

Map each call site:
- Note the line numbers where `anthropic.messages.create(...)` (or equivalent) is called
- Note the `system` prompt, `messages` array, and `max_tokens` for each
- Note what context variables are available at each call site that can populate `WorkItemSignals`

You should find approximately 3 call sites corresponding to:
1. Backlog review function
2. Health assessment function
3. Decomposition function

Document this mapping before proceeding.

### Step 3: Replace Anthropic SDK calls with routedAnthropicCall

For each call site identified in Step 2, apply this transformation pattern:

**Before (example pattern):**
```typescript
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();

// Inside a function...
const response = await anthropic.messages.create({
  model: 'claude-opus-4-5',
  max_tokens: 4096,
  system: systemPrompt,
  messages: [{ role: 'user', content: userContent }],
});
const text = response.content[0].type === 'text' ? response.content[0].text : '';
```

**After (example pattern):**
```typescript
import { routedAnthropicCall } from './model-router';

// Extract signals from available context
const signals: WorkItemSignals = {
  taskType: 'backlog_review',  // adjust per call site
  // populate other fields from available context variables
  // e.g., priority, complexity, repoName if present
};

const response = await routedAnthropicCall({
  taskType: 'backlog_review',  // adjust per call site
  signals,
  messages: [{ role: 'user', content: userContent }],
  system: systemPrompt,
  max_tokens: 4096,
});
// Preserve the exact same response extraction logic as before
```

**Specific taskType mapping:**
- Function(s) performing backlog analysis → `taskType: 'backlog_review'`
- Function(s) performing health evaluation → `taskType: 'health_assessment'`
- Function(s) performing plan decomposition → `taskType: 'decomposition'`

**WorkItemSignals extraction guidance:**
- Look at what parameters each function receives (work items, projects, repo config, etc.)
- Extract `priority`, `complexity`, `repoName`, or other relevant fields into the signals object
- If a field isn't available in context, omit it rather than hardcoding a value
- Match the exact fields that `WorkItemSignals` type requires (check `lib/model-router.ts`)

### Step 4: Remove unused Anthropic SDK imports

After replacing all call sites, remove the direct Anthropic import and instantiation if no longer needed:

```typescript
// REMOVE these if no longer referenced:
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();
// or: const client = new Anthropic();
```

If the Anthropic SDK is still imported for **type annotations only** (e.g., `Anthropic.Messages.MessageParam`), you may keep the import but should prefer using equivalent types from `lib/model-router.ts` or `@anthropic-ai/sdk` type-only imports if the router re-exports them. Check `lib/model-router.ts` to see if it re-exports relevant types.

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `WorkItemSignals` type mismatch — check required fields in the type definition
- Return type of `routedAnthropicCall` differs from original — adjust response extraction accordingly
- Missing imports for `WorkItemSignals` type — import from `lib/model-router.ts` or wherever it's defined

### Step 6: Run build

```bash
npm run build
```

Ensure no build errors. This is the acceptance gate.

### Step 7: Sanity check the diff

```bash
git diff lib/pm-agent.ts
```

Verify:
- No `anthropic.messages.create` or `new Anthropic()` calls remain (unless for non-completion purposes)
- All `routedAnthropicCall` usages have the correct `taskType` per call site
- Response handling logic is identical to before the migration
- No unintended changes to prompt content, system messages, or `max_tokens` values

### Step 8: Verify no other files were modified

```bash
git diff --name-only
```

Only `lib/pm-agent.ts` should appear. If anything else changed, review and revert unintended edits.

### Step 9: Commit, push, open PR

```bash
git add lib/pm-agent.ts
git commit -m "refactor: migrate PM agent to use model router

Replace direct Anthropic SDK calls in lib/pm-agent.ts with
routedAnthropicCall from lib/model-router.ts.

- backlog review → taskType: 'backlog_review'
- health assessment → taskType: 'health_assessment'
- decomposition → taskType: 'decomposition'

WorkItemSignals extracted from context at each call site.
Direct Anthropic SDK import removed."

git push origin feat/migrate-pm-agent-to-model-router

gh pr create \
  --title "refactor: migrate PM agent to use model router" \
  --body "## Summary
Replaces all direct Anthropic SDK calls in \`lib/pm-agent.ts\` with \`routedAnthropicCall\` from \`lib/model-router.ts\`, consistent with the decomposer migration pattern.

## Changes
- \`lib/pm-agent.ts\`: Replaced \`anthropic.messages.create\` calls with \`routedAnthropicCall\` at all 3 call sites (backlog review, health assessment, decomposition)
- Removed direct \`Anthropic\` SDK import/instantiation
- \`WorkItemSignals\` extracted from available context at each call site

## Task Types
| Call Site | taskType |
|---|---|
| Backlog review | \`backlog_review\` |
| Health assessment | \`health_assessment\` |
| Decomposition | \`decomposition\` |

## Testing
- \`npx tsc --noEmit\` ✅
- \`npm run build\` ✅

## Notes
- No functional changes to prompts, system messages, or response handling
- Concurrent PR \`feat/migrate-orchestrator-to-use-model-router\` touches only \`lib/orchestrator.ts\` — no conflicts"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add lib/pm-agent.ts
git commit -m "refactor: partial PM agent model router migration (incomplete)"
git push origin feat/migrate-pm-agent-to-model-router
```

2. Open the PR with partial status:
```bash
gh pr create --title "refactor: migrate PM agent to use model router [PARTIAL]" --body "Partial implementation — see issues below."
```

3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/migrate-pm-agent-to-model-router
FILES CHANGED: lib/pm-agent.ts
SUMMARY: [what was completed — e.g., "replaced 2 of 3 call sites"]
ISSUES: [specific error or blocker, e.g., "WorkItemSignals type mismatch at health assessment call site — routedAnthropicCall returns X but pm-agent expects Y"]
NEXT STEPS: [e.g., "Resolve return type mismatch, replace remaining call site at line N, verify build"]
```

Then escalate:
```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "migrate-pm-agent-to-model-router",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker>",
      "filesChanged": ["lib/pm-agent.ts"]
    }
  }'
```