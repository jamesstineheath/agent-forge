# Agent Forge -- Add configurable decomposer limits and sub-phase types

## Metadata
- **Branch:** `feat/decomposer-limits-and-subtypes`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/decomposer.ts

## Context

Agent Forge is a dev orchestration platform built with Next.js. The decomposer (`lib/decomposer.ts`) converts Notion project plans into ordered work items. This task is purely additive — it adds new TypeScript interfaces and a configuration helper function to support a future sub-phase decomposition feature, without changing any existing logic.

The existing `lib/types.ts` already exports `WorkItem`, `Project`, and other shared types. The existing `lib/decomposer.ts` exports a `decompose` function and related logic. Neither file should have any existing behavior changed.

## Requirements

1. `lib/types.ts` exports a `SubPhase` interface with fields: `id: string`, `parentProjectId: string`, `name: string`, `items: WorkItem[]`, `dependencies: string[]`, and optional `budget?: number`
2. `lib/types.ts` exports a `DecomposerConfig` interface with fields: `softLimit: number`, `hardLimit: number`, `maxRecursionDepth: number`
3. `lib/types.ts` exports a `PhaseBreakdown` type with shape: `{ phases: { id: string, name: string, itemCount: number, items: { title: string, priority: string }[] }[], crossPhaseDeps: { from: string, to: string }[] }`
4. `lib/decomposer.ts` exports a `getDecomposerConfig()` function returning a `DecomposerConfig` object
5. `getDecomposerConfig()` reads `DECOMPOSER_SOFT_LIMIT` env var (default 15), `DECOMPOSER_HARD_LIMIT` env var (default 30), `DECOMPOSER_MAX_RECURSION_DEPTH` env var (default 1) using `parseInt()` with NaN fallback to defaults
6. All existing exports and behavior in both files remain completely unchanged
7. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decomposer-limits-and-subtypes
```

### Step 1: Add new types to `lib/types.ts`

Open `lib/types.ts` and append the following exports at the end of the file (after all existing exports). Do NOT modify any existing content:

```typescript
// --- Sub-phase decomposition types ---

export interface SubPhase {
  id: string;
  parentProjectId: string;
  name: string;
  items: WorkItem[];
  dependencies: string[]; // cross-phase dependency IDs
  budget?: number; // optional proportional budget allocation
}

export interface DecomposerConfig {
  softLimit: number;
  hardLimit: number;
  maxRecursionDepth: number;
}

export type PhaseBreakdown = {
  phases: {
    id: string;
    name: string;
    itemCount: number;
    items: {
      title: string;
      priority: string;
    }[];
  }[];
  crossPhaseDeps: {
    from: string;
    to: string;
  }[];
};
```

### Step 2: Add `getDecomposerConfig()` to `lib/decomposer.ts`

Open `lib/decomposer.ts`. At the top of the file (after existing imports), add an import for `DecomposerConfig` from `./types` if it's not already imported. Then append the following exported function at the end of the file. Do NOT modify any existing content:

First, check the existing imports in `lib/decomposer.ts`. If there is already an import from `'./types'` or `'@/lib/types'`, add `DecomposerConfig` to that import. Otherwise add a new import line.

Append at the end of `lib/decomposer.ts`:

```typescript
// --- Configurable decomposer limits ---

export function getDecomposerConfig(): DecomposerConfig {
  const softLimit = parseInt(process.env.DECOMPOSER_SOFT_LIMIT ?? '', 10);
  const hardLimit = parseInt(process.env.DECOMPOSER_HARD_LIMIT ?? '', 10);
  const maxRecursionDepth = parseInt(process.env.DECOMPOSER_MAX_RECURSION_DEPTH ?? '', 10);

  return {
    softLimit: isNaN(softLimit) ? 15 : softLimit,
    hardLimit: isNaN(hardLimit) ? 30 : hardLimit,
    maxRecursionDepth: isNaN(maxRecursionDepth) ? 1 : maxRecursionDepth,
  };
}
```

> **Note on import:** `DecomposerConfig` must be imported. Inspect the existing import block at the top of `lib/decomposer.ts`. If it imports from `'./types'`, extend that line. If it imports from `'../lib/types'` or uses a path alias like `'@/lib/types'`, match that pattern. If `lib/types.ts` is not currently imported at all, add:
> ```typescript
> import type { DecomposerConfig } from './types';
> ```

### Step 3: Verification

```bash
npx tsc --noEmit
```

Confirm there are zero TypeScript errors. If there are import path errors for `DecomposerConfig`, fix the import path in `lib/decomposer.ts` to match the project's convention (check other imports in the file).

Also do a quick sanity check that existing exports are untouched:
```bash
grep -n "export" lib/types.ts | head -30
grep -n "export" lib/decomposer.ts | head -20
```

If the project has a build step:
```bash
npm run build 2>&1 | tail -20
```

### Step 4: Commit, push, open PR

```bash
git add lib/types.ts lib/decomposer.ts
git commit -m "feat: add SubPhase, DecomposerConfig, PhaseBreakdown types and getDecomposerConfig()"
git push origin feat/decomposer-limits-and-subtypes
gh pr create \
  --title "feat: add configurable decomposer limits and sub-phase types" \
  --body "## Summary

Purely additive changes to support future sub-phase decomposition.

### Changes

**\`lib/types.ts\`**
- Added \`SubPhase\` interface (\`id\`, \`parentProjectId\`, \`name\`, \`items\`, \`dependencies\`, optional \`budget\`)
- Added \`DecomposerConfig\` interface (\`softLimit\`, \`hardLimit\`, \`maxRecursionDepth\`)
- Added \`PhaseBreakdown\` type for email summaries with \`phases\` and \`crossPhaseDeps\`

**\`lib/decomposer.ts\`**
- Added exported \`getDecomposerConfig()\` that reads \`DECOMPOSER_SOFT_LIMIT\` (default 15), \`DECOMPOSER_HARD_LIMIT\` (default 30), \`DECOMPOSER_MAX_RECURSION_DEPTH\` (default 1) from environment variables using \`parseInt()\` with NaN fallback

### No existing behavior changed

All existing exports and logic in both files are completely untouched.

### Acceptance Criteria
- [x] \`SubPhase\`, \`DecomposerConfig\`, \`PhaseBreakdown\` exported from \`lib/types.ts\`
- [x] \`getDecomposerConfig()\` exported from \`lib/decomposer.ts\` with correct defaults
- [x] Env var overrides work via \`parseInt()\` with NaN fallback
- [x] TypeScript compiles without errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decomposer-limits-and-subtypes
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If hitting a blocker that cannot be resolved autonomously (e.g., the existing `lib/decomposer.ts` has an unusual module structure that makes appending the function unsafe):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-configurable-decomposer-limits-and-sub-phase-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/decomposer.ts"]
    }
  }'
```