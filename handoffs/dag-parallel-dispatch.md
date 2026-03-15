# Handoff: DAG-Aware Parallel Dispatch

Max Budget: $5 | Model: opus | Risk: medium

## Context

The ATC auto-dispatch loop (Section 4 of `lib/atc.ts`) currently dispatches at most ONE work item per repo per cycle, even when multiple items have all dependencies met and are ready to go. Combined with the decomposer prompt encouraging linear sequences, this serializes work that could run in parallel. For a project with 9 items in a dependency chain, items 2 and 3 might both be unblocked once item 1 merges, but only one gets dispatched per ATC cycle.

Three changes are needed:
1. The decomposer prompt should explicitly instruct Claude to maximize parallelism in the DAG
2. A new `getAllDispatchable` function should return ALL dispatchable items, not just one
3. The ATC dispatch loop should dispatch multiple items per repo per cycle (up to concurrency limits)

## Pre-flight Self-check

- [ ] Read `lib/decomposer.ts` lines 1-30 (SYSTEM_PROMPT) and lines 170-210 (buildUserPrompt)
- [ ] Read `lib/work-items.ts` function `getNextDispatchable` (around line 100-130)
- [ ] Read `lib/atc.ts` Section 4 auto-dispatch loop (search for `GLOBAL_CONCURRENCY_LIMIT`)
- [ ] Run `npm run build` to confirm current state compiles

## Step 0: Branch + Commit Setup

Branch: `fix/dag-parallel-dispatch` (already created)
Base: `main`

## Step 1: Update Decomposer Prompt to Maximize Parallelism

In `lib/decomposer.ts`, update the `SYSTEM_PROMPT` constant. Replace the line:
```
- Dependencies must form a DAG (no cycles)
```
With:
```
- Dependencies must form a DAG (no cycles). MAXIMIZE PARALLELISM: only add a dependency if item B truly cannot start until item A is merged. If two items touch different files or subsystems, they should have NO dependency between them even if one is "logically first". The pipeline can execute independent items concurrently.
- Prefer wide, shallow DAGs over deep linear chains. A 10-item plan with 3 parallel tracks of 3-4 items each is far better than a single 10-item sequence.
```

Also in the SYSTEM_PROMPT, replace:
```
Your job is to read an architecture
specification and break it into a sequence of small, independently executable work items.
```
With:
```
Your job is to read an architecture
specification and break it into a DAG of small, independently executable work items that maximizes parallel execution.
```

## Step 2: Add `getAllDispatchable` to work-items.ts

In `lib/work-items.ts`, add a new exported function after `getNextDispatchable`:

```typescript
export async function getAllDispatchable(targetRepo: string): Promise<WorkItem[]> {
  const entries = await listWorkItems({ status: "ready", targetRepo });
  if (entries.length === 0) return [];

  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  const valid = items.filter((i): i is WorkItem => i !== null);

  const dispatchable: WorkItem[] = [];
  for (const item of valid) {
    if (item.dependencies.length === 0) {
      dispatchable.push(item);
      continue;
    }
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allMerged = depItems.every((dep) => dep !== null && dep.status === "merged");
    if (allMerged) {
      dispatchable.push(item);
    }
  }

  // Sort by priority then creation time
  dispatchable.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return dispatchable;
}
```

Note: `PRIORITY_ORDER` is already defined in the file and in scope.

## Step 3: Update ATC Auto-Dispatch to Use Multi-Item Dispatch

In `lib/atc.ts`, first update the import at the top to include `getAllDispatchable`:
```typescript
import { listWorkItems, getWorkItem, updateWorkItem, getNextDispatchable, getAllDispatchable } from "./work-items";
```

Then in Section 4 (auto-dispatch), replace the entire block starting from `if (totalActive < GLOBAL_CONCURRENCY_LIMIT) {` through the closing `}` of that block with:

```typescript
if (totalActive < GLOBAL_CONCURRENCY_LIMIT) {
  let slotsRemaining = GLOBAL_CONCURRENCY_LIMIT - totalActive;

  for (const repoEntry of repoIndex) {
    if (slotsRemaining <= 0) break;
    const repo = await getRepo(repoEntry.id);
    if (!repo) continue;
    const activeCount = concurrencyMap.get(repo.fullName) ?? 0;
    const repoSlotsAvailable = repo.concurrencyLimit - activeCount;
    if (repoSlotsAvailable <= 0) continue;

    const candidates = await getAllDispatchable(repo.fullName);
    if (candidates.length === 0) continue;

    const toDispatch = candidates.slice(0, Math.min(slotsRemaining, repoSlotsAvailable));

    for (const item of toDispatch) {
      // Conflict check: skip if any active execution in this repo touches overlapping files
      const itemFiles = item.handoff?.content
        ? parseEstimatedFiles(item.handoff.content)
        : [];
      const repoActiveExecs = activeExecutions.filter(e => e.targetRepo === repo.fullName);
      const conflicting = repoActiveExecs.find(e => hasFileOverlap(itemFiles, e.filesBeingModified));
      if (conflicting) {
        events.push(makeEvent(
          "conflict", item.id, undefined, undefined,
          `Dispatch blocked: file overlap with active item ${conflicting.workItemId} in ${repo.fullName}`
        ));
        continue;
      }

      try {
        const result = await dispatchWorkItem(item.id);
        events.push(makeEvent(
          "auto_dispatch", item.id, "ready", "executing",
          `Auto-dispatched to ${repo.fullName} (branch: ${result.branch})`
        ));
        slotsRemaining--;
        // Update concurrency map for subsequent iterations this cycle
        concurrencyMap.set(repo.fullName, (concurrencyMap.get(repo.fullName) ?? 0) + 1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        events.push(makeEvent(
          "error", item.id, undefined, undefined,
          `Auto-dispatch failed: ${msg}`
        ));
      }
    }
  }
}
```

## Verification

- `npm run build` must pass
- `npx tsc --noEmit` must pass
- Grep for `getAllDispatchable` in `lib/atc.ts` to confirm the new function is imported and used
- Grep for `"sequence"` in `lib/decomposer.ts` to confirm the prompt wording was updated
- Read through the updated Section 4 logic to verify both global and per-repo concurrency limits are respected

## Abort Protocol

If `npm run build` fails due to type errors from the new function, check that the return type matches `WorkItem[]` and that the import path is correct. If the ATC dispatch logic introduces compile errors, revert Section 4 changes and ship Steps 1-2 only (the decomposer prompt improvement and new function are independently valuable).
