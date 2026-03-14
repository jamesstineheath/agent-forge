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

1. Modify ATC section 4.5 to call `decomposeProject(project)` after transitioning to "Executing". Wrap in try/catch: on success, log a `"project_trigger"` event (verify this type exists in `ATCEvent.type` union in `lib/types.ts`; add it if missing) with the number of work items created. On failure, transition the project to "Failed" via `transitionToFailed`, log an error event, and escalate with the error details.
2. Add a `sendDecompositionSummary` function to `lib/gmail.ts` that sends an email summarizing the decomposition. Include: project title, number of work items created, dependency structure (which items depend on which), estimated total budget, and a link to the Agent Forge dashboard. Use the existing `sendEmail` helper pattern from gmail.ts.
3. Call `sendDecompositionSummary` after successful decomposition in section 4.5.
4. Create `scripts/test-project-e2e.ts` — a **manual** verification script (not CI) that performs a full end-to-end test:
   a. Find an existing Draft project with "E2E Test" in the title.
   b. Transition it to "Execute" status via `updateProjectStatus`.
   c. Run a single ATC cycle via `runATCCycle()`.
   d. Verify: project status is now "Executing", work items exist with `source.type === "project"` and valid dependency graph.
   e. Clean up: delete created work items, transition the test project back to "Draft".
   f. Log results and exit with appropriate code.
5. Cleanup must run in a `finally` block so it executes even on assertion failures.

## Execution Steps

### Step 0: Branch setup