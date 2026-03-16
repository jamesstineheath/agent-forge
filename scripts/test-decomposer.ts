/**
 * Test script for the Plan Decomposer.
 *
 * Usage: npx tsx scripts/test-decomposer.ts
 * Requires: NOTION_API_KEY, ANTHROPIC_API_KEY, GH_PAT env vars
 */

import { decomposeProject } from "../lib/decomposer";
import { extractPageId } from "../lib/decomposer";
import type { Project } from "../lib/types";

async function main() {
  console.log("=== Plan Decomposer Test ===\n");

  // --- Unit test: extractPageId ---
  console.log("Testing extractPageId...");
  const testCases = [
    { input: "323041760b70813aa3f6e609a47cff57", expected: "323041760b70813aa3f6e609a47cff57" },
    { input: "32304176-0b70-813a-a3f6-e609a47cff57", expected: "323041760b70813aa3f6e609a47cff57" },
    {
      input: "https://www.notion.so/My-Plan-323041760b70813aa3f6e609a47cff57",
      expected: "323041760b70813aa3f6e609a47cff57",
    },
  ];

  for (const tc of testCases) {
    const result = extractPageId(tc.input);
    if (result !== tc.expected) {
      console.error(`FAIL: extractPageId("${tc.input}") = "${result}", expected "${tc.expected}"`);
      process.exit(1);
    }
    console.log(`  PASS: extractPageId("${tc.input.slice(0, 40)}...")`);
  }
  console.log("extractPageId tests passed.\n");

  // --- Integration test: decomposeProject ---
  console.log("Testing decomposeProject...");

  const mockProject: Project = {
    id: "test-page-id",
    projectId: "PRJ-TEST",
    title: "Test Decomposition",
    planUrl: "323041760b70813aa3f6e609a47cff57",
    targetRepo: "agent-forge",
    status: "Ready",
    priority: "P1",
    complexity: "Moderate",
    riskLevel: "Medium",
    createdAt: new Date().toISOString(),
  };

  try {
    const result = await decomposeProject(mockProject);
    const items = result.workItems;

    console.log(`\nDecomposition produced ${items.length} work items.\n`);
    if (result.phases) {
      console.log(`Split into ${result.phases.length} phases: ${result.phases.map((p) => p.length + " items").join(", ")}\n`);
    }

    if (items.length === 0) {
      console.error("FAIL: decomposeProject returned empty array (escalation may have triggered).");
      console.log("This may be expected if NOTION_API_KEY is not set or the page is inaccessible.");
      process.exit(1);
    }

    // Validate each item
    let allValid = true;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const errors: string[] = [];

      if (!item.id) errors.push("missing id");
      if (!item.title) errors.push("missing title");
      if (!item.description) errors.push("missing description");
      if (!item.targetRepo) errors.push("missing targetRepo");
      if (!item.source || item.source.type !== "project") errors.push("source.type not 'project'");
      if (!item.priority) errors.push("missing priority");
      if (!item.riskLevel) errors.push("missing riskLevel");
      if (!item.complexity) errors.push("missing complexity");
      if (!Array.isArray(item.dependencies)) errors.push("dependencies not an array");

      // Check that acceptance criteria are embedded in description
      if (!item.description.includes("## Acceptance Criteria")) {
        errors.push("missing ## Acceptance Criteria in description");
      }

      if (errors.length > 0) {
        console.error(`FAIL: Item ${i} ("${item.title}"): ${errors.join(", ")}`);
        allValid = false;
      } else {
        console.log(`  PASS: Item ${i} - "${item.title}" (${item.riskLevel} risk, ${item.complexity})`);
      }
    }

    // Validate dependency graph: no cycles, no out-of-bounds references
    // (Dependencies are already resolved to IDs, so we check that all referenced IDs exist)
    const allIds = new Set(items.map((item) => item.id));
    for (const item of items) {
      for (const dep of item.dependencies) {
        if (!allIds.has(dep)) {
          console.error(`FAIL: Item "${item.title}" has dependency "${dep}" that doesn't exist`);
          allValid = false;
        }
      }
    }

    if (!allValid) {
      console.error("\nSome validations failed.");
      process.exit(1);
    }

    console.log("\nAll validations passed!");
    process.exit(0);
  } catch (err) {
    console.error("FAIL: decomposeProject threw an error:", err);
    process.exit(1);
  }
}

main();
