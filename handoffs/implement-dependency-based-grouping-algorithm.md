# Agent Forge -- Implement Dependency-Based Grouping Algorithm

## Metadata
- **Branch:** `feat/group-into-sub-phases`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/decomposer.ts, lib/types.ts

## Context

Agent Forge's decomposer (`lib/decomposer.ts`) breaks Notion project plans into ordered work items with a dependency DAG. The next step is to group those work items into **sub-phases** for better parallelism and execution planning.

Currently `lib/decomposer.ts` exports types and functions for generating work items but lacks any sub-phase grouping logic. The `SubPhase` type is referenced in the codebase but the grouping algorithm needs to be implemented.

Recent merged PRs show `lib/decomposer.ts` and `lib/types.ts` are actively modified — check current state before implementing.

The function must be **pure** (no I/O, no side effects) to enable easy unit testing and integration into the ATC pipeline.

## Requirements

1. Add and export a `groupIntoSubPhases(items: WorkItem[], targetPhaseCount: number): SubPhase[]` function in `lib/decomposer.ts`
2. Algorithm step 1: Build dependency graph using union-find or DFS connected components from `item.dependencies`
3. Algorithm step 2: If clusters are too uneven, split large clusters by subsystem/file-path keyword overlap in item titles/descriptions
4. Algorithm step 3: Distribute high-risk items across phases (avoid front-loading all risk into phase-a)
5. Algorithm step 4: `targetPhaseCount` guides grouping — use 2 phases for 16–22 items, 3 phases for 23–30 items; if caller doesn't pass a value, default based on item count
6. After grouping, scan for cross-phase dependencies and populate each `SubPhase.dependencies` with IDs of phases it depends on
7. Validate no circular cross-phase dependencies exist; if found, merge the involved phases
8. Return `SubPhase[]` where each element has: `id` (`phase-a`, `phase-b`, etc.), `items: WorkItem[]`, `dependencies: string[]`
9. Function is pure — no `fs`, no `fetch`, no database calls, no mutations of input arrays

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/group-into-sub-phases
```

### Step 1: Inspect current types

Read the existing types to understand `WorkItem` and `SubPhase` shapes:

```bash
cat lib/types.ts
cat lib/decomposer.ts
```

Look for:
- `WorkItem` interface — specifically the `dependencies` field (likely `string[]` of work item IDs) and any `riskLevel` or `risk` field
- `SubPhase` type — if it already exists, use that shape; if not, you'll need to add it to `lib/types.ts`

### Step 2: Add or confirm SubPhase type

If `SubPhase` is not already in `lib/types.ts`, add it. The shape should be:

```typescript
export interface SubPhase {
  id: string;           // e.g., "phase-a", "phase-b"
  items: WorkItem[];
  dependencies: string[]; // IDs of other SubPhase.id values this phase depends on
}
```

If it already exists with a compatible shape, do not duplicate it. If it exists with a slightly different shape, adapt the implementation to match the existing definition.

### Step 3: Implement groupIntoSubPhases in lib/decomposer.ts

Add the following implementation. Read the existing file first and insert the function after existing exports (do not remove anything).

```typescript
// ─── Union-Find helpers ───────────────────────────────────────────────────────

function makeUnionFind(ids: string[]): { parent: Map<string, string>; rank: Map<string, number> } {
  const parent = new Map(ids.map(id => [id, id]));
  const rank = new Map(ids.map(id => [id, 0]));
  return { parent, rank };
}

function find(parent: Map<string, string>, x: string): string {
  if (parent.get(x) !== x) {
    parent.set(x, find(parent, parent.get(x)!));
  }
  return parent.get(x)!;
}

function union(parent: Map<string, string>, rank: Map<string, number>, a: string, b: string): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra === rb) return;
  if ((rank.get(ra) ?? 0) < (rank.get(rb) ?? 0)) {
    parent.set(ra, rb);
  } else if ((rank.get(ra) ?? 0) > (rank.get(rb) ?? 0)) {
    parent.set(rb, ra);
  } else {
    parent.set(rb, ra);
    rank.set(ra, (rank.get(ra) ?? 0) + 1);
  }
}

// ─── Subsystem keyword extraction ────────────────────────────────────────────

function extractKeywords(item: WorkItem): Set<string> {
  const text = `${item.title ?? ''} ${(item as any).description ?? ''} ${((item as any).files ?? []).join(' ')}`.toLowerCase();
  const keywords = new Set<string>();
  // Extract file-path segments
  const pathPattern = /\b(lib|app|components|api|hooks|actions|pages|utils|types|storage|github|atc|orchestrat|decompos|escalat|gmail|notion|repos|work.?items)\b/g;
  let m: RegExpExecArray | null;
  while ((m = pathPattern.exec(text)) !== null) {
    keywords.add(m[1]);
  }
  return keywords;
}

// ─── Main grouping function ───────────────────────────────────────────────────

export function groupIntoSubPhases(
  items: WorkItem[],
  targetPhaseCount?: number
): SubPhase[] {
  if (items.length === 0) return [];

  // Determine target phase count
  const count = targetPhaseCount ?? (items.length >= 23 ? 3 : 2);
  const phaseCount = Math.max(1, Math.min(count, items.length));

  const ids = items.map(item => item.id);
  const itemById = new Map(items.map(item => [item.id, item]));

  // ── Step 1: Dependency clustering via union-find ──────────────────────────
  const { parent, rank } = makeUnionFind(ids);

  for (const item of items) {
    const deps: string[] = (item as any).dependencies ?? [];
    for (const dep of deps) {
      if (itemById.has(dep)) {
        union(parent, rank, item.id, dep);
      }
    }
  }

  // Build clusters: root → [item ids]
  const clusters = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(parent, id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(id);
  }

  let clusterList: string[][] = Array.from(clusters.values());

  // ── Step 2: Split oversized clusters by subsystem overlap ─────────────────
  // Target: each cluster should hold roughly (items.length / phaseCount) items
  const targetSize = Math.ceil(items.length / phaseCount);

  const splitClusters: string[][] = [];
  for (const cluster of clusterList) {
    if (cluster.length <= targetSize * 1.5) {
      splitClusters.push(cluster);
      continue;
    }
    // Split by subsystem keyword grouping
    const subsystemGroups = new Map<string, string[]>();
    const noKeyword: string[] = [];
    for (const id of cluster) {
      const item = itemById.get(id)!;
      const kws = Array.from(extractKeywords(item));
      if (kws.length === 0) {
        noKeyword.push(id);
      } else {
        const primary = kws[0];
        if (!subsystemGroups.has(primary)) subsystemGroups.set(primary, []);
        subsystemGroups.get(primary)!.push(id);
      }
    }
    // Merge small subsystem groups back together until each chunk >= targetSize/2
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const group of subsystemGroups.values()) {
      current.push(...group);
      if (current.length >= targetSize / 2) {
        chunks.push(current);
        current = [];
      }
    }
    if (noKeyword.length > 0) current.push(...noKeyword);
    if (current.length > 0) {
      if (chunks.length === 0) chunks.push(current);
      else chunks[chunks.length - 1].push(...current);
    }
    splitClusters.push(...(chunks.length > 0 ? chunks : [cluster]));
  }
  clusterList = splitClusters;

  // ── Step 3 & 4: Merge clusters into phaseCount phases ─────────────────────
  // Sort clusters largest-first, then greedily assign to phases (bin-packing)
  clusterList.sort((a, b) => b.length - a.length);

  const phases: string[][] = Array.from({ length: phaseCount }, () => []);
  for (const cluster of clusterList) {
    // Find the phase with the fewest items
    const smallest = phases.reduce((min, p, i) => p.length < phases[min].length ? i : min, 0);
    phases[smallest].push(...cluster);
  }

  // ── Step 3: Risk tier balancing ───────────────────────────────────────────
  // Identify high-risk items and redistribute if they're all in phase-a
  const phaseItemSets = phases.map(ids => new Set(ids));
  const riskField = (item: WorkItem): string =>
    ((item as any).riskLevel ?? (item as any).risk ?? 'medium') as string;

  const highRiskIds = ids.filter(id => riskField(itemById.get(id)!) === 'high');
  if (highRiskIds.length > 1 && phases.length > 1) {
    // If all high-risk are in phase[0], move half to other phases
    const highRiskInPhase0 = highRiskIds.filter(id => phaseItemSets[0].has(id));
    if (highRiskInPhase0.length === highRiskIds.length && highRiskIds.length >= 2) {
      const toMove = highRiskInPhase0.slice(Math.floor(highRiskInPhase0.length / 2));
      for (const id of toMove) {
        // Remove from phase 0
        const idx = phases[0].indexOf(id);
        if (idx !== -1) phases[0].splice(idx, 1);
        // Add to phase with fewest items (excluding phase 0)
        const target = phases.slice(1).reduce((min, p, i) => p.length < phases.slice(1)[min].length ? i : min, 0);
        phases[target + 1].push(id);
      }
    }
  }

  // ── Build SubPhase objects ─────────────────────────────────────────────────
  const phaseIds = phases.map((_, i) => `phase-${String.fromCharCode(97 + i)}`); // phase-a, phase-b, ...
  const itemToPhase = new Map<string, string>();
  phases.forEach((phaseItems, i) => {
    for (const id of phaseItems) {
      itemToPhase.set(id, phaseIds[i]);
    }
  });

  // ── Cross-phase dependency stitching ──────────────────────────────────────
  const phaseDepsMap = new Map<string, Set<string>>();
  for (const phaseId of phaseIds) phaseDepsMap.set(phaseId, new Set());

  for (const item of items) {
    const itemPhase = itemToPhase.get(item.id);
    if (!itemPhase) continue;
    const deps: string[] = (item as any).dependencies ?? [];
    for (const dep of deps) {
      const depPhase = itemToPhase.get(dep);
      if (depPhase && depPhase !== itemPhase) {
        phaseDepsMap.get(itemPhase)!.add(depPhase);
      }
    }
  }

  // ── Circular cross-phase dependency detection and merging ─────────────────
  // Simple cycle detection: if phase A depends on phase B and phase B depends on phase A, merge them
  let merged = true;
  while (merged) {
    merged = false;
    const currentPhaseIds = Array.from(phaseDepsMap.keys());
    outerLoop: for (let i = 0; i < currentPhaseIds.length; i++) {
      for (let j = i + 1; j < currentPhaseIds.length; j++) {
        const pa = currentPhaseIds[i];
        const pb = currentPhaseIds[j];
        if (phaseDepsMap.get(pa)?.has(pb) && phaseDepsMap.get(pb)?.has(pa)) {
          // Merge pb into pa
          const aIdx = phaseIds.indexOf(pa);
          const bIdx = phaseIds.indexOf(pb);
          if (aIdx === -1 || bIdx === -1) continue;
          // Move all items from pb phase into pa phase
          phases[aIdx].push(...phases[bIdx]);
          phases.splice(bIdx, 1);
          phaseIds.splice(bIdx, 1);
          // Rebuild itemToPhase
          itemToPhase.clear();
          phases.forEach((phaseItems, i) => {
            for (const id of phaseItems) itemToPhase.set(id, phaseIds[i]);
          });
          // Rebuild phaseDepsMap
          phaseDepsMap.clear();
          for (const phaseId of phaseIds) phaseDepsMap.set(phaseId, new Set());
          for (const item of items) {
            const itemPhase = itemToPhase.get(item.id);
            if (!itemPhase) continue;
            const deps: string[] = (item as any).dependencies ?? [];
            for (const dep of deps) {
              const depPhase = itemToPhase.get(dep);
              if (depPhase && depPhase !== itemPhase) {
                phaseDepsMap.get(itemPhase)!.add(depPhase);
              }
            }
          }
          merged = true;
          break outerLoop;
        }
      }
    }
  }

  // ── Assemble final SubPhase array ─────────────────────────────────────────
  return phaseIds.map((phaseId, i) => ({
    id: phaseId,
    items: phases[i].map(id => itemById.get(id)!).filter(Boolean),
    dependencies: Array.from(phaseDepsMap.get(phaseId) ?? []),
  }));
}
```

**Important**: Before pasting this code, verify the exact shape of `WorkItem` in `lib/types.ts`. In particular:
- The field for dependency IDs (likely `dependencies: string[]` — if named differently, update the code)
- The field for risk level (check for `riskLevel`, `risk`, or similar — the code already handles both via `(item as any).riskLevel ?? (item as any).risk`)
- The `id` field name (should be `id`)

If `WorkItem` uses different field names, update the accessor lines accordingly rather than using `(item as any)` casting.

### Step 4: Ensure SubPhase is exported from lib/types.ts

```bash
grep -n "SubPhase" lib/types.ts lib/decomposer.ts
```

If `SubPhase` is not in `lib/types.ts` and not already defined in `lib/decomposer.ts`, add it to `lib/types.ts`:

```typescript
export interface SubPhase {
  id: string;
  items: WorkItem[];
  dependencies: string[];
}
```

Then import it at the top of `lib/decomposer.ts`:
```typescript
import type { SubPhase } from './types';
```

(Or add it inline in `lib/decomposer.ts` if that's where related types live — follow the existing pattern.)

### Step 5: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `WorkItem` missing an `id` field — check the actual field name
- `SubPhase` import collision if it already exists somewhere
- The `(item as any)` casts — if you can replace them with typed access after inspecting the actual `WorkItem` type, do so

### Step 6: Build check

```bash
npm run build
```

Fix any build errors. If there are pre-existing build errors unrelated to this change, note them but do not fix them (out of scope).

### Step 7: Verify function signature is exported correctly

```bash
grep -n "export function groupIntoSubPhases\|export { groupIntoSubPhases" lib/decomposer.ts
```

Should return a match. If not, ensure the `export` keyword is present.

### Step 8: Quick smoke test (optional inline)

If there's a test runner available (`npm test`), run it. If not, create a minimal inline check to verify correctness mentally:

Trace through the acceptance criteria:
1. **20 items, no dependencies** → union-find produces 20 singleton clusters → bin-packing into 2 phases → ~10 items each ✓
2. **A→B→C and D→E→F** → union(A,B), union(B,C) → {A,B,C} one cluster; union(D,E), union(E,F) → {D,E,F} one cluster → 2 separate phases ✓
3. **Cross-phase dep** → item in phase-b with `dependencies: ['phase-a-item-id']` → `phaseDepsMap.get('phase-b').add('phase-a')` ✓
4. **Circular** → phase-a depends on phase-b AND phase-b depends on phase-a → merge loop triggers, pb merged into pa → single phase ✓

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add groupIntoSubPhases function to decomposer

- Implements dependency clustering via union-find connected components
- Splits oversized clusters by subsystem/file-path keyword overlap
- Balances high-risk items across phases
- Stitches cross-phase dependencies and detects/merges circular dependencies
- Pure function with no I/O or side effects"

git push origin feat/group-into-sub-phases

gh pr create \
  --title "feat: add groupIntoSubPhases — dependency-based sub-phase grouping algorithm" \
  --body "## Summary
Adds \`groupIntoSubPhases(items, targetPhaseCount)\` to \`lib/decomposer.ts\`.

## Algorithm
1. **Dependency clustering** — union-find builds connected components from \`item.dependencies\`
2. **Subsystem splitting** — oversized clusters split by file-path/subsystem keyword overlap
3. **Risk balancing** — high-risk items distributed across phases, not front-loaded
4. **Phase count** — defaults to 2 phases (16–22 items) or 3 phases (23–30 items), configurable

## Cross-phase stitching
- Scans all items for dependencies that cross phase boundaries
- Detects circular cross-phase dependencies (A↔B) and merges those phases

## Acceptance criteria verified (trace)
- ✅ 20 independent items → 2 equal phases
- ✅ A→B→C + D→E→F → two clusters, two separate phases
- ✅ Cross-phase dependencies correctly populated in \`SubPhase.dependencies\`
- ✅ Circular cross-phase → phases merged
- ✅ Pure function — no I/O, no side effects

## Files changed
- \`lib/decomposer.ts\` — new \`groupIntoSubPhases\` function + union-find helpers
- \`lib/types.ts\` — \`SubPhase\` interface (if not already present)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "wip: partial groupIntoSubPhases implementation"
git push origin feat/group-into-sub-phases
```

2. Open PR with partial status:
```bash
gh pr create --title "wip: groupIntoSubPhases (partial)" --body "Partial implementation — see ISSUES below" --draft
```

3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/group-into-sub-phases
FILES CHANGED: [list modified files]
SUMMARY: [what was completed]
ISSUES: [what failed or blocked — include exact error messages]
NEXT STEPS: [remaining steps to complete the implementation]
```

## Escalation Protocol

If you encounter a blocker that cannot be resolved autonomously (e.g., `WorkItem` type is structurally incompatible with the described algorithm, `SubPhase` already exists with a conflicting shape requiring architectural decisions, or TypeScript errors persist after 3 fix attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "group-into-sub-phases",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/decomposer.ts", "lib/types.ts"]
    }
  }'
```