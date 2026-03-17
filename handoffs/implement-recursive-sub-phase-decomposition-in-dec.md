# Agent Forge -- Implement Recursive Sub-Phase Decomposition in Decomposer

## Metadata
- **Branch:** `feat/recursive-subphase-decomposition`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/decomposer.ts

## Context

Agent Forge's `lib/decomposer.ts` converts Notion project plans into ordered work items with a dependency DAG. A `getDecomposerConfig()` function (recently added) exposes configurable limits: `softLimit` (15), `hardLimit` (30), and `maxRecursionDepth` (1).

A `groupIntoSubPhases(items, targetPhaseCount)` function was also recently added — it clusters work items into sub-phases using dependency-based grouping.

Currently, the main decompose entry point only handles two cases: ≤15 items (proceed normally) or >30 items (escalate). The gap of 16-30 items is unhandled. This work item adds the recursive sub-phase decomposition logic for that middle range.

The key invariants:
- The ≤15 path must be **completely unchanged**
- The >30 path must be **completely unchanged**
- New logic is guarded behind `softLimit < N <= hardLimit`

## Requirements

1. After initial decomposition, check item count against `getDecomposerConfig()` limits
2. If `N <= softLimit`: existing behavior, no change
3. If `N > hardLimit`: existing escalation behavior, no change
4. If `softLimit < N <= hardLimit`:
   a. Call `groupIntoSubPhases(items, targetPhaseCount)` to cluster items into sub-phases
   b. For each sub-phase, validate item count ≤ softLimit
   c. If a sub-phase exceeds softLimit at recursion depth 0: attempt one recursive re-decomposition of that sub-phase
   d. If a sub-phase exceeds softLimit at depth ≥ `maxRecursionDepth` (1): escalate with message `Sub-phase '{name}' still has {count} items after recursive decomposition. Manual intervention needed.`
   e. Stitch cross-phase dependencies into work items' dependency arrays
   f. Assign proportional budgets: phase budget = `totalBudget * (phaseItemCount / totalItemCount)`
   g. Generate phase IDs using parent project ID suffix pattern: `PRJ-9` → `PRJ-9-a`, `PRJ-9-b`, etc.
   h. Return flattened list of all work items across all phases with dependencies wired
5. Unit tests or inline verification that the three code paths are exercised correctly

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/recursive-subphase-decomposition
```

### Step 1: Read and understand existing decomposer code

Read the full current state of `lib/decomposer.ts` to understand:
- The exact function signature of the main entry point (likely `decompose()`)
- How `getDecomposerConfig()` is used (or needs to be used)
- The `groupIntoSubPhases()` function signature and return type
- How escalation is currently triggered (look for `escalate` calls or throws)
- How work items are structured (`WorkItem` type from `lib/types.ts`)
- How `targetPhaseCount` should be computed (likely `Math.ceil(N / softLimit)`)

```bash
cat lib/decomposer.ts
cat lib/types.ts
```

### Step 2: Identify integration points

Before writing any code, identify:
1. The exact line(s) where the `> hardLimit` escalation check currently lives
2. The return type of `groupIntoSubPhases` — what does a "sub-phase" look like? (array of items? object with name + items?)
3. Whether `decompose()` receives a `projectId` and `totalBudget` parameter (needed for phase ID generation and budget allocation)
4. Whether there's a `WorkItem` dependency field (likely `dependencies: string[]`)

### Step 3: Implement the sub-phase decomposition logic

Add a private helper function `decomposeWithSubPhases` and integrate it into the main flow. The implementation should follow this pattern (adapt to actual signatures found in Step 1-2):

```typescript
// Helper: generate alphabetic suffix for phase index (0→'a', 1→'b', etc.)
function phaseLabel(index: number): string {
  return String.fromCharCode(97 + index); // 'a', 'b', 'c', ...
}

// Helper: stitch cross-phase dependencies
// For each work item, if it depends on an item in a different sub-phase,
// ensure the dependency ID refers to the correct item ID in the flattened list.
// (If dependency IDs are already stable item IDs, this may be a no-op verification pass.)
function stitchCrossPhaseDeps(
  phases: Array<{ name: string; items: WorkItem[] }>
): WorkItem[] {
  // Build a map of all item IDs across all phases
  const allItemIds = new Set<string>();
  for (const phase of phases) {
    for (const item of phase.items) {
      allItemIds.add(item.id);
    }
  }
  // Flatten and validate — cross-phase deps already reference real IDs
  return phases.flatMap((phase) => phase.items);
}
```

In the main `decompose()` function, after the initial items array is produced, insert the branching logic:

```typescript
const config = getDecomposerConfig();
const { softLimit, hardLimit, maxRecursionDepth } = config;

if (items.length <= softLimit) {
  // EXISTING PATH — DO NOT MODIFY
  return items;
}

if (items.length > hardLimit) {
  // EXISTING ESCALATION PATH — DO NOT MODIFY
  // (whatever is currently here)
}

// NEW: softLimit < items.length <= hardLimit
const targetPhaseCount = Math.ceil(items.length / softLimit);
return await decomposeSubPhases(
  items,
  targetPhaseCount,
  projectId,
  totalBudget,
  softLimit,
  maxRecursionDepth,
  0 // initial recursion depth
);
```

Implement `decomposeSubPhases`:

```typescript
async function decomposeSubPhases(
  items: WorkItem[],
  targetPhaseCount: number,
  projectId: string,
  totalBudget: number,
  softLimit: number,
  maxRecursionDepth: number,
  depth: number
): Promise<WorkItem[]> {
  const phases = groupIntoSubPhases(items, targetPhaseCount);
  const totalItemCount = items.length;
  const result: WorkItem[] = [];

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const phaseId = `${projectId}-${phaseLabel(i)}`;
    const phaseBudget = totalBudget * (phase.items.length / totalItemCount);

    // Assign phase IDs and proportional budgets to items
    const phasedItems = phase.items.map((item) => ({
      ...item,
      // Tag with phase context if applicable
      phaseId,
      budget: phaseBudget / phase.items.length, // per-item budget share
    }));

    if (phasedItems.length <= softLimit) {
      result.push(...phasedItems);
    } else if (depth >= maxRecursionDepth) {
      // Escalate: sub-phase still too large after max recursion
      throw new Error(
        `Sub-phase '${phase.name}' still has ${phasedItems.length} items after recursive decomposition. Manual intervention needed.`
      );
    } else {
      // Recurse once
      const recursedItems = await decomposeSubPhases(
        phasedItems,
        Math.ceil(phasedItems.length / softLimit),
        phaseId,
        phaseBudget,
        softLimit,
        maxRecursionDepth,
        depth + 1
      );
      result.push(...recursedItems);
    }
  }

  // Stitch cross-phase dependencies (validate all dep IDs exist)
  return stitchCrossPhaseDeps(result);
}
```

**Important:** Adapt the above pseudocode to match the actual types, function signatures, and patterns in the existing file. Do not blindly copy-paste — read the actual code first.

### Step 4: Handle escalation correctly

Look at how escalation is currently done in the `> hardLimit` case. The new sub-phase escalation (depth ≥ maxRecursionDepth) should use the **same escalation mechanism**, not just throw. If the existing code calls a `createEscalation()` function or similar, use that. If it throws with a specific error type, match that pattern.

### Step 5: Edge cases to handle

- `groupIntoSubPhases` may return fewer phases than `targetPhaseCount` — handle gracefully
- Phase label should handle > 26 phases (unlikely but use `aa`, `ab`, etc. if needed — or just cap at 26 and escalate beyond that)
- If `totalBudget` is undefined/null/0, skip budget allocation (don't divide by zero)
- If `projectId` is undefined, use a fallback like `"phase"` for the prefix

### Step 6: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build

# If tests exist
npm test
```

Check for TypeScript errors in `lib/decomposer.ts` specifically:
```bash
npx tsc --noEmit 2>&1 | grep decomposer
```

### Step 7: Manual trace through the logic

After implementation, mentally trace these scenarios:

1. **N=10 (≤ softLimit=15)**: hits the `<= softLimit` branch → existing path, no change ✓
2. **N=35 (> hardLimit=30)**: hits the `> hardLimit` branch → existing escalation, no change ✓
3. **N=20 (16-30)**: `targetPhaseCount=2`, `groupIntoSubPhases` called, each phase ≤15 → flattened result returned ✓
4. **N=25, one phase has 16 items at depth=0**: recursive call with depth=1 ✓
5. **N=25, one phase has 16 items at depth=1 (= maxRecursionDepth)**: escalation with descriptive message ✓

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: implement recursive sub-phase decomposition in decomposer

- Add decomposeSubPhases() helper for 16-30 item range
- Call groupIntoSubPhases() to cluster items, then validate each phase <= softLimit
- Recurse up to maxRecursionDepth (1) for oversized sub-phases
- Escalate with descriptive message if sub-phase still oversized after recursion
- Assign proportional budgets: phaseBudget = totalBudget * (phaseItems / totalItems)
- Generate phase IDs as parent project ID + alpha suffix (PRJ-9-a, PRJ-9-b, etc.)
- Stitch cross-phase dependencies in flattened output
- Existing <= 15 and > 30 code paths completely unchanged"

git push origin feat/recursive-subphase-decomposition

gh pr create \
  --title "feat: implement recursive sub-phase decomposition in decomposer" \
  --body "## Summary

Adds the 16-30 item middle path in \`lib/decomposer.ts\` that was previously unhandled.

## Changes

- \`lib/decomposer.ts\`: Added \`decomposeSubPhases()\` helper and integrated branching logic into main entry point

## Behavior

| Item count | Behavior |
|---|---|
| ≤ 15 | Existing path, no change |
| 16-30 | Group into sub-phases, validate, recurse once if needed |
| 31+ | Existing escalation, no change |

## Sub-phase flow
1. \`groupIntoSubPhases(items, ceil(N/15))\` clusters items
2. Each phase validated against softLimit (15)
3. Oversized phase at depth 0: recursive re-decomposition
4. Oversized phase at depth ≥ 1: escalate with message \`Sub-phase '{name}' still has {count} items after recursive decomposition. Manual intervention needed.\`
5. Phase IDs: \`{projectId}-a\`, \`{projectId}-b\`, etc.
6. Budget: \`totalBudget * (phaseItemCount / totalItemCount)\`
7. Cross-phase dependencies stitched in flattened output

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/recursive-subphase-decomposition
FILES CHANGED: [lib/decomposer.ts]
SUMMARY: [what was done]
ISSUES: [what failed or is ambiguous]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker (e.g., `groupIntoSubPhases` has an unexpected return type, escalation mechanism is not what's expected, `WorkItem` type is missing fields needed for phase tagging):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "recursive-subphase-decomposition",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```