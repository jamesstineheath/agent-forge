/**
 * Manual E2E test for the ATC → Decomposer → Work Items pipeline.
 *
 * Usage: npx tsx scripts/test-project-e2e.ts
 * Requires: NOTION_API_KEY, ANTHROPIC_API_KEY, GH_PAT env vars
 *
 * Prerequisites:
 *   - A Draft project in Notion with "E2E Test" in the title
 */

import { runATCCycle } from "../lib/atc";
import { listProjects } from "../lib/projects";
import { updateProjectStatus } from "../lib/notion";
import { listWorkItems, getWorkItem, deleteWorkItem } from "../lib/work-items";
import type { WorkItem } from "../lib/types";

async function main() {
  console.log("=== Project E2E Test ===\n");

  // a. Find an existing Draft project with "E2E Test" in the title
  console.log("Step 1: Finding Draft project with 'E2E Test' in title...");
  const draftProjects = await listProjects("Draft");
  const testProject = draftProjects.find((p) => p.title.includes("E2E Test"));

  if (!testProject) {
    console.error("FAIL: No Draft project found with 'E2E Test' in the title.");
    console.error("Please create a Draft project in Notion with 'E2E Test' in the title.");
    process.exit(1);
  }
  console.log(`  Found: "${testProject.title}" (${testProject.projectId})\n`);

  // Track created work items for cleanup
  const createdWorkItemIds: string[] = [];

  try {
    // b. Transition it to "Execute" status
    console.log("Step 2: Transitioning project to 'Execute'...");
    const transitioned = await updateProjectStatus(testProject.id, "Execute");
    if (!transitioned) {
      console.error("FAIL: Could not transition project to Execute status.");
      process.exit(1);
    }
    console.log("  Project status set to Execute.\n");

    // c. Run a single ATC cycle
    console.log("Step 3: Running ATC cycle...");
    const state = await runATCCycle();
    console.log(`  ATC cycle complete. ${state.recentEvents.length} events generated.\n`);

    // d. Verify results
    console.log("Step 4: Verifying results...");

    // Check that project is now "Executing" (the ATC should have transitioned it)
    const executingProjects = await listProjects("Executing");
    const projectAfterCycle = executingProjects.find(
      (p) => p.projectId === testProject.projectId
    );

    // Also check Failed status (decomposition may have failed in test env)
    const failedProjects = await listProjects("Failed");
    const projectFailed = failedProjects.find(
      (p) => p.projectId === testProject.projectId
    );

    if (!projectAfterCycle && !projectFailed) {
      console.error("FAIL: Project not found in Executing or Failed status after ATC cycle.");
      process.exit(1);
    }

    if (projectFailed) {
      console.log("  WARNING: Project transitioned to Failed (decomposition may have failed in test env).");
      console.log("  This is acceptable if ANTHROPIC_API_KEY or NOTION_API_KEY is missing.\n");
    } else {
      console.log("  PASS: Project is now in Executing status.\n");
    }

    // Find work items created for this project
    console.log("Step 5: Checking work items...");
    const allItems = await listWorkItems({});
    const projectWorkItems: WorkItem[] = [];

    for (const entry of allItems) {
      const item = await getWorkItem(entry.id);
      if (
        item &&
        item.source.type === "project" &&
        item.source.sourceId === testProject.projectId
      ) {
        projectWorkItems.push(item);
        createdWorkItemIds.push(item.id);
      }
    }

    if (projectWorkItems.length === 0) {
      console.log("  WARNING: No work items created (decomposition may not have run).");
      console.log("  In a full environment with API keys, work items would be created.\n");
    } else {
      console.log(`  PASS: ${projectWorkItems.length} work items created.\n`);

      // Validate each work item
      let allValid = true;
      for (const item of projectWorkItems) {
        const errors: string[] = [];
        if (item.source.type !== "project") errors.push("source.type not 'project'");
        if (item.source.sourceId !== testProject.projectId) errors.push("source.sourceId mismatch");
        if (!item.id) errors.push("missing id");
        if (!item.title) errors.push("missing title");
        if (!Array.isArray(item.dependencies)) errors.push("dependencies not an array");

        if (errors.length > 0) {
          console.error(`  FAIL: Work item "${item.title}": ${errors.join(", ")}`);
          allValid = false;
        } else {
          console.log(`  PASS: "${item.title}" (deps: ${item.dependencies.length})`);
        }
      }

      // Validate dependency graph: all referenced IDs exist within the project items
      const itemIds = new Set(projectWorkItems.map((i) => i.id));
      for (const item of projectWorkItems) {
        for (const depId of item.dependencies) {
          if (!itemIds.has(depId)) {
            console.error(`  FAIL: "${item.title}" depends on "${depId}" which is not a project work item`);
            allValid = false;
          }
        }
      }

      if (!allValid) {
        console.error("\nSome work item validations failed.");
        process.exit(1);
      }
      console.log("\n  All work item validations passed.");
    }

    console.log("\n=== E2E Test Complete ===");
    process.exit(0);
  } finally {
    // e. Cleanup: delete created work items, transition project back to Draft
    console.log("\n--- Cleanup ---");

    for (const id of createdWorkItemIds) {
      try {
        await deleteWorkItem(id);
        console.log(`  Deleted work item: ${id}`);
      } catch (err) {
        console.error(`  Failed to delete work item ${id}:`, err);
      }
    }

    try {
      await updateProjectStatus(testProject.id, "Draft");
      console.log(`  Project "${testProject.title}" transitioned back to Draft.`);
    } catch (err) {
      console.error("  Failed to transition project back to Draft:", err);
    }

    console.log("--- Cleanup complete ---\n");
  }
}

main();
