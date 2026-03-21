# Agent Forge -- Update Decomposer prompt for wide, shallow DAGs

## Metadata
- **Branch:** `feat/decomposer-wide-shallow-dags`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/decomposer.ts

## Context

The decomposer (`lib/decomposer.ts`) uses Claude to decompose project plans into work items with a dependency DAG. Currently the prompt does not explicitly guide Claude toward wide, shallow topologies — resulting in linear chains where items are unnecessarily serialized. This hurts throughput because the wave scheduler (recently merged, `lib/wave-scheduler.ts`) can only parallelize work items that have no dependency relationship.

The fix has two parts:
1. Update the Claude prompt to explicitly instruct fan-out, discouraging spurious dependencies
2. Add a `validateParallelismFactor` function that uses the wave scheduler to compute `items.length / totalWaves` and warns (+ optionally retries with a stronger prompt) when the factor is below 2.0 for projects with 8+ items

**Wave scheduler API** (from `lib/wave-scheduler.ts`, recently merged):
- The wave scheduler was implemented to compute topological sort / wave batches from a DAG of work items
- Review its exported API before implementing — it likely exports something like `computeWaves(items)` returning wave batches

**Key file to modify:** `lib/decomposer.ts`

**Related merged PRs:**
- `feat: implement wave scheduler algorithm (DAG topological sort)` — `lib/wave-scheduler.ts` and `lib/wave-scheduler.test.ts`
- `feat: add wave event types and emission helpers` — `lib/atc/events.ts`, `lib/atc/types.ts`

## Requirements

1. The decomposer prompt (system and/or user message sent to Claude) explicitly instructs Claude to produce wide, shallow DAGs with fan-out topologies
2. The prompt includes specific guidance:
   - Separate interface definitions from implementations
   - Group shared-nothing tasks at the same dependency level
   - Prefer fan-out over chains
   - Only add a dependency if item B truly cannot start until item A is merged
   - If two items touch different files/subsystems, they should have NO dependency
3. A `validateParallelismFactor` function is exported from `lib/decomposer.ts` with signature: `validateParallelismFactor(items: { dependsOn: string[] }[]): { factor: number; valid: boolean }`
   - Computes waves using the wave scheduler
   - `factor = items.length / totalWaves`
   - `valid = factor >= 2.0` for projects with 8+ items; always `true` for smaller projects
4. After decomposition, call `validateParallelismFactor`. If `!valid`, log a warning and perform one retry of the decomposition call with a stronger prompt emphasizing wide/shallow structure
5. The project builds successfully with no TypeScript type errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decomposer-wide-shallow-dags
```

### Step 1: Understand the existing decomposer and wave scheduler

Read the relevant files carefully before making changes:

```bash
cat lib/decomposer.ts
cat lib/wave-scheduler.ts
cat lib/wave-scheduler.test.ts
```

Key things to understand from `lib/wave-scheduler.ts`:
- What is the exported function signature? (e.g., `computeWaves`, `scheduleWaves`, etc.)
- What input format does it expect? (likely `{ id: string; dependsOn: string[] }[]` or similar)
- What does it return? (array of wave arrays, or an object with wave batches)

Key things to understand from `lib/decomposer.ts`:
- Where is the Claude prompt constructed? (system message, user message, or both)
- What is the return type of the decomposition function?
- How are work items structured? (id, title, dependsOn fields)
- How is Claude invoked? (which SDK, which model, etc.)
- Is there already a retry mechanism?

### Step 2: Add `validateParallelismFactor` function

After reviewing the wave scheduler API, add the following function to `lib/decomposer.ts`. Adapt the wave scheduler call to match its actual exported API:

```typescript
/**
 * Validates that a decomposed set of work items has sufficient parallelism.
 * For projects with 8+ items, the parallelism factor (items / waves) must be >= 2.0.
 * Smaller projects are always considered valid.
 *
 * @param items - Array of items with their dependency lists
 * @returns { factor: number; valid: boolean }
 */
export function validateParallelismFactor(
  items: { dependsOn: string[] }[]
): { factor: number; valid: boolean } {
  if (items.length === 0) {
    return { factor: 1, valid: true };
  }

  // Use the wave scheduler to compute how many waves/batches are needed.
  // Adapt the call below to match the actual wave-scheduler API you found in Step 1.
  // Example: if computeWaves returns an array of wave arrays:
  //   const waves = computeWaves(itemsWithIds);
  //   const totalWaves = waves.length;
  //
  // You must assign stable IDs to items if they don't have them.
  // The items passed here may not have IDs — create synthetic ones for this calculation.

  const itemsWithIds = items.map((item, idx) => ({
    id: `item-${idx}`,
    dependsOn: item.dependsOn,
  }));

  // TODO: call the actual wave scheduler here (fill in after Step 1)
  // const waves = computeWaves(itemsWithIds);
  // const totalWaves = waves.length || 1;

  // Fallback example — replace with real wave scheduler call:
  // const totalWaves = ...;
  const factor = items.length; // placeholder — divide by totalWaves
  const valid = items.length < 8 ? true : factor >= 2.0;

  return { factor, valid };
}
```

> **Important:** Do NOT use the placeholder above. After reading `lib/wave-scheduler.ts` in Step 1, write the real implementation that calls the wave scheduler correctly. The placeholder is only to show the shape.

The real implementation should look roughly like:

```typescript
import { computeWaves } from './wave-scheduler'; // adjust import to match actual export name

export function validateParallelismFactor(
  items: { dependsOn: string[] }[]
): { factor: number; valid: boolean } {
  if (items.length === 0) return { factor: 1, valid: true };

  const itemsWithIds = items.map((item, idx) => ({
    id: `item-${idx}`,
    dependsOn: item.dependsOn,
  }));

  const waves = computeWaves(itemsWithIds); // use actual API
  const totalWaves = Math.max(waves.length, 1);
  const factor = items.length / totalWaves;
  const valid = items.length < 8 ? true : factor >= 2.0;

  return { factor, valid };
}
```

### Step 3: Update the decomposer prompt

Locate the section in `lib/decomposer.ts` where the Claude prompt is constructed. Add explicit instructions for wide, shallow DAG topology.

**Find the existing prompt** (look for strings like `"system"`, `"user"`, `content:`, template literals, or `buildPrompt` helpers).

**Add the following instructions to the prompt** (integrate naturally into existing prompt structure — do not just append a block; weave it into the instructions):

```
## Dependency DAG Rules — Wide, Shallow Topologies

When assigning dependencies between work items, follow these rules strictly:

1. **Prefer fan-out over chains.** If multiple items can be worked on independently, they should ALL have no dependency on each other, even if they will eventually be integrated.

2. **Separate interface definitions from implementations.** If a shared type or interface must be defined first, make that one item, then ALL items that implement it can be parallel (they all depend on the interface item, not on each other).

3. **Group shared-nothing tasks at the same dependency level.** If two items touch different files or different subsystems, they MUST have NO dependency between them.

4. **Only add a dependency if truly required.** Ask: "Can item B start before item A is merged?" If yes — even if B would benefit from A — do NOT add the dependency. Only add `dependsOn: [A]` if B literally cannot compile or run without A being merged first.

5. **Never create chains for organizational convenience.** A chain A → B → C → D is almost always wrong. Prefer A → [B, C, D] (B, C, D all depend on A but not each other).

6. **Target parallelism factor >= 2.** If you have N work items, aim for them to be completable in at most N/2 sequential waves. A 10-item project should complete in 5 or fewer waves.

Example of WRONG (linear chain):
- Item 1: Define schema (no deps)
- Item 2: Add API route (depends on Item 1)
- Item 3: Add UI component (depends on Item 2)
- Item 4: Add tests (depends on Item 3)

Example of CORRECT (wide, shallow):
- Item 1: Define schema + types (no deps)
- Item 2: Add API route (depends on Item 1)
- Item 3: Add UI component (depends on Item 1)
- Item 4: Add unit tests for API (depends on Item 1)
- Item 5: Add integration tests (depends on Item 2, Item 3)
```

### Step 4: Add post-decomposition validation with one retry

After the existing decomposition logic produces a result, add the validation + retry. Find where the decomposed items array is returned and insert the validation before the return:

```typescript
// After decomposition produces `workItems` (adapt variable name to match actual code):

const validation = validateParallelismFactor(
  workItems.map(item => ({ dependsOn: item.dependsOn ?? [] }))
);

if (!validation.valid) {
  console.warn(
    `[Decomposer] Low parallelism factor: ${validation.factor.toFixed(2)} ` +
    `(${workItems.length} items / ${(workItems.length / validation.factor).toFixed(0)} waves). ` +
    `Retrying with stronger prompt...`
  );

  // Re-invoke Claude with a stronger prompt that prepends a parallelism reminder.
  // This is a one-time retry — do not recurse.
  // Adapt this to match how Claude is invoked in the existing decomposer:
  //
  // const retryResult = await decomposeWithClaude(plan, { strengthenParallelismPrompt: true });
  // return retryResult;
  //
  // If the decomposer function is structured so the Claude call is inline,
  // extract the retry call appropriately. The retry should pass an additional
  // system/user instruction like:
  //
  // "CRITICAL: The previous decomposition had too many sequential dependencies.
  //  Re-decompose with a parallelism factor of at least 2.0 (items/waves >= 2).
  //  Most items should be able to run in parallel. Only add dependencies when
  //  absolutely required for compilation correctness."
}
```

> **Note:** The retry structure depends heavily on how the existing decomposer is organized. If the Claude call is in a separate helper, pass a flag or extra prompt. If it's inline, you may need to extract it. Keep the change minimal — do not refactor the entire decomposer. The retry should NOT recurse (one retry max).

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- Wave scheduler import name mismatch — check exact export name with `grep -n "export" lib/wave-scheduler.ts`
- Items type mismatch — ensure the objects passed to `validateParallelismFactor` match the wave scheduler's input type
- Unused imports

### Step 6: Run existing tests

```bash
npm test -- --testPathPattern="wave-scheduler|decomposer" 2>&1 | head -80
```

If there are no decomposer tests, that's expected — do not create them (out of scope). Ensure wave-scheduler tests still pass.

### Step 7: Build

```bash
npm run build 2>&1 | tail -30
```

Resolve any build errors before committing.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: update decomposer prompt for wide shallow DAGs with parallelism validation"
git push origin feat/decomposer-wide-shallow-dags
gh pr create \
  --title "feat: update decomposer prompt for wide, shallow DAGs" \
  --body "## Summary

Updates the decomposer prompt in \`lib/decomposer.ts\` to explicitly instruct Claude to produce wide, shallow DAGs (fan-out topologies) rather than linear chains.

## Changes

### Prompt update (\`lib/decomposer.ts\`)
- Added explicit DAG rules section to Claude prompt covering:
  - Fan-out preference over chains
  - Separating interface definitions from implementations
  - Grouping shared-nothing tasks at same dependency level
  - Only adding dependencies when truly required for compilation correctness
  - Target parallelism factor >= 2

### New export: \`validateParallelismFactor\`
- Signature: \`validateParallelismFactor(items: { dependsOn: string[] }[]): { factor: number; valid: boolean }\`
- Computes waves via wave scheduler, returns \`items.length / totalWaves\`
- For 8+ item projects: \`valid = factor >= 2.0\`; always valid for smaller projects

### Post-decomposition validation
- After each decomposition, calls \`validateParallelismFactor\`
- If invalid, logs a warning with factor details
- Performs one retry with a stronger parallelism prompt

## Acceptance Criteria
- [x] Prompt explicitly instructs wide, shallow DAGs with fan-out
- [x] Prompt includes: separate interfaces, group shared-nothing tasks, only add required deps
- [x] \`validateParallelismFactor\` exported with correct signature
- [x] 8+ item projects with factor < 2.0 trigger warning log
- [x] Build passes with no type errors
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decomposer-wide-shallow-dags
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker you cannot resolve autonomously (e.g., wave scheduler API is incompatible with the items shape from decomposer, or the decomposer makes multiple Claude calls in a way that makes one-retry ambiguous):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "decomposer-wide-shallow-dags",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```