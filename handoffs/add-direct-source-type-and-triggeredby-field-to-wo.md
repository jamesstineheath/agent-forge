# Agent Forge -- Add 'direct' source type and 'triggeredBy' field to work item types

## Metadata
- **Branch:** `feat/direct-source-type-and-triggered-by`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

Agent Forge is a dev orchestration platform. Work items are the core data structure tracked in `lib/types.ts`. Currently, work items can originate from two sources: `'project'` (from Notion project decomposition) and `'manual'` (user-created via dashboard).

A new "fast-lane" feature is being built that allows work items to be triggered directly (e.g., from a PA bridge call) without going through the full project/manual flow. This requires:

1. A `'direct'` source type so work items can be attributed to direct API calls
2. A `triggeredBy` field to capture who/what triggered the item
3. A `complexityHint` field to guide budget allocation for fast-lane items
4. An `'escalated'` status to represent items that have been escalated and are awaiting human resolution
5. Exported constants for default budgets by complexity

This is a pure type/constants change in a single file — no logic changes, no API changes. All existing code using the current types will continue to compile because all new fields are optional or additive.

## Requirements

1. The `source` field type union in `lib/types.ts` must include `'direct'` alongside the existing `'project'` and `'manual'` values
2. `WorkItemStatus` type must include `'escalated'` as a valid status value
3. `WorkItem` interface must include `triggeredBy?: string` as an optional field
4. `WorkItem` interface must include `complexityHint?: 'simple' | 'moderate'` as an optional field
5. A `ComplexityHint` type alias (`'simple' | 'moderate'`) must be exported from `lib/types.ts`
6. Constants `FAST_LANE_BUDGET_SIMPLE = 2` and `FAST_LANE_BUDGET_MODERATE = 4` must be exported from `lib/types.ts`
7. The TypeScript build must pass with no new errors (`npx tsc --noEmit`)
8. No existing types, fields, or exported values may be removed or renamed

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/direct-source-type-and-triggered-by
```

### Step 1: Inspect current lib/types.ts

Read the full file to understand the existing structure before making changes:

```bash
cat lib/types.ts
```

Identify:
- Where the `source` field type is defined (may be inline in `WorkItem` or as a separate type alias)
- Where `WorkItemStatus` is defined
- The full `WorkItem` interface definition
- Any existing exports at the bottom of the file

### Step 2: Apply type changes to lib/types.ts

Make the following targeted edits to `lib/types.ts`:

**2a. Add `ComplexityHint` type alias** — add near the top of the file, after any existing simple type aliases:
```typescript
export type ComplexityHint = 'simple' | 'moderate';
```

**2b. Update the `source` type** — find where `source` is typed (either inline in `WorkItem` or as a standalone type). Change:
```typescript
// Before (example — actual may differ slightly):
source: 'project' | 'manual'
// After:
source: 'project' | 'manual' | 'direct'
```
If `source` is defined as a standalone exported type, update that type. If it's inline in the `WorkItem` interface, update it there.

**2c. Update `WorkItemStatus`** — find the `WorkItemStatus` type and add `'escalated'`:
```typescript
// Before (example):
export type WorkItemStatus = 'filed' | 'ready' | 'queued' | 'generating' | 'executing' | 'reviewing' | 'merged' | 'blocked' | 'parked';
// After:
export type WorkItemStatus = 'filed' | 'ready' | 'queued' | 'generating' | 'executing' | 'reviewing' | 'merged' | 'blocked' | 'parked' | 'escalated';
```
Preserve all existing status values exactly.

**2d. Add new optional fields to `WorkItem` interface**:
```typescript
// Add inside the WorkItem interface:
triggeredBy?: string;
complexityHint?: ComplexityHint;
```
Place these after any existing optional fields (e.g., after `dependencies`, `metadata`, or similar trailing optional fields).

**2e. Add budget constants** — add near the bottom of the file (before or after existing exports, not inside any interface/type):
```typescript
export const FAST_LANE_BUDGET_SIMPLE = 2;
export const FAST_LANE_BUDGET_MODERATE = 4;
```

### Step 3: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

If there are errors, read them carefully. Since all changes are additive (new optional fields, expanded unions, new exports), there should be no errors. If a file imports `WorkItemStatus` and uses an exhaustive switch, TypeScript may warn — resolve by adding a `'escalated'` case or a default fallback in the affected file.

### Step 4: Run build to confirm no issues

```bash
npm run build
```

If build fails due to exhaustive type checks on `WorkItemStatus` in other files, add `'escalated'` handling (or a default/fallback) in those files as needed. Do not remove the `'escalated'` status.

### Step 5: Verification — confirm all acceptance criteria

```bash
# Verify 'direct' is in source type
grep -n "direct" lib/types.ts

# Verify 'escalated' is in WorkItemStatus
grep -n "escalated" lib/types.ts

# Verify triggeredBy field
grep -n "triggeredBy" lib/types.ts

# Verify complexityHint field
grep -n "complexityHint" lib/types.ts

# Verify ComplexityHint type export
grep -n "ComplexityHint" lib/types.ts

# Verify budget constants
grep -n "FAST_LANE_BUDGET" lib/types.ts
```

All six greps should return matches. Review the output to confirm correct syntax.

### Step 6: Commit, push, open PR

```bash
git add lib/types.ts
# Include any other files touched to resolve TS errors
git add -A
git commit -m "feat: add 'direct' source type, 'escalated' status, triggeredBy, complexityHint, and budget constants to WorkItem types"
git push origin feat/direct-source-type-and-triggered-by
gh pr create \
  --title "feat: add 'direct' source type and 'triggeredBy' field to work item types" \
  --body "## Summary

Foundational type changes to \`lib/types.ts\` supporting the fast-lane work item feature.

## Changes

- Added \`'direct'\` to the \`source\` type union (\`'project' | 'manual' | 'direct'\`)
- Added \`'escalated'\` to \`WorkItemStatus\`
- Added \`triggeredBy?: string\` optional field to \`WorkItem\` interface
- Added \`complexityHint?: ComplexityHint\` optional field to \`WorkItem\` interface
- Exported new \`ComplexityHint\` type alias (\`'simple' | 'moderate'\`)
- Exported \`FAST_LANE_BUDGET_SIMPLE = 2\` and \`FAST_LANE_BUDGET_MODERATE = 4\` constants

## Acceptance Criteria

- [x] \`source\` union includes \`'direct'\`
- [x] \`WorkItemStatus\` includes \`'escalated'\`
- [x] \`WorkItem\` has \`triggeredBy?: string\`
- [x] \`WorkItem\` has \`complexityHint?: ComplexityHint\`
- [x] \`ComplexityHint\` type exported
- [x] Budget constants exported
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes

## Risk

Low — all changes are additive. No existing fields removed or renamed. All new \`WorkItem\` fields are optional."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/direct-source-type-and-triggered-by
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter an unresolvable blocker (e.g., `lib/types.ts` has unexpected structure that makes safe edits ambiguous, or there are cascading TypeScript errors across many files that require architectural decisions):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "direct-source-type-and-triggered-by",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```