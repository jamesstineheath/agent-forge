# Agent Forge -- Add spike types and SpikeRecommendation enum to shared types

## Metadata
- **Branch:** `feat/add-spike-types-to-shared-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams. The `lib/types.ts` file contains all shared TypeScript types used across the control plane, including `WorkItem`, `Project`, and `ProjectStatus`.

This task adds foundational spike-related type definitions that will be consumed by subsequent work items implementing spike workflows. A "spike" is a time-boxed investigation work item used to de-risk technical unknowns before committing to full implementation.

**Current WorkItem type** (in `lib/types.ts`) is a central type used throughout the codebase. We are adding two optional fields to it without breaking existing usage.

**Current ProjectStatus** is a string union used to track project lifecycle states. We are extending it to include `'Not Feasible'` as a terminal state for projects that fail spike investigations.

**No file overlap with concurrent work.** The concurrent branch `fix/add-waveprogress-dashboard-component` modifies `components/wave-progress.tsx`, `app/projects/[id]/page.tsx`, `lib/hooks.ts`, and `app/api/work-items/route.ts` — none of which are touched here.

## Requirements

1. `SpikeMetadata` type is exported from `lib/types.ts` with fields:
   - `parentPrdId: string`
   - `technicalQuestion: string`
   - `scope: string`
   - `recommendedBy: 'pm-agent' | 'manual'`
2. `SpikeRecommendation` type is exported from `lib/types.ts` as a union: `'GO' | 'GO_WITH_CHANGES' | 'NO_GO'`
3. `WorkItem` type has optional `type?: 'spike'` field added
4. `WorkItem` type has optional `spikeMetadata?: SpikeMetadata` field added
5. `ProjectStatus` type/union includes `'Not Feasible'` as a valid value
6. TypeScript compiles without errors (`npx tsc --noEmit`)
7. No existing usages of `WorkItem` or `ProjectStatus` are broken (all new fields are optional)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-spike-types-to-shared-types
```

### Step 1: Inspect current lib/types.ts

Read the file to understand the exact current shape of `WorkItem` and `ProjectStatus`:

```bash
cat lib/types.ts
```

Note the exact location and current fields of:
- The `WorkItem` type/interface
- The `ProjectStatus` type (likely a string union)
- Any existing export patterns

### Step 2: Add spike types to lib/types.ts

Make the following targeted additions to `lib/types.ts`:

**2a. Add `SpikeMetadata` type** — add near the top of the file, or grouped with other metadata types if any exist:

```typescript
export type SpikeMetadata = {
  parentPrdId: string;
  technicalQuestion: string;
  scope: string;
  recommendedBy: 'pm-agent' | 'manual';
};
```

**2b. Add `SpikeRecommendation` type** — add immediately after `SpikeMetadata`:

```typescript
export type SpikeRecommendation = 'GO' | 'GO_WITH_CHANGES' | 'NO_GO';
```

**2c. Extend `WorkItem`** — add two optional fields to the `WorkItem` type/interface. These must be optional to preserve backward compatibility:

```typescript
// Inside WorkItem type/interface, add:
type?: 'spike';
spikeMetadata?: SpikeMetadata;
```

> **Note:** `type` is a common reserved-ish word. If the existing `WorkItem` already has a `type` field, inspect its current definition first and extend the union (e.g., `type?: 'feature' | 'fix' | 'spike'`) rather than replacing it. Do not remove any existing values.

**2d. Extend `ProjectStatus`** — locate the `ProjectStatus` type and add `'Not Feasible'` to its union:

```typescript
// Before (example):
export type ProjectStatus = 'Active' | 'Complete' | 'Failed' | 'Archived';

// After:
export type ProjectStatus = 'Active' | 'Complete' | 'Failed' | 'Archived' | 'Not Feasible';
```

> Add `'Not Feasible'` to whatever the current union contains — do not remove existing values.

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

If there are errors:
- If `type` field conflicts with an existing field on `WorkItem`, extend the union rather than replacing it
- If `ProjectStatus` is used in exhaustive switch statements elsewhere, those are now non-exhaustive — add a `case 'Not Feasible':` branch or a default case to fix them
- Do not modify files owned by the concurrent branch (`components/wave-progress.tsx`, `app/projects/[id]/page.tsx`, `lib/hooks.ts`, `app/api/work-items/route.ts`)

### Step 4: Verify build

```bash
npm run build
```

Resolve any build errors in `lib/types.ts` only. If errors appear in other files due to the `ProjectStatus` extension (e.g., exhaustive switch statements), add a `'Not Feasible'` case or default handler in those files. Avoid touching the concurrent-branch files.

### Step 5: Verification

Confirm all acceptance criteria:

```bash
# 1. Confirm SpikeMetadata is exported
grep -n "export type SpikeMetadata" lib/types.ts

# 2. Confirm SpikeRecommendation is exported
grep -n "export type SpikeRecommendation" lib/types.ts

# 3. Confirm WorkItem has optional type and spikeMetadata fields
grep -n "type?:" lib/types.ts
grep -n "spikeMetadata?" lib/types.ts

# 4. Confirm ProjectStatus includes 'Not Feasible'
grep -n "Not Feasible" lib/types.ts

# 5. TypeScript clean
npx tsc --noEmit && echo "TypeScript OK"
```

All five checks should pass.

### Step 6: Commit, push, open PR

```bash
git add lib/types.ts
# Also add any other files if exhaustive-switch fixes were needed
git add -A
git commit -m "feat: add spike types and SpikeRecommendation to shared types

- Add SpikeMetadata type with parentPrdId, technicalQuestion, scope, recommendedBy
- Add SpikeRecommendation union type ('GO' | 'GO_WITH_CHANGES' | 'NO_GO')
- Extend WorkItem with optional type?: 'spike' and spikeMetadata?: SpikeMetadata
- Extend ProjectStatus to include 'Not Feasible' terminal status"

git push origin feat/add-spike-types-to-shared-types

gh pr create \
  --title "feat: add spike types and SpikeRecommendation enum to shared types" \
  --body "## Summary

Adds foundational spike-related type definitions to \`lib/types.ts\` required by subsequent spike workflow work items.

## Changes

- **\`SpikeMetadata\`** type: \`parentPrdId\`, \`technicalQuestion\`, \`scope\`, \`recommendedBy\`
- **\`SpikeRecommendation\`** type: \`'GO' | 'GO_WITH_CHANGES' | 'NO_GO'\`
- **\`WorkItem\`**: extended with optional \`type?: 'spike'\` and \`spikeMetadata?: SpikeMetadata\`
- **\`ProjectStatus\`**: extended with \`'Not Feasible'\` terminal status

## Risk

Low — all new fields are optional, no existing usages broken.

## Acceptance Criteria
- [x] SpikeMetadata exported from lib/types.ts
- [x] SpikeRecommendation exported from lib/types.ts
- [x] WorkItem has optional type and spikeMetadata fields
- [x] ProjectStatus includes 'Not Feasible'
- [x] TypeScript compiles without errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-spike-types-to-shared-types
FILES CHANGED: lib/types.ts (and any exhaustive-switch fix files)
SUMMARY: [what was done]
ISSUES: [what failed — e.g., WorkItem already has a type field with conflicting union, ProjectStatus exhaustive switches in N files]
NEXT STEPS: [what remains — e.g., extend existing type union, add Not Feasible cases to switch statements in lib/projects.ts]
```