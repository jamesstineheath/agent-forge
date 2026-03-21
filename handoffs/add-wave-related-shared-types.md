# Agent Forge -- Add Wave-Related Shared Types

## Metadata
- **Branch:** `feat/add-wave-related-shared-types`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/atc/types.ts

## Context

This task adds pure TypeScript type definitions to support the wave-based dispatch system being built in Agent Forge. No runtime logic is involved — only interface declarations.

**Why these types are needed:**
- `WaveProgressData` lives in `lib/types.ts` (alongside other shared types like `WorkItem`, `Project`) and will be used by dashboard components and API routes to represent progress through a dispatch wave.
- `WaveDispatchState` lives in `lib/atc/types.ts` (alongside `CycleContext` and other agent-layer types) and will be used by the Dispatcher agent and Inngest functions to track wave dispatch state.

**Existing patterns in `lib/types.ts`:**
- Exports interfaces like `WorkItem`, `Project`, `Escalation`, etc. using named `export interface` or `export type`.
- Uses string literal union types for status fields (e.g., `WorkItem.status` is a union of string literals).

**Existing patterns in `lib/atc/types.ts`:**
- Exports interfaces like `CycleContext`, timeout constants, concurrency limits, and utility types used across the agent layer.

**Concurrent work to avoid:**
- Branch `fix/add-wavenumber-column-to-database-schema` modifies `lib/db/schema.ts` — no overlap with the files in this task.

## Requirements

1. `lib/types.ts` exports a `WaveProgressData` interface with exactly these fields:
   - `waveNumber: number`
   - `items: WorkItem[]`
   - `status: 'pending' | 'active' | 'complete'`
2. `lib/atc/types.ts` exports a `WaveDispatchState` interface with exactly these fields:
   - `projectId: string`
   - `currentWave: number`
   - `waveSize: number`
   - `dispatchedAt: string`
   - `globalConcurrencyBudget: number`
3. The project compiles with no type errors (`npx tsc --noEmit`).
4. Both interfaces are named exports (not default exports) and importable from their respective module paths.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-wave-related-shared-types
```

### Step 1: Add `WaveProgressData` to `lib/types.ts`

Open `lib/types.ts` and locate the `WorkItem` interface (it must already be defined there since `WaveProgressData` references it). Add the following export at the end of the file, after all existing exports:

```typescript
export interface WaveProgressData {
  waveNumber: number;
  items: WorkItem[];
  status: 'pending' | 'active' | 'complete';
}
```

> **Note:** Do not add any imports — `WorkItem` is already defined in the same file. Do not modify any existing types or interfaces.

### Step 2: Add `WaveDispatchState` to `lib/atc/types.ts`

Open `lib/atc/types.ts` and add the following export at the end of the file, after all existing exports:

```typescript
export interface WaveDispatchState {
  projectId: string;
  currentWave: number;
  waveSize: number;
  dispatchedAt: string;
  globalConcurrencyBudget: number;
}
```

> **Note:** No imports are needed — all fields are primitive types. Do not modify any existing types, constants, or interfaces in this file.

### Step 3: Verify compilation

```bash
npx tsc --noEmit
```

If there are errors, review the added interfaces to ensure:
- `WorkItem` is defined (or imported) in `lib/types.ts` before `WaveProgressData` uses it.
- No syntax errors in the added interface blocks.

Fix any issues, then re-run until it exits cleanly.

### Step 4: Verify exports are importable

Run a quick sanity check to confirm the exports resolve:

```bash
node -e "
const path = require('path');
// Verify the TS source files contain the expected export signatures
const fs = require('fs');
const types = fs.readFileSync('lib/types.ts', 'utf8');
const atcTypes = fs.readFileSync('lib/atc/types.ts', 'utf8');
if (!types.includes('export interface WaveProgressData')) throw new Error('WaveProgressData not found in lib/types.ts');
if (!atcTypes.includes('export interface WaveDispatchState')) throw new Error('WaveDispatchState not found in lib/atc/types.ts');
console.log('Both interfaces found and exported correctly.');
"
```

### Step 5: Build check

```bash
npm run build
```

The build must succeed. If there are unrelated pre-existing build errors, note them in the PR description but do not attempt to fix them — this task is scoped to type additions only.

### Step 6: Commit, push, open PR

```bash
git add lib/types.ts lib/atc/types.ts
git commit -m "feat: add WaveProgressData and WaveDispatchState interfaces for wave-based dispatch"
git push origin feat/add-wave-related-shared-types
gh pr create \
  --title "feat: add wave-related shared types" \
  --body "## Summary

Adds two TypeScript interfaces to support the wave-based dispatch system:

### \`WaveProgressData\` (lib/types.ts)
Used by dashboard components and API routes to represent progress through a dispatch wave.
\`\`\`ts
export interface WaveProgressData {
  waveNumber: number;
  items: WorkItem[];
  status: 'pending' | 'active' | 'complete';
}
\`\`\`

### \`WaveDispatchState\` (lib/atc/types.ts)
Used by the Dispatcher agent and Inngest functions to track wave dispatch state.
\`\`\`ts
export interface WaveDispatchState {
  projectId: string;
  currentWave: number;
  waveSize: number;
  dispatchedAt: string;
  globalConcurrencyBudget: number;
}
\`\`\`

## Changes
- \`lib/types.ts\`: Added \`WaveProgressData\` interface
- \`lib/atc/types.ts\`: Added \`WaveDispatchState\` interface

## Notes
- Pure type definitions, no runtime logic added
- No overlap with concurrent branch \`fix/add-wavenumber-column-to-database-schema\` (modifies \`lib/db/schema.ts\` only)
- Compiles cleanly with \`npx tsc --noEmit\`"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-wave-related-shared-types
FILES CHANGED: [lib/types.ts, lib/atc/types.ts — list only those actually modified]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter a blocker you cannot resolve autonomously (e.g., `WorkItem` is not defined in `lib/types.ts` and must be imported from elsewhere, or `lib/atc/types.ts` does not exist), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-wave-related-shared-types",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/atc/types.ts"]
    }
  }'
```