# Agent Forge -- Extend types with retry fields and project_retry event

## Metadata
- **Branch:** `feat/retry-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

This is a pure type-level change to `lib/types.ts` in the Agent Forge control plane. The goal is to add retry-related fields to the `Project` interface and extend the `ATCEvent` type union so that downstream work implementing project retry logic has the necessary TypeScript types available.

The `Project` interface and `ATCEvent` type union live in `lib/types.ts`, which is the shared types module used throughout the codebase. No runtime logic changes — only type definitions.

## Requirements

1. The `Project` interface in `lib/types.ts` must include an optional `retry` field of type `boolean`
2. The `Project` interface in `lib/types.ts` must include an optional `retryCount` field of type `number`
3. The `ATCEvent` type union (or its `type` discriminant) in `lib/types.ts` must include `"project_retry"` as a valid string literal
4. `npx tsc --noEmit` passes with zero errors
5. `npm run build` completes successfully
6. No other files are changed — this is a types-only diff

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/retry-types
```

### Step 1: Inspect current types

Read `lib/types.ts` to understand the existing `Project` interface shape and how `ATCEvent` is defined (it may be a discriminated union with a `type` field, or a plain string union).

```bash
cat lib/types.ts
```

### Step 2: Add retry fields to Project interface

Locate the `Project` interface in `lib/types.ts`. Add the two optional fields immediately after the existing fields (before the closing brace):

```typescript
// Inside the Project interface, add:
retry?: boolean;
retryCount?: number;
```

Example — if the interface currently looks like:
```typescript
export interface Project {
  id: string;
  name: string;
  status: string;
  // ... other fields
}
```

It should become:
```typescript
export interface Project {
  id: string;
  name: string;
  status: string;
  // ... other fields
  retry?: boolean;
  retryCount?: number;
}
```

### Step 3: Add "project_retry" to ATCEvent type union

Locate the `ATCEvent` type in `lib/types.ts`. The `type` field will be a string literal union. Add `"project_retry"` to it.

**If ATCEvent is a discriminated union of objects**, add a new member:
```typescript
| { type: "project_retry"; projectId: string; [key: string]: unknown }
```
or minimally:
```typescript
| { type: "project_retry" }
```

**If the `type` field is a simple string literal union** (e.g., `type: "work_item_filed" | "work_item_dispatched" | ...`), simply append `| "project_retry"` to the union.

Match the pattern already used by existing event types in the file — do not invent a new pattern.

### Step 4: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

Resolve any errors before proceeding. Since this is additive-only, there should be none.

### Step 5: Verify build succeeds

```bash
npm run build
```

Resolve any errors before proceeding.

### Step 6: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: extend Project interface with retry fields and add project_retry ATC event type"
git push origin feat/retry-types
gh pr create \
  --title "feat: extend types with retry fields and project_retry event" \
  --body "## Summary

Pure type-level change enabling downstream project retry logic.

## Changes
- \`lib/types.ts\`: Added \`retry?: boolean\` and \`retryCount?: number\` to the \`Project\` interface
- \`lib/types.ts\`: Added \`\"project_retry\"\` to the \`ATCEvent\` type union

## Acceptance Criteria
- [x] \`Project\` interface includes optional \`retry?: boolean\`
- [x] \`Project\` interface includes optional \`retryCount?: number\`
- [x] \`ATCEvent\` type union includes \`\"project_retry\"\`
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes

## Risk
Low — additive type-only change, no runtime logic modified."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/retry-types
FILES CHANGED: [lib/types.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If a blocker cannot be resolved autonomously (e.g., `ATCEvent` type structure is ambiguous or the build fails for non-obvious reasons after 3 attempts), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "extend-types-retry-fields-project-retry-event",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```