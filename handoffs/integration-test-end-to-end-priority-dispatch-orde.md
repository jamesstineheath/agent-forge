# Agent Forge -- Integration test: end-to-end priority dispatch ordering

## Metadata
- **Branch:** `feat/priority-dispatch-integration-test`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature`
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/__tests__/priority-dispatch.test.ts

## Context

Agent Forge uses a priority-aware dispatch system to order work items for execution. The `Priority` type (`'P0' | 'P1' | 'P2'`), `DEFAULT_PRIORITY`, `DEFAULT_RANK`, and `dispatchSortComparator` live in `lib/types.ts` and `lib/atc/utils.ts`. These have been built but lack end-to-end integration tests verifying that the full pipeline — types, constants, comparator, and legacy-item handling — all work together correctly.

This task adds a focused test file at `lib/atc/__tests__/priority-dispatch.test.ts` that exercises the complete priority dispatch ordering path.

Key things to know before writing the test:
- `lib/types.ts` exports `Priority` type and likely `DEFAULT_PRIORITY` / `DEFAULT_RANK` constants
- `lib/atc/utils.ts` exports `dispatchSortComparator` (and potentially `detectPrioritySkip`)
- Legacy items have no `priority` or `rank` field and should sort as if they are `P1` / rank `999`
- The project uses Jest (check `package.json` for the exact test command and config)

## Requirements

1. Test file exists at `lib/atc/__tests__/priority-dispatch.test.ts`
2. At least 6 test cases covering:
   - Basic priority ordering: `[P2-rank-1, P0-rank-5, P1-rank-3]` → `[P0-rank-5, P1-rank-3, P2-rank-1]`
   - Rank ordering within the same priority (lower rank number = higher precedence)
   - `createdAt` tiebreaker when priority and rank are identical
   - Legacy items (no `priority`/`rank`) default to `P1`/`999` and sort between P0 and P2 items
   - Mixed undefined fields (some items have priority but no rank, or rank but no priority)
   - All same priority (sort falls through to rank then createdAt)
3. Verify `DEFAULT_PRIORITY === 'P1'` and `DEFAULT_RANK === 999`
4. Verify `Priority` type only accepts `'P0'`, `'P1'`, `'P2'` (TypeScript compile-time check via type assertion)
5. All tests pass with zero TypeScript errors
6. Test imports only from `lib/types.ts` and `lib/atc/utils.ts` (no new dependencies)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/priority-dispatch-integration-test
```

### Step 1: Inspect existing source files

Before writing the test, read the actual exports from the relevant files to ensure correct import paths and names:

```bash
# Check what Priority, DEFAULT_PRIORITY, DEFAULT_RANK look like
grep -n "Priority\|DEFAULT_PRIORITY\|DEFAULT_RANK\|export" lib/types.ts | head -60

# Check dispatchSortComparator and any related exports
grep -n "dispatchSortComparator\|detectPrioritySkip\|DEFAULT\|export" lib/atc/utils.ts | head -60

# Confirm test runner setup
cat package.json | grep -A 10 '"jest"\|"test"\|"vitest"'
cat jest.config* 2>/dev/null || cat vitest.config* 2>/dev/null || echo "No config found"

# Check if __tests__ dir already exists
ls lib/atc/__tests__/ 2>/dev/null || echo "Directory does not exist yet"
```

### Step 2: Understand the WorkItem type shape

```bash
# Find the WorkItem type definition to know field names
grep -n "WorkItem\|priority\|rank\|createdAt" lib/types.ts | head -40
```

### Step 3: Create the test directory and test file

```bash
mkdir -p lib/atc/__tests__
```

Now create `lib/atc/__tests__/priority-dispatch.test.ts`. Use the actual field names and export names you discovered in Step 1. The template below uses the most likely names — **adjust any import paths, type names, or constant names based on what you found**:

```typescript
/**
 * Integration test: end-to-end priority dispatch ordering
 *
 * Verifies that Priority type, DEFAULT_PRIORITY/DEFAULT_RANK constants,
 * and dispatchSortComparator all work together correctly across the full
 * priority-aware dispatch pipeline.
 */

import { Priority, DEFAULT_PRIORITY, DEFAULT_RANK, WorkItem } from '../../types';
// Adjust the import below if dispatchSortComparator is exported differently
import { dispatchSortComparator } from '../utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  id: string,
  overrides: Partial<WorkItem> = {}
): WorkItem {
  return {
    id,
    title: `Work item ${id}`,
    description: '',
    status: 'ready',
    repoFullName: 'jamesstineheath/agent-forge',
    createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    // priority and rank intentionally omitted for legacy-item tests
    ...overrides,
  } as WorkItem;
}

function sortItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort(dispatchSortComparator);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Priority dispatch constants', () => {
  it('DEFAULT_PRIORITY should be P1', () => {
    expect(DEFAULT_PRIORITY).toBe('P1');
  });

  it('DEFAULT_RANK should be 999', () => {
    expect(DEFAULT_RANK).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Type safety (compile-time)
// ---------------------------------------------------------------------------

describe('Priority type', () => {
  it('accepts P0, P1, P2 as valid Priority values', () => {
    const p0: Priority = 'P0';
    const p1: Priority = 'P1';
    const p2: Priority = 'P2';
    expect(['P0', 'P1', 'P2']).toContain(p0);
    expect(['P0', 'P1', 'P2']).toContain(p1);
    expect(['P0', 'P1', 'P2']).toContain(p2);
  });
});

// ---------------------------------------------------------------------------
// Basic priority ordering
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — basic priority ordering', () => {
  it('sorts [P2, P0, P1] into [P0, P1, P2]', () => {
    const items = [
      makeItem('c', { priority: 'P2', rank: 1 }),
      makeItem('a', { priority: 'P0', rank: 5 }),
      makeItem('b', { priority: 'P1', rank: 3 }),
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.priority)).toEqual(['P0', 'P1', 'P2']);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('P0 items always come before P1 items', () => {
    const items = [
      makeItem('p1-item', { priority: 'P1', rank: 1 }),
      makeItem('p0-item', { priority: 'P0', rank: 100 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].priority).toBe('P0');
    expect(sorted[1].priority).toBe('P1');
  });

  it('P1 items always come before P2 items', () => {
    const items = [
      makeItem('p2-item', { priority: 'P2', rank: 1 }),
      makeItem('p1-item', { priority: 'P1', rank: 100 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].priority).toBe('P1');
    expect(sorted[1].priority).toBe('P2');
  });
});

// ---------------------------------------------------------------------------
// Rank ordering within same priority
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — rank ordering within same priority', () => {
  it('sorts lower rank numbers first within the same priority', () => {
    const items = [
      makeItem('rank-5', { priority: 'P1', rank: 5 }),
      makeItem('rank-1', { priority: 'P1', rank: 1 }),
      makeItem('rank-3', { priority: 'P1', rank: 3 }),
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.rank)).toEqual([1, 3, 5]);
    expect(sorted.map((i) => i.id)).toEqual(['rank-1', 'rank-3', 'rank-5']);
  });

  it('all same priority — falls through to rank then createdAt', () => {
    const items = [
      makeItem('b', { priority: 'P0', rank: 2, createdAt: '2024-01-02T00:00:00Z' }),
      makeItem('a', { priority: 'P0', rank: 2, createdAt: '2024-01-01T00:00:00Z' }),
      makeItem('c', { priority: 'P0', rank: 1, createdAt: '2024-01-03T00:00:00Z' }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('c');   // rank 1 wins
    expect(sorted[1].id).toBe('a');   // rank 2, earlier createdAt
    expect(sorted[2].id).toBe('b');   // rank 2, later createdAt
  });
});

// ---------------------------------------------------------------------------
// createdAt tiebreaker
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — createdAt tiebreaker', () => {
  it('earlier createdAt wins when priority and rank are identical', () => {
    const items = [
      makeItem('later',  { priority: 'P1', rank: 1, createdAt: '2024-06-01T00:00:00Z' }),
      makeItem('earlier', { priority: 'P1', rank: 1, createdAt: '2024-01-01T00:00:00Z' }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('earlier');
    expect(sorted[1].id).toBe('later');
  });
});

// ---------------------------------------------------------------------------
// Legacy items (no priority / no rank)
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — legacy items default to P1/999', () => {
  it('legacy item (no priority, no rank) sorts between P0 and P2', () => {
    const items = [
      makeItem('p2',     { priority: 'P2', rank: 1 }),
      makeItem('legacy', {}),  // no priority, no rank
      makeItem('p0',     { priority: 'P0', rank: 1 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p0');
    expect(sorted[1].id).toBe('legacy');
    expect(sorted[2].id).toBe('p2');
  });

  it('legacy item sorts at rank 999 within P1 tier', () => {
    const items = [
      makeItem('p1-rank-1',   { priority: 'P1', rank: 1 }),
      makeItem('legacy',      {}),   // defaults to P1/999
      makeItem('p1-rank-500', { priority: 'P1', rank: 500 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p1-rank-1');
    expect(sorted[1].id).toBe('p1-rank-500');
    expect(sorted[2].id).toBe('legacy');
  });
});

// ---------------------------------------------------------------------------
// Mixed undefined fields
// ---------------------------------------------------------------------------

describe('dispatchSortComparator — mixed undefined fields', () => {
  it('item with priority but no rank defaults rank to DEFAULT_RANK (999)', () => {
    const items = [
      makeItem('p1-no-rank',   { priority: 'P1' }),         // rank undefined → 999
      makeItem('p1-rank-500',  { priority: 'P1', rank: 500 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p1-rank-500');
    expect(sorted[1].id).toBe('p1-no-rank');
  });

  it('item with rank but no priority defaults priority to DEFAULT_PRIORITY (P1)', () => {
    const items = [
      makeItem('no-priority-rank-1', { rank: 1 }),   // priority undefined → P1
      makeItem('p0-rank-5',          { priority: 'P0', rank: 5 }),
      makeItem('p2-rank-1',          { priority: 'P2', rank: 1 }),
    ];
    const sorted = sortItems(items);
    expect(sorted[0].id).toBe('p0-rank-5');
    expect(sorted[1].id).toBe('no-priority-rank-1');  // treated as P1/1
    expect(sorted[2].id).toBe('p2-rank-1');
  });

  it('all undefined priority/rank items sort stably by createdAt', () => {
    const items = [
      makeItem('c', { createdAt: '2024-03-01T00:00:00Z' }),
      makeItem('a', { createdAt: '2024-01-01T00:00:00Z' }),
      makeItem('b', { createdAt: '2024-02-01T00:00:00Z' }),
    ];
    const sorted = sortItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
```

> **Important:** After writing the file, verify the imports compile by checking the actual exports. If `Priority`, `DEFAULT_PRIORITY`, `DEFAULT_RANK` are not exported from `lib/types.ts`, or if `dispatchSortComparator` is not exported from `lib/atc/utils.ts`, adjust the imports and test assertions accordingly. Also check if `WorkItem` has `priority` and `rank` as optional fields — if not, use a type cast (`as WorkItem`) or adjust the `makeItem` helper.

### Step 4: Fix any import/type issues

```bash
# Run TypeScript check to surface import errors immediately
npx tsc --noEmit 2>&1 | head -40
```

If you see errors like "Module has no exported member 'X'", go back and fix the imports to match what's actually exported. Common fixes:
- If `DEFAULT_PRIORITY` / `DEFAULT_RANK` don't exist: define them inline in the test as `const DEFAULT_PRIORITY = 'P1'; const DEFAULT_RANK = 999;` and add a comment that these should be exported from lib/types.ts
- If `WorkItem` doesn't have `priority`/`rank` fields: check if they are on a subtype or use `(makeItem('id', {...}) as any)` sparingly

### Step 5: Run tests

```bash
# Run just the new test file
npx jest lib/atc/__tests__/priority-dispatch.test.ts --no-coverage 2>&1

# If vitest is used instead:
# npx vitest run lib/atc/__tests__/priority-dispatch.test.ts
```

If tests fail due to comparator behavior differences (e.g. legacy items sort differently than expected), **adjust the test assertions to match the actual implementation** rather than forcing the implementation to change. The goal is to document and verify current behavior.

### Step 6: Full verification

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -20
npx jest --no-coverage 2>&1 | tail -30
```

All existing tests must still pass.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "test: add integration tests for priority dispatch ordering

- Verifies dispatchSortComparator produces P0 < P1 < P2 ordering
- Verifies lower rank numbers dispatch first within same priority
- Verifies createdAt as final tiebreaker
- Verifies legacy items (no priority/rank) default to P1/999
- Verifies mixed undefined field handling
- Verifies DEFAULT_PRIORITY='P1' and DEFAULT_RANK=999 constants"

git push origin feat/priority-dispatch-integration-test

gh pr create \
  --title "test: integration tests for end-to-end priority dispatch ordering" \
  --body "## Summary

Adds \`lib/atc/__tests__/priority-dispatch.test.ts\` with 10+ test cases covering the full priority-aware dispatch pipeline.

## Test Coverage

- **Basic priority ordering**: \`[P2-rank-1, P0-rank-5, P1-rank-3]\` → \`[P0-rank-5, P1-rank-3, P2-rank-1]\`
- **Rank ordering within same priority**: lower rank number = dispatched first
- **createdAt tiebreaker**: earlier creation time wins when priority and rank are equal
- **Legacy items**: items with no \`priority\`/\`rank\` sort as P1/999 (between P0 and P2)
- **Mixed undefined fields**: items with only priority or only rank use defaults for the missing field
- **Constants**: \`DEFAULT_PRIORITY === 'P1'\`, \`DEFAULT_RANK === 999\`
- **Type safety**: \`Priority\` type validated at compile time

## Files Changed

- \`lib/atc/__tests__/priority-dispatch.test.ts\` (new)

## Checklist
- [ ] All tests pass
- [ ] TypeScript compiles with zero errors
- [ ] No changes to production code"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/priority-dispatch-integration-test
FILES CHANGED: [lib/atc/__tests__/priority-dispatch.test.ts]
SUMMARY: [what was done]
ISSUES: [what failed — e.g. "dispatchSortComparator not exported from lib/atc/utils.ts"]
NEXT STEPS: [e.g. "export dispatchSortComparator from utils.ts OR update import path"]
```

If blocked by a missing export or ambiguous type shape, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "priority-dispatch-integration-test",
    "reason": "dispatchSortComparator or Priority/DEFAULT_PRIORITY exports not found in expected locations",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 4",
      "error": "<paste tsc error here>",
      "filesChanged": ["lib/atc/__tests__/priority-dispatch.test.ts"]
    }
  }'
```