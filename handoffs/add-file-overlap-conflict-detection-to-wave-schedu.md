# Agent Forge -- Add file-overlap conflict detection to wave scheduler

## Metadata
- **Branch:** `feat/wave-scheduler-file-overlap-detection`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/wave-scheduler.ts, lib/atc/utils.ts, lib/wave-scheduler.test.ts

## Context

The wave scheduler (`lib/wave-scheduler.ts`) assigns work items to parallel execution waves based on a DAG topological sort. Currently it only respects dependency edges — two independent items with no DAG relationship can land in the same wave even if they modify the same files, causing execution conflicts.

This task adds a post-processing pass to the `assignWaves` function: after initial DAG-based wave assignment, scan each wave for file-overlap conflicts and bump conflicting items (the later one by `createdAt`) to the next wave, cascading any dependents.

The existing `lib/atc/utils.ts` has file-overlap detection utilities. If a `hasFileOverlap(filesA: string[], filesB: string[]): boolean` helper doesn't already exist (or the existing `detectFileOverlap` has a different signature), add it there.

The test file `lib/wave-scheduler.test.ts` already exists from a previous PR. New tests should be added to it.

## Requirements

1. `lib/atc/utils.ts` must export a `hasFileOverlap(filesA: string[], filesB: string[]): boolean` function (add if not present, reuse/alias if already there with a compatible signature).
2. Items with empty (`[]`) or `undefined` `filesBeingModified` arrays must never trigger conflict detection (treat as no-overlap).
3. `assignWaves` must accept the full work item objects including `createdAt` and `filesBeingModified` fields (update the input type if needed without breaking callers).
4. After initial DAG-based wave assignment, a post-processing pass must iterate over each wave, compare all pairs of items' `filesBeingModified`, and on overlap bump the item with the later `createdAt` to `waveNumber + 1`.
5. After bumping an item, any item that depends on it (directly or transitively) must be re-evaluated so its wave is at least `bumpedItemWave + 1` (cascade).
6. The post-processing loop must repeat until no conflicts remain within any wave (fixpoint iteration).
7. Unit tests cover all five scenarios: no overlap (items stay in same wave), overlap bumps later item, cascade propagation to dependents, empty file lists never conflict, and `undefined` `filesBeingModified` never conflicts.
8. `npx tsc --noEmit` must pass with no new errors.
9. `npm test` (or `npx jest lib/wave-scheduler.test.ts`) must pass.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-scheduler-file-overlap-detection
```

### Step 1: Inspect existing code

Read the relevant files to understand current signatures and utilities:

```bash
cat lib/wave-scheduler.ts
cat lib/wave-scheduler.test.ts
cat lib/atc/utils.ts
```

Note:
- The current `assignWaves` function signature — specifically what type it accepts for items, and whether `createdAt`/`filesBeingModified` are already included.
- Whether `lib/atc/utils.ts` already exports `detectFileOverlap` or `hasFileOverlap`.
- Existing test structure so new tests follow the same pattern.

### Step 2: Add `hasFileOverlap` to `lib/atc/utils.ts`

**If** `lib/atc/utils.ts` already exports `detectFileOverlap(filesA: string[], filesB: string[]): boolean` (or equivalent returning a boolean), add an alias export:

```typescript
// In lib/atc/utils.ts — add near the existing file-overlap utilities

/**
 * Returns true if filesA and filesB share at least one common file path.
 * Empty or undefined arrays never produce an overlap.
 */
export function hasFileOverlap(
  filesA: string[] | undefined,
  filesB: string[] | undefined
): boolean {
  if (!filesA || filesA.length === 0) return false;
  if (!filesB || filesB.length === 0) return false;
  const setA = new Set(filesA);
  return filesB.some((f) => setA.has(f));
}
```

If an equivalent already exists and is exported, simply add `hasFileOverlap` as an alias or second export with the above signature. Do **not** remove or rename the existing utility.

### Step 3: Update `lib/wave-scheduler.ts`

#### 3a. Update the input type

The `assignWaves` function currently accepts items with `id`, `dependencies` (or similar). Extend the accepted type to include the optional fields needed for conflict detection:

```typescript
// Ensure the item type used by assignWaves includes these fields.
// If there is already a local type or imported type, extend it:
interface WaveItem {
  id: string;
  dependencies?: string[];      // IDs of items this item depends on
  createdAt?: string | Date;    // Used to break ties: later item gets bumped
  filesBeingModified?: string[]; // Used for file-overlap conflict detection
  // ... any other existing fields
}
```

If the function already uses a type from `lib/types.ts` or elsewhere that includes these fields (e.g. `WorkItem`), import and use it directly — no need to define a local interface.

#### 3b. Add the post-processing pass

After the initial topological wave assignment loop completes (the existing DAG logic), add the following post-processing pass. Insert it **before** the function returns its result:

```typescript
import { hasFileOverlap } from './atc/utils';

// --- Post-processing: resolve file-overlap conflicts within waves ---
// Repeat until no wave contains two items with overlapping filesBeingModified.
let conflictFound = true;
while (conflictFound) {
  conflictFound = false;

  // Build a map of itemId -> current waveNumber for fast lookup
  // (assumes waveAssignments is a Map<string, number> or equivalent)
  // Adjust variable names to match the existing implementation.

  // Get the max wave to iterate over
  const maxWave = Math.max(...Array.from(waveAssignments.values()));

  for (let wave = 0; wave <= maxWave; wave++) {
    // Collect all items assigned to this wave
    const waveItems = items.filter((item) => waveAssignments.get(item.id) === wave);

    for (let i = 0; i < waveItems.length; i++) {
      for (let j = i + 1; j < waveItems.length; j++) {
        const a = waveItems[i];
        const b = waveItems[j];

        if (!hasFileOverlap(a.filesBeingModified, b.filesBeingModified)) {
          continue;
        }

        // Determine which item to bump: later createdAt loses
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        const toBump = aTime >= bTime ? a : b;

        // Bump to next wave
        const currentWave = waveAssignments.get(toBump.id)!;
        waveAssignments.set(toBump.id, currentWave + 1);
        conflictFound = true;

        // Cascade: any item that (transitively) depends on toBump must be
        // at wave >= toBump's new wave + 1
        cascadeDependents(toBump.id, waveAssignments, items);
      }
    }

    // If we found a conflict in this wave, restart the outer while loop
    if (conflictFound) break;
  }
}
```

#### 3c. Add the `cascadeDependents` helper (private, within the file)

```typescript
/**
 * After bumping `bumpedId` to a new wave, ensure all items that depend on it
 * (directly or transitively) are assigned to at least bumpedWave + 1.
 */
function cascadeDependents(
  bumpedId: string,
  waveAssignments: Map<string, number>,
  items: WaveItem[]
): void {
  const bumpedWave = waveAssignments.get(bumpedId)!;

  // Find direct dependents: items that list bumpedId in their dependencies
  const directDependents = items.filter(
    (item) => item.dependencies?.includes(bumpedId)
  );

  for (const dep of directDependents) {
    const depWave = waveAssignments.get(dep.id) ?? 0;
    const requiredWave = bumpedWave + 1;
    if (depWave < requiredWave) {
      waveAssignments.set(dep.id, requiredWave);
      // Recurse for transitive dependents
      cascadeDependents(dep.id, waveAssignments, items);
    }
  }
}
```

**Important:** Adapt all variable names (`waveAssignments`, `items`, etc.) to match the actual variable names used in the existing `assignWaves` implementation. The logic above is the canonical algorithm — the names are illustrative.

### Step 4: Update `lib/wave-scheduler.test.ts`

Add a new `describe` block for file-overlap conflict detection. Append it after the existing test suite:

```typescript
describe('assignWaves — file-overlap conflict detection', () => {
  // Helper to create a minimal WaveItem
  function makeItem(
    id: string,
    deps: string[],
    files: string[],
    createdAt: string,
    dependencies?: string[]
  ) {
    return {
      id,
      dependencies: deps,
      filesBeingModified: files,
      createdAt,
    };
  }

  it('does not bump items when no file overlap exists', () => {
    const items = [
      makeItem('a', [], ['src/foo.ts'], '2024-01-01T00:00:00Z'),
      makeItem('b', [], ['src/bar.ts'], '2024-01-01T00:01:00Z'),
    ];
    const result = assignWaves(items);
    // Both items are independent — they should stay in wave 0
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
  });

  it('bumps the later item (by createdAt) when file overlap is detected', () => {
    const items = [
      makeItem('a', [], ['src/shared.ts'], '2024-01-01T00:00:00Z'), // earlier
      makeItem('b', [], ['src/shared.ts'], '2024-01-01T00:01:00Z'), // later → bumped
    ];
    const result = assignWaves(items);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(1);
  });

  it('cascades dependents of a bumped item to a later wave', () => {
    // a and b overlap → b bumped to wave 1
    // c depends on b → c must be at wave 2
    const items = [
      makeItem('a', [], ['src/shared.ts'], '2024-01-01T00:00:00Z'),
      makeItem('b', [], ['src/shared.ts'], '2024-01-01T00:01:00Z'),
      makeItem('c', ['b'], ['src/other.ts'], '2024-01-01T00:02:00Z'),
    ];
    const result = assignWaves(items);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(1);
    expect(result.get('c')).toBe(2);
  });

  it('never triggers conflict for items with empty filesBeingModified', () => {
    const items = [
      makeItem('a', [], [], '2024-01-01T00:00:00Z'),
      makeItem('b', [], [], '2024-01-01T00:01:00Z'),
    ];
    const result = assignWaves(items);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
  });

  it('never triggers conflict for items with undefined filesBeingModified', () => {
    const items = [
      { id: 'a', dependencies: [], createdAt: '2024-01-01T00:00:00Z' },
      { id: 'b', dependencies: [], createdAt: '2024-01-01T00:01:00Z' },
    ];
    const result = assignWaves(items as any);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
  });
});
```

Adjust the import of `assignWaves` and the test helper to match the actual export name and argument shape in `lib/wave-scheduler.ts`.

### Step 5: Add `hasFileOverlap` unit tests to the utils test file (if one exists)

If `lib/atc/utils.test.ts` (or similar) exists, add a brief describe block:

```typescript
describe('hasFileOverlap', () => {
  it('returns true for overlapping arrays', () => {
    expect(hasFileOverlap(['a.ts', 'b.ts'], ['b.ts', 'c.ts'])).toBe(true);
  });
  it('returns false for non-overlapping arrays', () => {
    expect(hasFileOverlap(['a.ts'], ['b.ts'])).toBe(false);
  });
  it('returns false for empty arrays', () => {
    expect(hasFileOverlap([], ['a.ts'])).toBe(false);
    expect(hasFileOverlap(['a.ts'], [])).toBe(false);
  });
  it('returns false for undefined inputs', () => {
    expect(hasFileOverlap(undefined, ['a.ts'])).toBe(false);
    expect(hasFileOverlap(['a.ts'], undefined)).toBe(false);
  });
});
```

If no utils test file exists, skip this step.

### Step 6: Verification

```bash
# Type check — must pass with no new errors
npx tsc --noEmit

# Run wave scheduler tests
npx jest lib/wave-scheduler.test.ts --no-coverage

# Run utils tests if they exist
npx jest lib/atc/utils --no-coverage 2>/dev/null || true

# Full test suite
npm test
```

All tests must pass. Fix any type errors before proceeding.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add file-overlap conflict detection to wave scheduler

- Add hasFileOverlap helper to lib/atc/utils.ts
- Post-processing pass in assignWaves bumps conflicting items to next wave
- Cascade logic ensures dependents maintain correct wave ordering
- Unit tests cover no-overlap, bump, cascade, empty, and undefined cases"

git push origin feat/wave-scheduler-file-overlap-detection

gh pr create \
  --title "feat: add file-overlap conflict detection to wave scheduler" \
  --body "## Summary

Extends \`assignWaves\` in \`lib/wave-scheduler.ts\` with a post-processing pass that detects file-overlap conflicts within the same wave and bumps the later item (by \`createdAt\`) to the next wave, cascading dependents.

## Changes
- **\`lib/atc/utils.ts\`**: Added \`hasFileOverlap(filesA, filesB)\` helper (empty/undefined arrays always return false)
- **\`lib/wave-scheduler.ts\`**: Post-processing fixpoint loop after DAG-based wave assignment; \`cascadeDependents\` helper for transitive cascade
- **\`lib/wave-scheduler.test.ts\`**: 5 new unit tests covering all AC scenarios

## Acceptance Criteria
- [x] Later item (by createdAt) bumped when overlap detected
- [x] Dependents cascaded to maintain wave ordering
- [x] \`hasFileOverlap\` exported from \`lib/atc/utils.ts\`
- [x] Empty/undefined filesBeingModified never trigger conflict
- [x] Unit tests: no-overlap, bump, cascade, empty, undefined"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wave-scheduler-file-overlap-detection
FILES CHANGED: [list of modified files]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains to complete the work item]
```

## Escalation

If blocked by an ambiguous type signature, missing dependencies, or a test failure that cannot be resolved after 3 attempts:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-file-overlap-conflict-detection-to-wave-scheduler",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/wave-scheduler.ts", "lib/atc/utils.ts", "lib/wave-scheduler.test.ts"]
    }
  }'
```