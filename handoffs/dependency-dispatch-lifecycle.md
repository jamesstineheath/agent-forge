# Agent Forge -- Dependency-Aware Dispatch + Project Lifecycle

## Metadata
- **Branch:** `feat/dependency-dispatch-lifecycle`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc.ts, lib/work-items.ts, lib/projects.ts, lib/types.ts

## Context

The ATC currently dispatches work items based on priority and FIFO ordering within each repo. Work items have a `dependencies: string[]` field that exists in the type system but is never enforced at dispatch time. The Plan Decomposer (H14) will populate this field with ordered dependencies between work items generated from a project plan.

This handoff adds two capabilities:
1. **Dependency-aware dispatch**: Before dispatching a work item, the ATC checks that all items in its `dependencies` array have `status: "merged"`. Items with unmet dependencies are skipped.
2. **Project lifecycle management**: When all work items for a project reach terminal states (`"merged"` or `"parked"`), the project transitions to `"Complete"` or `"Failed"` in Notion.

This handoff is independent of H14 (Plan Decomposer Core). It only modifies existing infrastructure to respect the `dependencies` field and adds project status transitions. It can be developed and merged in parallel with H14.

### Existing patterns

**`getNextDispatchable(targetRepo)`** in `lib/work-items.ts` returns the highest-priority ready item for a repo. Currently filters by `status: "ready"` and `targetRepo`, sorts by priority then creation date. Uses `PRIORITY_ORDER` constant for sorting.

**ATC auto-dispatch** (section 4 of `runATCCycle` in `lib/atc.ts`) calls `getNextDispatchable` per repo and dispatches the result. No dependency check exists.

**ATC project trigger** (section 4.5) detects `Status = "Execute"` projects and transitions them to `"Executing"`. No completion detection exists.

**`lib/projects.ts`** has `listProjects`, `getExecuteProjects`, and `transitionToExecuting`. No Complete/Failed transitions.

**`lib/notion.ts`** has `updateProjectStatus(pageId, status)` that updates the Status select property. Already supports any `ProjectStatus` value.

**ATCEvent types** include `"project_trigger"` for project status changes.

**`WorkItem.dependencies`** is typed as `string[]` (array of work item IDs). Older items may have this as an empty array. Handle defensively with `item.dependencies ?? []`.

## Requirements

1. Modify `getNextDispatchable` in `lib/work-items.ts` to check dependencies: for each candidate item, load all items in its `dependencies` array and verify they all have `status: "merged"`. Skip items with unmet dependencies. This must work across repos (a work item in repo A can depend on a work item in repo B).
2. Add a new ATC event type `"dependency_block"` to the `ATCEvent.type` union in `lib/types.ts`.
3. Add dependency-block event logging to the ATC auto-dispatch section: when `getNextDispatchable` returns null for a repo that has ready items blocked by dependencies, log `"dependency_block"` events.
4. Add `transitionToComplete(project)` and `transitionToFailed(project)` to `lib/projects.ts`.
5. Add a new ATC section (section 13) for project completion detection:
   a. Query all projects with status `"Executing"`.
   b. For each executing project, find all work items with matching `source.type === "project"` and `source.sourceId`.
   c. If no work items exist yet, skip (decomposition pending).
   d. If not all work items are terminal, skip (still in progress).
   e. If all are terminal: "Failed" if any have `status === "failed"`. "Complete" if at least one is `"merged"`. If all are `"parked"` with none merged, skip (stalled project, not complete).
   f. Log a `"project_trigger"` event for each transition.

## Execution Steps

### Step 0: Pre-flight checks