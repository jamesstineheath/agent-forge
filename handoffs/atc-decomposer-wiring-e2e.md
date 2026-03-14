# Agent Forge -- ATC Project Trigger + Decomposer Wiring + E2E

## Metadata
- **Branch:** `feat/atc-decomposer-wiring-e2e`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts, lib/gmail.ts, scripts/test-project-e2e.ts

## Context

H14 (Plan Decomposer Core) added `decomposeProject()` in `lib/decomposer.ts`. H15 (Dependency-Aware Dispatch) added dependency enforcement and project completion detection. This handoff wires them together: when the ATC detects a Notion project with Status = "Execute", it calls the decomposer instead of just transitioning the status. It also adds a Gmail notification on decomposition completion and an E2E test.

**Both H14 and H15 are now merged (PRs #17 and #18).** This branch is based on main which includes both.

### Current behavior (section 4.5 of atc.ts)

The ATC's section 4.5 detects projects with Status = "Execute" and calls `transitionToExecuting(project)` to move them to "Executing". That's all it does today. The decomposer is not called.

### Target behavior

Section 4.5 should: transition to "Executing", then call `decomposeProject(project)`, then send a Gmail notification summarizing the decomposition results. If decomposition fails, transition the project to "Failed" and send an error notification.

### New files available from H14 and H15

- `lib/decomposer.ts`: exports `decomposeProject(project: Project): Promise<WorkItem[]>`
- `lib/types.ts`: `WorkItem.source.type` now includes `"project"`, `ATCEvent.type` includes `"dependency_block"`
- `lib/work-items.ts`: `getNextDispatchable` now respects dependencies, new `getBlockedByDependencies` helper
- `lib/projects.ts`: `transitionToComplete(project)` and `transitionToFailed(project)` now available
- `lib/notion.ts`: `fetchPageContent(pageId)` available for reading Notion page blocks

## Requirements

1. Modify ATC section 4.5 to call `decomposeProject(project)` after transitioning to "Executing". Wrap in try/catch: on success, log a `"project_trigger"` event with the number of work items created. On failure, transition the project to "Failed" via `transitionToFailed`, log an error event, and escalate with the error details.
2. Add a `sendDecompositionSummary` function to `lib/gmail.ts` that sends an email summarizing the decomposition. Include: project title, number of work items created, dependency structure (which items depend on which), estimated total budget, and a link to the Agent Forge dashboard. Use the existing `sendEmail` helper pattern from gmail.ts.
3. Call `sendDecompositionSummary` after successful decomposition in section 4.5.
4. Create `scripts/test-project-e2e.ts` that performs a full end-to-end test:
   a. Create a test project in the Notion Projects DB (or use an existing one) with Status = "Draft" and a Plan URL pointing to a real architecture spec page.
   b. Transition it to "Execute" status via `updateProjectStatus`.
   c. Run a single ATC cycle via `runATCCycle()`.
   d. Verify: project status is now "Executing", work items exist with `source.type === "project"` and valid dependency graph, first dispatchable item has been dispatched (status "executing" or "generating").
   e. Log results and exit with appropriate code.
5. The E2E test should clean up after itself: delete created work items (via `deleteWorkItem`), transition the test project back to "Draft" status.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-decomposer-wiring-e2e
```

### Step 1: Wire decomposer into ATC section 4.5

In `lib/atc.ts`, modify the project sweep section (section 4.5). Replace the simple transition loop:

```typescript
// Current code:
for (const project of executeProjects) {
  const success = await transitionToExecuting(project);
  if (success) {
    projectsTransitioned.push(project);
    events.push(makeEvent(
      "status_change", project.projectId, "Execute", "Executing",
      `Project "${project.title}" (${project.projectId}) transitioned to Executing`
    ));
  }
}
```

With decomposer integration:

```typescript
for (const project of executeProjects) {
  const success = await transitionToExecuting(project);
  if (!success) continue;

  events.push(makeEvent(
    "project_trigger", project.projectId, "Execute", "Executing",
    `Project "${project.title}" (${project.projectId}) transitioned to Executing`
  ));

  // Decompose the project into work items
  try {
    const { decomposeProject } = await import("./decomposer");
    const workItems = await decomposeProject(project);

    events.push(makeEvent(
      "project_trigger", project.projectId, undefined, undefined,
      `Project "${project.title}" decomposed into ${workItems.length} work items`
    ));

    // Send notification email
    try {
      const { sendDecompositionSummary } = await import("./gmail");
      await sendDecompositionSummary(project, workItems);
    } catch (emailErr) {
      console.error("[atc] Failed to send decomposition summary email:", emailErr);
      // Non-fatal: decomposition succeeded, email is nice-to-have
    }

    projectsTransitioned.push(project);
  } catch (decompErr) {
    const msg = decompErr instanceof Error ? decompErr.message : "Unknown error";
    console.error(`[atc] Decomposition failed for project ${project.projectId}:`, decompErr);

    // Transition to Failed
    const { transitionToFailed } = await import("./projects");
    await transitionToFailed(project);

    events.push(makeEvent(
      "error", project.projectId, "Executing", "Failed",
      `Project "${project.title}" decomposition failed: ${msg}`
    ));

    // Escalate
    try {
      const { escalate } = await import("./escalation");
      await escalate(
        project.projectId,
        `Plan decomposition failed: ${msg}`,
        0.9,
        { projectTitle: project.title, planUrl: project.planUrl, error: msg }
      );
    } catch (escErr) {
      console.error("[atc] Failed to escalate decomposition failure:", escErr);
    }
  }
}
```

### Step 2: Add sendDecompositionSummary to lib/gmail.ts

Add a new exported function. Follow the pattern of `sendEscalationEmail`:

```typescript
export async function sendDecompositionSummary(
  project: Project,
  workItems: WorkItem[]
): Promise<string | null> {
  const depSummary = workItems.map((item, i) => {
    const deps = item.dependencies.length > 0
      ? ` (depends on: ${item.dependencies.map(depId => {
          const dep = workItems.find(w => w.id === depId);
          return dep ? dep.title : depId;
        }).join(", ")})`
      : " (no dependencies)";
    return `${i + 1}. ${item.title} [${item.riskLevel} risk, ${item.complexity}]${deps}`;
  }).join("\n");

  const totalBudget = workItems.reduce((sum, item) => {
    const budgetMap = { simple: 3, moderate: 5, complex: 8 };
    return sum + (budgetMap[item.complexity] ?? 5);
  }, 0);

  const body = [
    `Project "${project.title}" (${project.projectId}) has been decomposed into ${workItems.length} work items.`,
    "",
    "Work items (in dependency order):",
    depSummary,
    "",
    `Estimated total budget: $${totalBudget}`,
    "",
    `Dashboard: https://agent-forge-phi.vercel.app`,
    "",
    "The first item with no dependencies will be dispatched on the next ATC cycle.",
  ].join("\n");

  const subject = `[Agent Forge] Project decomposed: ${project.title} (${workItems.length} items)`;

  return sendEmail(subject, body);
}
```

Import the `Project` and `WorkItem` types at the top of `lib/gmail.ts`. The `sendEmail` helper should already exist in gmail.ts (or adapt from the existing `sendEscalationEmail` pattern, which constructs a raw MIME message and sends via Gmail API).

### Step 3: Create scripts/test-project-e2e.ts

```typescript
import { runATCCycle } from "../lib/atc";
import { queryProjects, updateProjectStatus } from "../lib/notion";
import { listWorkItems, getWorkItem, deleteWorkItem } from "../lib/work-items";

async function main() {
  console.log("=== Project E2E Test ===\n");

  // Find or create a test project
  // For safety, use an existing Draft project or create one manually first
  const projects = await queryProjects("Draft");
  const testProject = projects.find(p => p.title.includes("E2E Test"));

  if (!testProject) {
    console.error("No Draft project with 'E2E Test' in title found.");
    console.error("Create a test project in Notion with Status=Draft and a Plan URL, then re-run.");
    process.exit(1);
  }

  console.log(`Using test project: ${testProject.title} (${testProject.projectId})`);
  console.log(`Plan URL: ${testProject.planUrl}`);

  // Transition to Execute
  console.log("\nTransitioning to Execute...");
  await updateProjectStatus(testProject.id, "Execute");

  // Run ATC cycle
  console.log("Running ATC cycle...");
  const state = await runATCCycle();
  console.log(`ATC cycle complete. Events: ${state.recentEvents.length}`);

  // Check results
  const updatedProjects = await queryProjects("Executing");
  const isExecuting = updatedProjects.some(p => p.projectId === testProject.projectId);
  console.log(`\nProject status is Executing: ${isExecuting}`);

  // Find work items for this project
  const allEntries = await listWorkItems({});
  const projectItemIds: string[] = [];
  for (const entry of allEntries) {
    const item = await getWorkItem(entry.id);
    if (item && item.source.type === "project" && item.source.sourceId === testProject.projectId) {
      projectItemIds.push(item.id);
      console.log(`  Work item: ${item.title} (${item.status}, deps: ${item.dependencies.length})`);
    }
  }

  console.log(`\nTotal work items created: ${projectItemIds.length}`);

  // Validate dependency graph
  let depsValid = true;
  for (const itemId of projectItemIds) {
    const item = await getWorkItem(itemId);
    if (!item) continue;
    for (const depId of item.dependencies) {
      if (!projectItemIds.includes(depId)) {
        console.error(`  Invalid dependency: ${item.title} depends on ${depId} (not in project)`);
        depsValid = false;
      }
    }
  }
  console.log(`Dependency graph valid: ${depsValid}`);

  // Cleanup
  console.log("\nCleaning up...");
  for (const itemId of projectItemIds) {
    await deleteWorkItem(itemId);
  }
  await updateProjectStatus(testProject.id, "Draft");
  console.log("Cleanup complete.");

  // Final verdict
  const passed = isExecuting && projectItemIds.length > 0 && depsValid;
  console.log(`\n=== ${passed ? "PASS" : "FAIL"} ===`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
```

### Step 4: Verification
```bash
npx tsc --noEmit
npm run build
```

### Step 5: Commit, push, open PR
```bash
git add lib/atc.ts lib/gmail.ts scripts/test-project-e2e.ts
git commit -m "feat: wire decomposer into ATC + E2E test (2e-3 H16)

- ATC section 4.5 now calls decomposeProject() on Execute projects
- Gmail notification on successful decomposition
- Decomposition failure transitions project to Failed + escalates
- E2E test script: project lifecycle from Execute through decomposition"
git push origin feat/atc-decomposer-wiring-e2e
gh pr create --title "feat: ATC decomposer wiring + E2E (Phase 2e-3, H16)" --body "## Summary
Wires the Plan Decomposer into the ATC project trigger and adds end-to-end testing.

## Changes
- `lib/atc.ts`: Section 4.5 calls decomposeProject, handles failure with escalation
- `lib/gmail.ts`: sendDecompositionSummary for notification emails
- `scripts/test-project-e2e.ts`: Full lifecycle E2E test

## Dependencies
Builds on H14 (PR #17) and H15 (PR #18), both merged.

## Testing
- TypeScript compiles cleanly
- Build succeeds
- E2E test validates full project lifecycle

Phase 2e-3 Handoff 16."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-decomposer-wiring-e2e
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
