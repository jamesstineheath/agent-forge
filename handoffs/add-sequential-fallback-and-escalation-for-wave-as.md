# Agent Forge -- Add Sequential Fallback and Escalation for Wave Assignment Failures

## Metadata
- **Branch:** `feat/wave-scheduler-safe-fallback`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/wave-scheduler.ts, lib/escalation.ts, lib/wave-scheduler.test.ts

## Context

Agent Forge uses a wave scheduler to assign work items to dispatch waves based on dependency ordering. The wave assignment logic lives in `lib/wave-scheduler.ts`. When wave assignment fails (due to circular dependencies, missing metadata, or malformed graphs), dispatch must not be blocked — the system should gracefully fall back to sequential dispatch (all items in wave 0).

Additionally, when fallback occurs, an escalation record should be created so operators are notified. The escalation system lives in `lib/escalation.ts`.

This task adds:
1. `assignWavesSafe` — a safe wrapper around `assignWaves` with try/catch fallback
2. `createWaveFallbackEscalation` — a helper to record wave-fallback escalation events
3. Fixes legacy item handling so `dependsOn: undefined | null` is treated as wave 0 in the normal flow (not just fallback)
4. Unit tests covering the key scenarios

The dispatcher (modified in a separate work item) will call `assignWavesSafe` and check the `fallback` flag.

## Requirements

1. `lib/wave-scheduler.ts` must export `assignWavesSafe(items: WorkItem[]): { assignments: WaveAssignment[]; fallback: boolean; error?: string }` (or equivalent signature matching existing types)
2. When `assignWaves` throws, `assignWavesSafe` catches the error, sets `fallback: true`, assigns all items to wave 0, and includes the error message string
3. When `assignWaves` succeeds, `assignWavesSafe` returns `{ assignments, fallback: false }` with no `error` field
4. Items with `dependsOn: undefined | null` are treated as wave 0 (no dependencies) in the normal `assignWaves` flow — not a special fallback case
5. `lib/escalation.ts` must export `createWaveFallbackEscalation(projectId: string, error: string): Promise<void>` that creates an escalation record noting wave assignment failed and sequential dispatch is being used
6. `lib/wave-scheduler.test.ts` must contain unit tests covering: successful assignment (fallback=false), circular dependency triggers fallback, missing `dependsOn` results in wave 0 assignment
7. All TypeScript must compile without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-scheduler-safe-fallback
```

### Step 1: Inspect existing files

Read the current state of the relevant files before making changes:

```bash
cat lib/wave-scheduler.ts 2>/dev/null || echo "FILE NOT FOUND"
cat lib/escalation.ts 2>/dev/null || echo "FILE NOT FOUND"
cat lib/types.ts | grep -A 20 "WorkItem\|WaveAssign\|dependsOn" | head -60
```

Take note of:
- The existing `assignWaves` function signature and return type
- The `WaveAssignment` type (if defined)
- How `WorkItem` is typed (especially `dependsOn` field)
- How existing escalation helpers are structured in `lib/escalation.ts`

### Step 2: Update `lib/wave-scheduler.ts`

**If `lib/wave-scheduler.ts` does not exist**, create it from scratch. **If it exists**, read its contents fully, then apply the following additions/modifications.

The file must:

1. Ensure `assignWaves` handles `dependsOn: undefined | null` by treating those items as having no dependencies (wave 0). Add a guard at the start of the dependency resolution loop like:

```typescript
const deps = item.dependsOn ?? [];
```

2. Export `assignWavesSafe`:

```typescript
export function assignWavesSafe(items: WorkItem[]): {
  assignments: WaveAssignment[];
  fallback: boolean;
  error?: string;
} {
  try {
    const assignments = assignWaves(items);
    return { assignments, fallback: false };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const assignments: WaveAssignment[] = items.map((item) => ({
      itemId: item.id,
      wave: 0,
    }));
    return { assignments, fallback: true, error: errorMessage };
  }
}
```

**Important:** Match the exact `WaveAssignment` shape that already exists in the codebase. If `WaveAssignment` is not yet defined, define it as:

```typescript
export interface WaveAssignment {
  itemId: string;
  wave: number;
}
```

And ensure `assignWaves` returns `WaveAssignment[]`.

If `assignWaves` does not yet exist, implement it with topological sort (Kahn's algorithm):

```typescript
export function assignWaves(items: WorkItem[]): WaveAssignment[] {
  // Build id → item map
  const itemMap = new Map(items.map((i) => [i.id, i]));

  // Build in-degree and adjacency
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // id → items that depend on id

  for (const item of items) {
    if (!inDegree.has(item.id)) inDegree.set(item.id, 0);
    if (!dependents.has(item.id)) dependents.set(item.id, []);
  }

  for (const item of items) {
    const deps = item.dependsOn ?? [];
    for (const depId of deps) {
      if (!itemMap.has(depId)) continue; // skip external/missing deps
      inDegree.set(item.id, (inDegree.get(item.id) ?? 0) + 1);
      dependents.get(depId)!.push(item.id);
    }
  }

  // Kahn's algorithm
  const waveMap = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
      waveMap.set(id, 0);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    const currentWave = waveMap.get(current) ?? 0;

    for (const depId of dependents.get(current) ?? []) {
      const newDeg = (inDegree.get(depId) ?? 1) - 1;
      inDegree.set(depId, newDeg);
      const newWave = Math.max(waveMap.get(depId) ?? 0, currentWave + 1);
      waveMap.set(depId, newWave);
      if (newDeg === 0) {
        queue.push(depId);
      }
    }
  }

  if (processed < items.length) {
    throw new Error(
      `Circular dependency detected: only ${processed} of ${items.length} items could be ordered`
    );
  }

  return items.map((item) => ({
    itemId: item.id,
    wave: waveMap.get(item.id) ?? 0,
  }));
}
```

### Step 3: Update `lib/escalation.ts`

Read the current file in full first:

```bash
cat lib/escalation.ts
```

Look for:
- How existing escalation records are created (e.g., `createEscalation`, storage pattern using Vercel Blob)
- The `EscalationRecord` type shape
- Any existing helpers as a pattern to follow

Add the following export, adapting the implementation to match how existing escalations are created:

```typescript
export async function createWaveFallbackEscalation(
  projectId: string,
  error: string
): Promise<void> {
  // Pattern: follow how existing createEscalation() works in this file
  // The record should note:
  //   - reason: "Wave assignment failed; using sequential dispatch (wave 0)"
  //   - projectId: projectId
  //   - error details in the description
  //   - status: "pending"
  //   - type/category: indicate this is an automated wave-fallback event

  await createEscalation({
    projectId,
    reason: `Wave assignment failed; using sequential dispatch (wave 0). Error: ${error}`,
    // include any other required fields matching the existing EscalationRecord shape
  });
}
```

**Important:** Do not guess at the escalation API shape. Read `lib/escalation.ts` fully and match the exact function signatures, field names, and storage calls already present.

If the file uses Vercel Blob directly, follow that pattern. If it has a `createEscalation` helper, call that. If neither exists, create a minimal implementation that stores to Vercel Blob consistent with the rest of the codebase (`lib/storage.ts` pattern).

### Step 4: Create `lib/wave-scheduler.test.ts`

Create a Jest/Vitest test file (check `package.json` for the test runner):

```bash
cat package.json | grep -E '"test"|jest|vitest'
```

Create `lib/wave-scheduler.test.ts`:

```typescript
import { assignWaves, assignWavesSafe } from "./wave-scheduler";
import type { WorkItem } from "./types";

// Minimal WorkItem factory for testing
function makeItem(id: string, dependsOn?: string[]): WorkItem {
  return {
    id,
    dependsOn: dependsOn ?? [],
    // Fill other required fields with minimal values
    title: `Item ${id}`,
    status: "ready",
    priority: "medium",
    repoFullName: "test/repo",
    type: "feature",
    description: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as WorkItem;
}

describe("assignWaves", () => {
  it("assigns independent items to wave 0", () => {
    const items = [makeItem("a"), makeItem("b"), makeItem("c")];
    const result = assignWaves(items);
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.wave).toBe(0);
    }
  });

  it("assigns correct waves for a linear chain", () => {
    // a → b → c
    const items = [
      makeItem("a"),
      makeItem("b", ["a"]),
      makeItem("c", ["b"]),
    ];
    const result = assignWaves(items);
    const byId = Object.fromEntries(result.map((r) => [r.itemId, r.wave]));
    expect(byId["a"]).toBe(0);
    expect(byId["b"]).toBe(1);
    expect(byId["c"]).toBe(2);
  });

  it("throws on circular dependency", () => {
    // a → b → a
    const items = [makeItem("a", ["b"]), makeItem("b", ["a"])];
    expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
  });

  it("treats undefined dependsOn as wave 0 (normal flow)", () => {
    const item = makeItem("x");
    // @ts-ignore — simulate legacy item with undefined dependsOn
    item.dependsOn = undefined;
    const result = assignWaves([item]);
    expect(result[0].wave).toBe(0);
  });

  it("treats null dependsOn as wave 0 (normal flow)", () => {
    const item = makeItem("y");
    // @ts-ignore — simulate legacy item with null dependsOn
    item.dependsOn = null;
    const result = assignWaves([item]);
    expect(result[0].wave).toBe(0);
  });
});

describe("assignWavesSafe", () => {
  it("returns fallback=false on successful assignment", () => {
    const items = [makeItem("a"), makeItem("b", ["a"])];
    const result = assignWavesSafe(items);
    expect(result.fallback).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.assignments).toHaveLength(2);
  });

  it("returns fallback=true with all items at wave 0 on circular dependency", () => {
    const items = [makeItem("a", ["b"]), makeItem("b", ["a"])];
    const result = assignWavesSafe(items);
    expect(result.fallback).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/[Cc]ircular/);
    expect(result.assignments).toHaveLength(2);
    for (const a of result.assignments) {
      expect(a.wave).toBe(0);
    }
  });

  it("includes all item IDs in fallback assignments", () => {
    const items = [makeItem("x", ["y"]), makeItem("y", ["x"])];
    const result = assignWavesSafe(items);
    expect(result.fallback).toBe(true);
    const ids = result.assignments.map((a) => a.itemId).sort();
    expect(ids).toEqual(["x", "y"]);
  });
});
```

**Note:** If the `WorkItem` type requires fields that differ from the above factory, adjust the factory to satisfy TypeScript. Use `as unknown as WorkItem` casting sparingly — prefer satisfying the actual type shape.

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `WorkItem` may not have a `dependsOn` field yet — check `lib/types.ts` and `lib/db/schema.ts`. If `dependsOn` is not on `WorkItem`, check how the wave scheduler is expected to receive it (may be a separate type or inferred from work item dependencies table).
- `WaveAssignment` may already be defined elsewhere — don't redefine it.
- If `createEscalation` doesn't exist in `lib/escalation.ts`, adapt the implementation to use whatever pattern does exist.

### Step 6: Run tests

```bash
npm test -- --testPathPattern="wave-scheduler" --no-coverage 2>&1 | tail -40
```

Or for vitest:
```bash
npx vitest run lib/wave-scheduler.test.ts 2>&1 | tail -40
```

Fix any test failures. Adjust the `makeItem` factory if needed to satisfy the actual `WorkItem` type.

### Step 7: Full build verification

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -30
```

### Step 8: Commit, push, open PR

```bash
git add lib/wave-scheduler.ts lib/escalation.ts lib/wave-scheduler.test.ts
git add -A
git commit -m "feat: add assignWavesSafe fallback and createWaveFallbackEscalation

- assignWavesSafe wraps assignWaves in try/catch, returns all items at wave 0 on failure
- createWaveFallbackEscalation creates escalation record when wave assignment fails
- Legacy items with undefined/null dependsOn treated as wave 0 in normal flow
- Unit tests cover: success path, circular dep fallback, missing dependsOn → wave 0"

git push origin feat/wave-scheduler-safe-fallback

gh pr create \
  --title "feat: add sequential fallback and escalation for wave assignment failures" \
  --body "## Summary

Adds robust error handling to the wave scheduler so that failures never block dispatch.

## Changes

### \`lib/wave-scheduler.ts\`
- \`assignWaves\`: ensures \`dependsOn: undefined | null\` treated as wave 0 in normal flow
- New export: \`assignWavesSafe\` — wraps \`assignWaves\` in try/catch, returns \`{ assignments, fallback, error? }\`
  - On success: \`fallback: false\`, normal wave assignments
  - On failure (e.g., circular deps): \`fallback: true\`, all items at wave 0, error message included

### \`lib/escalation.ts\`
- New export: \`createWaveFallbackEscalation(projectId, error)\` — creates escalation record noting wave assignment failed and sequential dispatch is active

### \`lib/wave-scheduler.test.ts\`
- Unit tests: independent items → wave 0, linear chain waves, circular dep throws, undefined/null dependsOn → wave 0
- Safe wrapper tests: success path (fallback=false), circular dep (fallback=true, all wave 0), fallback includes all IDs

## Acceptance Criteria
- [x] \`assignWavesSafe\` exported from \`lib/wave-scheduler.ts\`
- [x] Circular dep triggers fallback with all items at wave 0
- [x] \`createWaveFallbackEscalation\` exported from \`lib/escalation.ts\`
- [x] Legacy \`dependsOn: undefined/null\` treated as wave 0 in normal flow
- [x] Unit tests cover all required scenarios
" \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wave-scheduler-safe-fallback
FILES CHANGED: [list files actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If blocked on an unresolvable issue (e.g., `WorkItem` type doesn't have `dependsOn` and there's no clear place to add it, or the escalation system has a completely different API than expected):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "wave-scheduler-safe-fallback",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/wave-scheduler.ts", "lib/escalation.ts", "lib/wave-scheduler.test.ts"]
    }
  }'
```