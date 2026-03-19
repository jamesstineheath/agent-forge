# Agent Forge -- Propagate Priority and Rank from PRD During Decomposition

## Metadata
- **Branch:** `feat/propagate-priority-rank-decomposition`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/decomposer.ts, lib/pm-prompts.ts

## Context

Agent Forge recently added `priority` and `rank` fields to the `WorkItem` type (see merged PR: "feat: add Priority type and priority/rank fields to WorkItem"). These fields exist on `WorkItem` in `lib/types.ts` but are not yet propagated during decomposition.

When the Project Manager agent (or manual orchestration) decomposes a PRD/project into work items via `lib/decomposer.ts`, the generated work items don't inherit the parent project's `priority` or `rank`. This means all decomposed work items lose their urgency context, and the Dispatcher's new sort comparator (see merged PR: "feat: add dispatch sort comparator with default priority constants") can't correctly prioritize them.

The fix requires:
1. Reading `priority` and `rank` from the parent project in `lib/decomposer.ts` and setting them on each generated `WorkItem`
2. Updating `lib/pm-prompts.ts` prompt templates to include `priority` and `rank` in work item field descriptions so the PM agent's Claude calls know to populate them

## Requirements

1. In `lib/decomposer.ts`, when constructing `WorkItem` objects, read `priority` from the parent project (or default to `'P1'` if absent)
2. In `lib/decomposer.ts`, when constructing `WorkItem` objects, read `rank` from the parent project (or default to `999` if absent)
3. All work items generated from a project with priority `'P0'` must have `priority: 'P0'`
4. All work items generated from a project with no priority must have `priority: 'P1'`
5. All work items generated from a project with `rank: 5` must have `rank: 5`
6. All work items generated from a project with no rank must have `rank: 999`
7. In `lib/pm-prompts.ts`, any prompt templates describing work item fields must reference `priority` and `rank`
8. TypeScript compilation passes with zero errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/propagate-priority-rank-decomposition
```

### Step 1: Inspect existing types

Read the relevant type definitions to understand the exact shape of `WorkItem`, `Project`, and the `Priority` type:

```bash
cat lib/types.ts
```

Look for:
- The `Priority` type (likely `'P0' | 'P1' | 'P2' | 'P3'` or similar)
- The `WorkItem` interface — confirm `priority` and `rank` field names and types
- The `Project` interface — confirm whether it has `priority` and `rank` fields

Also inspect the current decomposer and PM prompts:

```bash
cat lib/decomposer.ts
cat lib/pm-prompts.ts
```

### Step 2: Update `lib/decomposer.ts`

Locate where `WorkItem` objects are constructed during decomposition. This will be in a function that takes a project/plan and returns an array of `WorkItem` objects.

**Pattern to find:** Look for object literals that spread or assign `WorkItem` fields — likely something like:
```typescript
const workItem: WorkItem = {
  id: ...,
  title: ...,
  description: ...,
  status: 'ready',
  // ...
};
```

**Change to apply:** Add `priority` and `rank` fields sourced from the parent project, with appropriate defaults:

```typescript
// Assuming the parent project is available as `project` in scope
const workItem: WorkItem = {
  id: ...,
  title: ...,
  description: ...,
  status: 'ready',
  priority: project.priority ?? 'P1',
  rank: project.rank ?? 999,
  // ... other fields
};
```

If the decomposer function signature takes individual fields rather than a `Project` object, update the function signature to accept `priority` and `rank` parameters with defaults, and thread them through from the call sites.

**Important:** If `priority` or `rank` don't exist on the `Project` type in `lib/types.ts`, do NOT add them there — instead check if the project object is typed as `any` or a partial type at the call site, and use optional chaining (`project?.priority`). If the `Project` type genuinely lacks these fields, add them as optional fields (`priority?: Priority; rank?: number;`) to `Project` in `lib/types.ts`.

Apply the changes carefully — there may be multiple places where `WorkItem` objects are constructed (e.g., in a loop over decomposed plan items). Update all of them.

### Step 3: Update `lib/pm-prompts.ts`

Find all prompt template strings that enumerate or describe `WorkItem` fields. These will be used to instruct Claude (the PM agent) on what fields to include in decomposition output.

**Pattern to find:** Look for prompt sections like:
```typescript
`Each work item should have:
- title: ...
- description: ...
- estimatedFiles: ...`
```

Or JSON schema descriptions like:
```typescript
`{
  "title": "string",
  "description": "string",
  ...
}`
```

**Change to apply:** Add `priority` and `rank` to these descriptions. For example:

```typescript
`Each work item should have:
- title: short imperative title
- description: detailed description of the work
- priority: one of P0, P1, P2, P3 (inherit from project, default P1)
- rank: integer sort order (inherit from project, default 999)
- estimatedFiles: list of files likely to be changed`
```

If there is a JSON schema or structured output format described in the prompt, add:
```
"priority": "P0|P1|P2|P3 - inherited from parent project",
"rank": "integer - inherited from parent project, default 999"
```

Update all relevant prompt templates. There may be multiple (e.g., one for decomposition, one for work item review).

### Step 4: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are type errors:
- If `Priority` type isn't imported in `lib/decomposer.ts`, add the import: `import type { Priority } from './types';` (adjust path as needed)
- If `rank` expects `number` but could be `undefined`, use `?? 999` (nullish coalescing)
- If `priority` expects the `Priority` union type but project has it typed as `string`, cast with `as Priority` only if the value is validated, otherwise use the default

Fix all type errors before proceeding.

### Step 5: Build verification

```bash
npm run build
```

Resolve any build errors. Common issues:
- Missing imports
- Type mismatches between `Priority` union and string literals

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Both must succeed with zero errors.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: propagate priority and rank from project during decomposition"
git push origin feat/propagate-priority-rank-decomposition
gh pr create \
  --title "feat: propagate priority and rank from PRD during decomposition" \
  --body "## Summary

Propagates \`priority\` and \`rank\` from the parent project to all work items generated during decomposition.

## Changes

### \`lib/decomposer.ts\`
- When constructing \`WorkItem\` objects, reads \`priority\` from the parent project (defaults to \`'P1'\` if absent)
- When constructing \`WorkItem\` objects, reads \`rank\` from the parent project (defaults to \`999\` if absent)

### \`lib/pm-prompts.ts\`
- Updated prompt templates to include \`priority\` and \`rank\` in work item field descriptions
- Ensures the PM agent's Claude calls know to populate these fields in decomposition output

## Acceptance Criteria
- [x] Work items from a P0 project have \`priority: 'P0'\`
- [x] Work items from a project with no priority default to \`priority: 'P1'\`
- [x] Work items from a project with rank 5 have \`rank: 5\`
- [x] Work items from a project with no rank default to \`rank: 999\`
- [x] PM prompts reference priority and rank fields
- [x] TypeScript compilation passes with zero errors

## Related
- Builds on: feat: add Priority type and priority/rank fields to WorkItem
- Enables: feat: add dispatch sort comparator with default priority constants (to sort correctly)
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/propagate-priority-rank-decomposition
FILES CHANGED: [list files actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or is unresolved]
NEXT STEPS: [what remains — e.g., "pm-prompts.ts not yet updated", "type error on line 87 of decomposer.ts"]
```

## Escalation

If you encounter blockers you cannot resolve autonomously (e.g., the `Project` type doesn't have `priority`/`rank` and it's unclear whether to add them, or `WorkItem` construction is generated dynamically in a way that's hard to instrument):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "propagate-priority-rank-decomposition",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/decomposer.ts", "lib/pm-prompts.ts"]
    }
  }'
```