# Agent Forge -- Add Priority and Rank types to WorkItem

## Metadata
- **Branch:** `feat/work-item-priority-rank-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

The Agent Forge control plane stores work items in Vercel Blob (`af-data/work-items/*`). The `WorkItem` interface is defined in `lib/types.ts` and is used throughout the codebase for CRUD operations, dispatch logic, and dashboard rendering.

This task adds two optional fields to `WorkItem`:
- `priority?: Priority` — a P0/P1/P2 triage label
- `rank?: number` — a numeric ordering value for backlog prioritization

Both fields are **optional** to maintain full backward compatibility with existing serialized work items that lack these fields. No migration is needed.

This is a foundational type change that downstream work items (e.g., PM agent enhancements, dashboard sorting) will depend on.

**Concurrent work to avoid:** `feat/vercel-spend-monitor-library` touches `lib/vercel-spend-monitor.ts` only — no overlap with `lib/types.ts`.

## Requirements

1. `lib/types.ts` exports a `Priority` type alias defined as `'P0' | 'P1' | 'P2'`
2. The `WorkItem` interface includes an optional `priority?: Priority` field
3. The `WorkItem` interface includes an optional `rank?: number` field
4. All existing code that constructs `WorkItem` objects without `priority` or `rank` continues to compile without errors (fields are optional)
5. `npx tsc --noEmit` passes with zero errors after the change

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/work-item-priority-rank-types
```

### Step 1: Locate the WorkItem interface in lib/types.ts

Open `lib/types.ts` and find:
- The `WorkItem` interface (or type)
- Any existing priority-related types (there should be none yet)

Familiarize yourself with the existing fields so you know where to insert the new ones cleanly.

### Step 2: Add the Priority type alias and new WorkItem fields

In `lib/types.ts`, make the following changes:

**Add the `Priority` type export.** Place it near the top of the file, grouped with other type aliases (before or near the `WorkItem` interface):

```typescript
export type Priority = 'P0' | 'P1' | 'P2';
```

**Add the optional fields to the `WorkItem` interface.** Insert them in a logical location within the interface — after existing metadata fields like `status`, `priority` (if any exist), or before the timestamps. A suggested placement:

```typescript
export interface WorkItem {
  // ... existing fields ...
  priority?: Priority;
  rank?: number;
  // ... remaining existing fields ...
}
```

Do **not** remove, rename, or reorder any existing fields. Only add the two new optional fields and the `Priority` type export.

### Step 3: Verify no import changes are needed

Search for files that import from `lib/types.ts` to confirm nothing breaks:

```bash
grep -r "from.*lib/types" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v ".next"
```

Since `Priority` is a new export and `priority`/`rank` are optional fields on `WorkItem`, no import updates should be required. If any file explicitly types a `WorkItem` literal with all required fields, TypeScript will still compile because the new fields are optional.

### Step 4: Verification

```bash
# TypeScript type check — must pass with zero errors
npx tsc --noEmit

# Build check
npm run build
```

If `npm run build` fails for unrelated reasons (e.g., pre-existing issues), note it in the PR but do not attempt to fix unrelated failures. The primary acceptance criterion is `npx tsc --noEmit` passing.

### Step 5: Commit, push, open PR

```bash
git add lib/types.ts
git commit -m "feat: add Priority type and priority/rank fields to WorkItem"
git push origin feat/work-item-priority-rank-types
gh pr create \
  --title "feat: add Priority type and priority/rank fields to WorkItem" \
  --body "## Summary

Adds foundational type changes to \`lib/types.ts\` to support work item prioritization:

- Exports \`Priority = 'P0' | 'P1' | 'P2'\` type alias
- Adds optional \`priority?: Priority\` field to \`WorkItem\` interface
- Adds optional \`rank?: number\` field to \`WorkItem\` interface

Both fields are optional to maintain backward compatibility with existing serialized work items.

## Changes
- \`lib/types.ts\`: Added \`Priority\` export, \`priority\` and \`rank\` fields to \`WorkItem\`

## Verification
- \`npx tsc --noEmit\` passes with zero errors
- No existing \`WorkItem\` construction sites require changes (fields are optional)

## Notes
- This is the foundational type change that downstream prioritization features depend on
- No migration needed for existing Blob-stored work items (JSON deserialization handles missing optional fields gracefully)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/work-item-priority-rank-types
FILES CHANGED: [lib/types.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter a blocker you cannot resolve autonomously (e.g., `lib/types.ts` has an unexpected structure that makes the changes ambiguous, or TypeScript errors in unrelated files that block compilation), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-priority-rank-types-to-workitem",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts"]
    }
  }'
```