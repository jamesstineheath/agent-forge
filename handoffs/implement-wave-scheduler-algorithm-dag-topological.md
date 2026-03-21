# Agent Forge -- Implement Wave Scheduler Algorithm (DAG Topological Sort)

## Metadata
- **Branch:** `feat/wave-scheduler-algorithm`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/wave-scheduler.ts, lib/wave-scheduler.test.ts

## Context

Agent Forge orchestrates autonomous agents that execute work items across target repositories. Work items can have dependencies on each other (via `dependsOn` arrays), and a recent schema migration added a `waveNumber` column to the `work_items` table (see merged PR: `feat: add waveNumber column to work_items schema and WaveProgressData type`).

The wave scheduler is the algorithmic core that takes a set of work items with dependency edges and assigns each a wave number — representing the minimum execution wave in which it can be dispatched. Items in wave 0 have no dependencies, items in wave 1 depend only on wave 0 items, etc. This enables the dispatcher and project manager to batch-dispatch items in safe parallel waves.

The `waveNumber` column already exists in `lib/db/schema.ts`. This task creates the pure algorithmic module that computes wave assignments — it does not touch the database directly.

Existing patterns in the codebase:
- TypeScript with strict typing throughout
- Modules export named interfaces and functions (no default exports for library code)
- Test files colocated with source using `.test.ts` suffix
- Errors thrown with descriptive messages (see `lib/orchestrator.ts` patterns)

## Requirements

1. `lib/wave-scheduler.ts` must export a `WaveAssignment` interface with fields: `workItemId: string`, `waveNumber: number`, `dependsOn: string[]`, `filesBeingModified: string[]`
2. `lib/wave-scheduler.ts` must export an `assignWaves` function that accepts an array of items with shape `{ id: string; dependsOn: string[]; filesBeingModified: string[]; createdAt: Date }[]` and returns `WaveAssignment[]`
3. `assignWaves` must assign `waveNumber: 0` to all items with no dependencies (empty or missing `dependsOn`)
4. `assignWaves` must assign `waveNumber: N` where `N = max(waveNumber of all dependencies) + 1` for items with dependencies
5. `assignWaves` must throw a descriptive `Error` when circular dependencies are detected, including the cycle path in the message
6. `lib/wave-scheduler.ts` must export a `detectCircularDependencies` function that returns the cycle path as `string[]` or `null` if no cycle
7. The implementation must use Kahn's algorithm (BFS-based topological sort with in-degree tracking)
8. Items whose `dependsOn` references IDs not present in the input array must be treated as if those dependencies don't exist (graceful handling of dangling references)
9. `lib/wave-scheduler.test.ts` must include comprehensive unit tests covering: all-root items, linear chain, diamond DAG, parallel branches, circular dependency detection, empty input, single item, missing dependency IDs

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-scheduler-algorithm
```

### Step 1: Create `lib/wave-scheduler.ts`

Create the file with the following complete implementation:

```typescript
/**
 * Wave Scheduler — DAG topological sort for work item dependency waves.
 *
 * Assigns each work item a "wave number" equal to the length of the longest
 * path from any root node (no dependencies) to that item. Items in the same
 * wave can be dispatched in parallel.
 */

export interface WaveAssignment {
  workItemId: string;
  waveNumber: number;
  dependsOn: string[];
  filesBeingModified: string[];
}

export interface WaveSchedulerInput {
  id: string;
  dependsOn: string[];
  filesBeingModified: string[];
  createdAt: Date;
}

/**
 * Detects circular dependencies in a set of work items using DFS.
 * Returns the cycle path as an array of IDs (first element repeated at end),
 * or null if no cycle exists.
 */
export function detectCircularDependencies(
  items: WaveSchedulerInput[]
): string[] | null {
  // Build adjacency list — only include edges where both endpoints are in the input set
  const knownIds = new Set(items.map((item) => item.id));
  const adj = new Map<string, string[]>();
  for (const item of items) {
    adj.set(
      item.id,
      (item.dependsOn ?? []).filter((dep) => knownIds.has(dep))
    );
  }

  // DFS cycle detection: white=0 (unvisited), gray=1 (in stack), black=2 (done)
  const color = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string | null>();

  for (const item of items) {
    color.set(item.id, 0);
    parent.set(item.id, null);
  }

  let cyclePath: string[] | null = null;

  function dfs(nodeId: string, stack: string[]): boolean {
    color.set(nodeId, 1);
    stack.push(nodeId);

    for (const neighbor of adj.get(nodeId) ?? []) {
      if (color.get(neighbor) === 1) {
        // Found a back edge — extract the cycle
        const cycleStart = stack.indexOf(neighbor);
        cyclePath = [...stack.slice(cycleStart), neighbor];
        return true;
      }
      if (color.get(neighbor) === 0) {
        if (dfs(neighbor, stack)) return true;
      }
    }

    stack.pop();
    color.set(nodeId, 2);
    return false;
  }

  for (const item of items) {
    if (color.get(item.id) === 0) {
      if (dfs(item.id, [])) break;
    }
  }

  return cyclePath;
}

/**
 * Assigns wave numbers to work items using Kahn's algorithm (BFS topological sort).
 *
 * Wave number = longest path from any root to this node.
 * Items with no dependencies (or only dangling/unknown dependencies) get wave 0.
 *
 * Throws if circular dependencies are detected.
 */
export function assignWaves(items: WaveSchedulerInput[]): WaveAssignment[] {
  if (items.length === 0) return [];

  // Check for cycles first — provides a descriptive error with the cycle path
  const cycle = detectCircularDependencies(items);
  if (cycle !== null) {
    throw new Error(
      `Circular dependency detected in work item DAG. Cycle: ${cycle.join(" → ")}`
    );
  }

  const knownIds = new Set(items.map((item) => item.id));

  // Build adjacency list and in-degree map, ignoring dangling references
  const inDegree = new Map<string, number>();
  // adj[A] = list of items that depend on A (i.e., A → B means B depends on A)
  const dependents = new Map<string, string[]>();

  for (const item of items) {
    if (!inDegree.has(item.id)) inDegree.set(item.id, 0);
    if (!dependents.has(item.id)) dependents.set(item.id, []);
  }

  for (const item of items) {
    const validDeps = (item.dependsOn ?? []).filter((dep) =>
      knownIds.has(dep)
    );
    inDegree.set(item.id, validDeps.length);
    for (const dep of validDeps) {
      dependents.get(dep)!.push(item.id);
    }
  }

  // Kahn's BFS: start with all nodes that have in-degree 0
  const waveNumbers = new Map<string, number>();
  const queue: string[] = [];

  for (const item of items) {
    if (inDegree.get(item.id) === 0) {
      queue.push(item.id);
      waveNumbers.set(item.id, 0);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentWave = waveNumbers.get(current)!;

    for (const dependentId of dependents.get(current) ?? []) {
      // Update wave number for dependent: max of all dependency waves + 1
      const existingWave = waveNumbers.get(dependentId) ?? 0;
      const proposedWave = currentWave + 1;
      waveNumbers.set(dependentId, Math.max(existingWave, proposedWave));

      // Decrement in-degree; enqueue when all dependencies are processed
      inDegree.set(dependentId, inDegree.get(dependentId)! - 1);
      if (inDegree.get(dependentId) === 0) {
        queue.push(dependentId);
      }
    }
  }

  // Build result array, preserving input order
  const itemMap = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => ({
    workItemId: item.id,
    waveNumber: waveNumbers.get(item.id) ?? 0,
    dependsOn: (item.dependsOn ?? []).filter((dep) => knownIds.has(dep)),
    filesBeingModified: item.filesBeingModified ?? [],
  }));
}
```

### Step 2: Create `lib/wave-scheduler.test.ts`

Create the test file. Check what test runner the project uses first:

```bash
cat package.json | grep -E '"test"|"jest"|"vitest"'
```

Then create `lib/wave-scheduler.test.ts`:

```typescript
import { assignWaves, detectCircularDependencies, WaveSchedulerInput } from "./wave-scheduler";

// Helper to build a minimal WaveSchedulerInput
function makeItem(
  id: string,
  dependsOn: string[] = [],
  filesBeingModified: string[] = []
): WaveSchedulerInput {
  return { id, dependsOn, filesBeingModified, createdAt: new Date("2024-01-01") };
}

// Helper to get a map of workItemId → waveNumber from results
function waveMap(
  items: WaveSchedulerInput[]
): Record<string, number> {
  const result = assignWaves(items);
  return Object.fromEntries(result.map((r) => [r.workItemId, r.waveNumber]));
}

describe("assignWaves", () => {
  describe("empty and single-item inputs", () => {
    it("returns empty array for empty input", () => {
      expect(assignWaves([])).toEqual([]);
    });

    it("assigns wave 0 to a single item with no dependencies", () => {
      const waves = waveMap([makeItem("A")]);
      expect(waves).toEqual({ A: 0 });
    });

    it("assigns wave 0 to a single item with an empty dependsOn array", () => {
      const waves = waveMap([makeItem("A", [])]);
      expect(waves).toEqual({ A: 0 });
    });
  });

  describe("items with no dependencies", () => {
    it("assigns wave 0 to all independent items", () => {
      const items = [makeItem("A"), makeItem("B"), makeItem("C")];
      const waves = waveMap(items);
      expect(waves).toEqual({ A: 0, B: 0, C: 0 });
    });
  });

  describe("linear chain", () => {
    it("assigns sequential waves to a linear dependency chain", () => {
      // A → B → C → D (D depends on C, C on B, B on A)
      const items = [
        makeItem("A"),
        makeItem("B", ["A"]),
        makeItem("C", ["B"]),
        makeItem("D", ["C"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(2);
      expect(waves.D).toBe(3);
    });

    it("handles items provided in reverse dependency order", () => {
      // Input order: D, C, B, A — output should still be correct
      const items = [
        makeItem("D", ["C"]),
        makeItem("C", ["B"]),
        makeItem("B", ["A"]),
        makeItem("A"),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(2);
      expect(waves.D).toBe(3);
    });
  });

  describe("diamond DAG", () => {
    it("correctly assigns wave 2 to the convergence node in a diamond", () => {
      // A → B, A → C, B → D, C → D
      // Wave: A=0, B=1, C=1, D=2
      const items = [
        makeItem("A"),
        makeItem("B", ["A"]),
        makeItem("C", ["A"]),
        makeItem("D", ["B", "C"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(1);
      expect(waves.D).toBe(2);
    });
  });

  describe("parallel branches", () => {
    it("assigns independent waves to parallel branches", () => {
      // Two separate chains: A→B→C and X→Y
      const items = [
        makeItem("A"),
        makeItem("B", ["A"]),
        makeItem("C", ["B"]),
        makeItem("X"),
        makeItem("Y", ["X"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(2);
      expect(waves.X).toBe(0);
      expect(waves.Y).toBe(1);
    });
  });

  describe("complex DAG — longest path wins", () => {
    it("assigns wave based on longest path when multiple paths reach same node", () => {
      // A=0, B=0, C depends on A (wave 1), D depends on B (wave 1), E depends on C and D
      // but also: F=0, G depends on F (wave 1), H depends on G (wave 2), E also depends on H
      // So E's wave = max(1, 1, 2) + 1 = 3
      const items = [
        makeItem("A"),
        makeItem("B"),
        makeItem("C", ["A"]),
        makeItem("D", ["B"]),
        makeItem("F"),
        makeItem("G", ["F"]),
        makeItem("H", ["G"]),
        makeItem("E", ["C", "D", "H"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(0);
      expect(waves.F).toBe(0);
      expect(waves.C).toBe(1);
      expect(waves.D).toBe(1);
      expect(waves.G).toBe(1);
      expect(waves.H).toBe(2);
      expect(waves.E).toBe(3);
    });
  });

  describe("dangling/unknown dependency references", () => {
    it("treats items with only unknown dependencies as wave 0", () => {
      // B depends on 'NONEXISTENT' which is not in the input set
      const items = [makeItem("A"), makeItem("B", ["NONEXISTENT"])];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(0);
    });

    it("filters out unknown dependency IDs from WaveAssignment.dependsOn", () => {
      const items = [makeItem("A"), makeItem("B", ["A", "GHOST"])];
      const results = assignWaves(items);
      const bResult = results.find((r) => r.workItemId === "B")!;
      expect(bResult.dependsOn).toEqual(["A"]);
      expect(bResult.waveNumber).toBe(1);
    });
  });

  describe("WaveAssignment output shape", () => {
    it("includes workItemId, waveNumber, dependsOn, and filesBeingModified", () => {
      const items = [
        makeItem("A", [], ["lib/foo.ts"]),
        makeItem("B", ["A"], ["lib/bar.ts", "lib/baz.ts"]),
      ];
      const results = assignWaves(items);

      expect(results).toHaveLength(2);

      const aResult = results.find((r) => r.workItemId === "A")!;
      expect(aResult.workItemId).toBe("A");
      expect(aResult.waveNumber).toBe(0);
      expect(aResult.dependsOn).toEqual([]);
      expect(aResult.filesBeingModified).toEqual(["lib/foo.ts"]);

      const bResult = results.find((r) => r.workItemId === "B")!;
      expect(bResult.workItemId).toBe("B");
      expect(bResult.waveNumber).toBe(1);
      expect(bResult.dependsOn).toEqual(["A"]);
      expect(bResult.filesBeingModified).toEqual(["lib/bar.ts", "lib/baz.ts"]);
    });

    it("preserves input order in the output array", () => {
      const items = [makeItem("C"), makeItem("A"), makeItem("B")];
      const results = assignWaves(items);
      expect(results.map((r) => r.workItemId)).toEqual(["C", "A", "B"]);
    });
  });

  describe("circular dependency detection — assignWaves throws", () => {
    it("throws on a simple two-node cycle", () => {
      const items = [makeItem("A", ["B"]), makeItem("B", ["A"])];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });

    it("throws on a three-node cycle", () => {
      const items = [
        makeItem("A", ["C"]),
        makeItem("B", ["A"]),
        makeItem("C", ["B"]),
      ];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });

    it("includes the cycle path in the error message", () => {
      const items = [makeItem("A", ["B"]), makeItem("B", ["A"])];
      let errorMessage = "";
      try {
        assignWaves(items);
      } catch (e) {
        errorMessage = (e as Error).message;
      }
      // Cycle path should mention both nodes
      expect(errorMessage).toMatch(/A/);
      expect(errorMessage).toMatch(/B/);
      expect(errorMessage).toMatch(/→/);
    });

    it("throws on a self-referencing item", () => {
      const items = [makeItem("A", ["A"])];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });

    it("throws even when cycle is embedded in a larger valid graph", () => {
      const items = [
        makeItem("Root"),
        makeItem("A", ["Root"]),
        makeItem("B", ["A", "C"]),
        makeItem("C", ["B"]), // B → C → B cycle
      ];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });
  });
});

describe("detectCircularDependencies", () => {
  it("returns null for an empty list", () => {
    expect(detectCircularDependencies([])).toBeNull();
  });

  it("returns null for a valid DAG", () => {
    const items = [
      makeItem("A"),
      makeItem("B", ["A"]),
      makeItem("C", ["A", "B"]),
    ];
    expect(detectCircularDependencies(items)).toBeNull();
  });

  it("returns the cycle path for a two-node cycle", () => {
    const items = [makeItem("A", ["B"]), makeItem("B", ["A"])];
    const cycle = detectCircularDependencies(items);
    expect(cycle).not.toBeNull();
    expect(Array.isArray(cycle)).toBe(true);
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    // The cycle array should start and end with the same node
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it("returns null when dependsOn references unknown IDs (no actual cycle)", () => {
    const items = [makeItem("A", ["UNKNOWN"]), makeItem("B", ["A"])];
    expect(detectCircularDependencies(items)).toBeNull();
  });

  it("returns cycle path for a self-reference", () => {
    const items = [makeItem("A", ["A"])];
    const cycle = detectCircularDependencies(items);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
  });
});
```

### Step 3: Verify test runner configuration

```bash
# Check what test framework is configured
cat package.json | grep -E 'jest|vitest|test'
ls jest.config* vitest.config* 2>/dev/null || true
```

If the project uses Jest, ensure `lib/wave-scheduler.test.ts` will be picked up by the existing test configuration. If the project uses Vitest, the same syntax applies. No configuration changes should be needed since these tests use standard `describe`/`it`/`expect` syntax compatible with both.

If no test runner is configured, check for existing test files to understand the pattern:

```bash
find . -name "*.test.ts" -not -path "*/node_modules/*" | head -5
```

### Step 4: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- If `tsconfig.json` uses `"strict": true`, ensure all function parameters are typed
- If `strictNullChecks` is enabled, the `?? []` fallbacks in the implementation handle this

### Step 5: Run tests

```bash
npm test -- --testPathPattern="wave-scheduler" 2>/dev/null || \
npx jest lib/wave-scheduler.test.ts 2>/dev/null || \
npx vitest run lib/wave-scheduler.test.ts
```

All tests must pass before proceeding.

### Step 6: Build verification

```bash
npm run build
```

### Step 7: Commit, push, open PR

```bash
git add lib/wave-scheduler.ts lib/wave-scheduler.test.ts
git commit -m "feat: implement wave scheduler algorithm (DAG topological sort)

- Add lib/wave-scheduler.ts with WaveAssignment interface, assignWaves,
  and detectCircularDependencies exports
- Implements Kahn's algorithm for BFS topological sort
- Wave number = longest path from root to node (max dependency wave + 1)
- Throws descriptive error with cycle path on circular dependency detection
- Gracefully handles dangling/unknown dependency references as wave 0
- Add comprehensive unit tests covering all DAG shapes and edge cases"

git push origin feat/wave-scheduler-algorithm

gh pr create \
  --title "feat: implement wave scheduler algorithm (DAG topological sort)" \
  --body "## Summary

Implements the core wave assignment algorithm for Agent Forge's wave-based dispatch system.

### What this adds
- \`lib/wave-scheduler.ts\`: Pure algorithmic module for DAG topological sort + wave assignment
- \`lib/wave-scheduler.test.ts\`: Comprehensive unit tests

### Algorithm
Uses **Kahn's algorithm** (BFS with in-degree tracking):
1. Build adjacency list from \`dependsOn\` arrays (ignoring dangling references)
2. Enqueue all nodes with in-degree 0 at wave 0
3. BFS: for each processed node, update dependents' wave = max(current wave + 1, existing wave)
4. Decrement in-degree; enqueue when all dependencies processed

Wave number = **longest path** from any root to the node, ensuring safe parallel dispatch within a wave.

### Exports
- \`WaveAssignment\` interface: \`{ workItemId, waveNumber, dependsOn, filesBeingModified }\`
- \`assignWaves(items)\`: Throws on circular deps; gracefully handles dangling refs
- \`detectCircularDependencies(items)\`: Returns cycle path or null

### Tests cover
- Empty input, single item, all-root items
- Linear chain (A→B→C→D)
- Diamond DAG (convergence node gets correct wave)
- Parallel independent branches
- Complex DAG (longest-path wins)
- Dangling/unknown dependency references (treated as wave 0)
- Circular dependency detection (2-node, 3-node, self-ref, embedded cycle)
- Output shape and input-order preservation

Closes: wave-scheduler work item
Related: \`waveNumber\` column added to \`work_items\` schema (merged)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "feat: partial wave-scheduler implementation (WIP)"
git push origin feat/wave-scheduler-algorithm
```

2. Open the PR with partial status:
```bash
gh pr create --title "feat: wave scheduler algorithm (partial)" --body "WIP — see execution notes"
```

3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wave-scheduler-algorithm
FILES CHANGED: lib/wave-scheduler.ts, lib/wave-scheduler.test.ts
SUMMARY: [what was completed]
ISSUES: [what failed — e.g., "TypeScript error in detectCircularDependencies return type", "Test runner not configured"]
NEXT STEPS: [e.g., "Fix tsc error on line 47", "Configure jest in package.json", "All tests pass except self-reference cycle test"]
```