# Agent Forge -- Dependency-Aware Dispatch + Project Lifecycle

## Metadata
- **Branch:** `feat/dependency-dispatch-lifecycle`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc.ts, lib/work-items.ts, lib/projects.ts, lib/notion.ts, lib/types.ts

## Context

The ATC currently dispatches work items based on priority and FIFO ordering within each repo. Work items have a `dependencies: string[]` field that exists in the type system but is never enforced at dispatch time. The Plan Decomposer (H14) will populate this field with ordered dependencies between work items generated from a project plan.

This handoff adds two capabilities:
1. **Dependency-aware dispatch**: Before dispatching a work item, the ATC checks that all items in its `dependencies` array have `status: "merged"`. Items with unmet dependencies are skipped.
2. **Project lifecycle management**: When all work items for a project reach terminal states (`"merged"` or `"parked"`), the project transitions to `"Complete"` or `"Failed"` in Notion.

This handoff is independent of H14 (Plan Decomposer Core). It only modifies existing infrastructure to respect the `dependencies` field and adds project status transitions. It can be developed and merged in parallel with H14.

### Existing patterns

**`getNextDispatchable(targetRepo)`** in `lib/work-items.ts` returns the highest-priority ready item for a repo. Currently filters by `status: "ready"` and `targetRepo`, sorts by priority then creation date.

**ATC auto-dispatch** (section 4 of `runATCCycle` in `lib/atc.ts`) calls `getNextDispatchable` per repo and dispatches the result. No dependency check exists.

**ATC project trigger** (section 4.5) detects `Status = "Execute"` projects and transitions them to `"Executing"`. No completion detection exists.

**`lib/projects.ts`** has `listProjects`, `getExecuteProjects`, and `transitionToExecuting`. No Complete/Failed transitions.

**`lib/notion.ts`** has `updateProjectStatus(pageId, status)` that updates the Status select property. Already supports any `ProjectStatus` value.

**ATCEvent types** include `"project_trigger"` for project status changes.

## Requirements

1. Modify `getNextDispatchable` in `lib/work-items.ts` to check dependencies: for each candidate item, load all items in its `dependencies` array and verify they all have `status: "merged"`. Skip items with unmet dependencies. This must work across repos (a work item in repo A can depend on a work item in repo B).
2. Add a new ATC event type `"dependency_block"` to the `ATCEvent.type` union in `lib/types.ts`. This event is logged when an item is skipped during dispatch because of unmet dependencies.
3. In the ATC auto-dispatch section (section 4), after `getNextDispatchable` returns an item, log a `"dependency_block"` event if the item was skipped due to dependencies (this happens inside `getNextDispatchable` now, so alternatively log when `getNextDispatchable` returns null for a repo that has ready items but they all have unmet deps).
4. Add `transitionToComplete(project)` and `transitionToFailed(project)` to `lib/projects.ts`. These call `updateProjectStatus` with `"Complete"` and `"Failed"` respectively.
5. Add a new ATC section (section 13, after the Gmail sections) for project completion detection:
   a. Query all projects with status `"Executing"` via `listProjects("Executing")`.
   b. For each executing project, find all work items with `source.type === "project"` and `source.sourceId === project.projectId`.
   c. If all work items are in terminal states (`"merged"`, `"parked"`, `"failed"`): if any are `"failed"` (not `"parked"`), transition project to `"Failed"`. Otherwise transition to `"Complete"`.
   d. Log a `"project_trigger"` event for each transition.
   e. If no work items exist for the project yet (decomposition hasn't happened or hasn't completed), skip it.
6. Add `"project_complete"` and `"project_failed"` to the ATCEvent type union for clarity (or reuse `"project_trigger"` with descriptive details, either is acceptable).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dependency-dispatch-lifecycle
```

### Step 1: Update ATCEvent type in lib/types.ts

Add `"dependency_block"` to the `ATCEvent.type` union:
```typescript
type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup" | "project_trigger" | "escalation" | "escalation_timeout" | "escalation_resolved" | "dependency_block";
```

### Step 2: Update getNextDispatchable in lib/work-items.ts

Modify the function to filter out items with unmet dependencies:

```typescript
export async function getNextDispatchable(targetRepo: string): Promise<WorkItem | null> {
  const entries = await listWorkItems({ status: "ready", targetRepo });
  if (entries.length === 0) return null;

  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  const valid = items.filter((i): i is WorkItem => i !== null);

  // Filter out items with unmet dependencies
  const dispatchable: WorkItem[] = [];
  for (const item of valid) {
    if (item.dependencies.length === 0) {
      dispatchable.push(item);
      continue;
    }
    // Check all dependencies are merged
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allMerged = depItems.every((dep) => dep !== null && dep.status === "merged");
    if (allMerged) {
      dispatchable.push(item);
    }
  }

  if (dispatchable.length === 0) return null;

  dispatchable.sort((a, b) => {
    const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pd !== 0) return pd;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  return dispatchable[0] ?? null;
}
```

Also export a helper to check if ready items exist but are blocked by dependencies (for ATC event logging):

```typescript
export async function getBlockedByDependencies(targetRepo: string): Promise<WorkItem[]> {
  const entries = await listWorkItems({ status: "ready", targetRepo });
  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  const valid = items.filter((i): i is WorkItem => i !== null);

  const blocked: WorkItem[] = [];
  for (const item of valid) {
    if (item.dependencies.length === 0) continue;
    const depItems = await Promise.all(item.dependencies.map((depId) => getWorkItem(depId)));
    const allMerged = depItems.every((dep) => dep !== null && dep.status === "merged");
    if (!allMerged) {
      blocked.push(item);
    }
  }
  return blocked;
}
```

### Step 3: Add dependency_block event logging to ATC

In section 4 of `lib/atc.ts`, after the auto-dispatch loop, add dependency block detection:

```typescript
// After the dispatch loop, check for dependency-blocked items
for (const repoEntry of repoIndex) {
  const repo = await getRepo(repoEntry.id);
  if (!repo) continue;
  const { getBlockedByDependencies } = await import("./work-items");
  const blocked = await getBlockedByDependencies(repo.fullName);
  for (const item of blocked) {
    const unmetDeps = [];
    for (const depId of item.dependencies) {
      const dep = await getWorkItem(depId);
      if (dep && dep.status !== "merged") {
        unmetDeps.push(`${dep.title} (${dep.status})`);
      }
    }
    events.push(makeEvent(
      "dependency_block",
      item.id,
      undefined,
      undefined,
      `Waiting on dependencies: ${unmetDeps.join(", ")}`
    ));
  }
}
```

### Step 4: Add project lifecycle transitions to lib/projects.ts

```typescript
export async function transitionToComplete(project: Project): Promise<boolean> {
  return updateProjectStatus(project.id, "Complete");
}

export async function transitionToFailed(project: Project): Promise<boolean> {
  return updateProjectStatus(project.id, "Failed");
}
```

### Step 5: Add project completion detection to ATC (section 13)

Add a new section after the Gmail reminder section (section 12) in `lib/atc.ts`:

```typescript
// Section 13: Project completion detection
try {
  const { listProjects, transitionToComplete, transitionToFailed } = await import("./projects");
  const executingProjects = await listProjects("Executing");

  for (const project of executingProjects) {
    // Find all work items for this project
    const allItems = await listWorkItems({}); // Get all work item entries
    const projectItems: WorkItem[] = [];
    for (const entry of allItems) {
      const item = await getWorkItem(entry.id);
      if (item && item.source.type === "project" && item.source.sourceId === project.projectId) {
        projectItems.push(item);
      }
    }

    // Skip if no work items yet (decomposition pending)
    if (projectItems.length === 0) continue;

    const terminalStatuses = ["merged", "parked", "failed"];
    const allTerminal = projectItems.every((item) => terminalStatuses.includes(item.status));
    if (!allTerminal) continue;

    const hasFailed = projectItems.some((item) => item.status === "failed");
    if (hasFailed) {
      await transitionToFailed(project);
      events.push(makeEvent(
        "project_trigger",
        project.projectId,
        "Executing",
        "Failed",
        `Project "${project.title}" failed: ${projectItems.filter(i => i.status === "failed").length} work items failed`
      ));
    } else {
      await transitionToComplete(project);
      events.push(makeEvent(
        "project_trigger",
        project.projectId,
        "Executing",
        "Complete",
        `Project "${project.title}" complete: ${projectItems.filter(i => i.status === "merged").length} merged, ${projectItems.filter(i => i.status === "parked").length} parked`
      ));
    }
  }
} catch (err) {
  console.error("[atc] Project completion detection failed:", err);
}
```

Note: Use `listWorkItems({})` (no filters) to get all index entries rather than exporting the internal `loadIndex` function.

### Step 6: Verification
```bash
npx tsc --noEmit
npm run build
```

### Step 7: Commit, push, open PR
```bash
git add lib/atc.ts lib/work-items.ts lib/projects.ts lib/types.ts
git commit -m "feat: dependency-aware dispatch + project lifecycle (2e-3 H15)

- getNextDispatchable now checks all dependencies are merged before dispatch
- New dependency_block ATC event type for visibility
- Project completion detection: Executing projects transition to Complete/Failed
  when all work items reach terminal states
- transitionToComplete and transitionToFailed in projects.ts"
git push origin feat/dependency-dispatch-lifecycle
gh pr create --title "feat: dependency-aware dispatch + project lifecycle (Phase 2e-3, H15)" --body "## Summary
Adds dependency enforcement to work item dispatch and project lifecycle management.

## Changes
- `lib/work-items.ts`: getNextDispatchable checks dependencies are merged; new getBlockedByDependencies helper
- `lib/atc.ts`: dependency_block event logging; section 13 project completion detection
- `lib/projects.ts`: transitionToComplete, transitionToFailed
- `lib/types.ts`: dependency_block event type

## Testing
- TypeScript compiles cleanly
- Build succeeds
- Dependency check is purely additive (items with empty dependencies array behave identically to before)

Phase 2e-3 Handoff 15. Independent of H14."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dependency-dispatch-lifecycle
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
