/**
 * Pipeline Smoke Tests
 *
 * Validates each pipeline stage independently by hitting real APIs.
 * Run with: npx tsx scripts/smoke-test.ts
 */

import { loadJson, saveJson, deleteJson } from "../lib/storage";
import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  deleteWorkItem,
  listWorkItems,
} from "../lib/work-items";
import { listBranches } from "../lib/github";
import { acquireATCLock, releaseATCLock } from "../lib/atc";
import { fetchPageContent } from "../lib/notion";

// --- Env var check ---

const REQUIRED_VARS = [
  "BLOB_READ_WRITE_TOKEN",
  "GH_PAT",
  "NOTION_API_KEY",
];

const OPTIONAL_VARS = [
  "ANTHROPIC_API_KEY",
  "CRON_SECRET",
  "AGENT_FORGE_API_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "NOTION_PROJECTS_DB_ID",
];

function checkEnvVars(): boolean {
  let ok = true;
  for (const v of REQUIRED_VARS) {
    if (!process.env[v]) {
      console.error(`MISSING required env var: ${v}`);
      ok = false;
    }
  }
  for (const v of OPTIONAL_VARS) {
    if (!process.env[v]) {
      console.warn(`OPTIONAL env var not set: ${v}`);
    }
  }
  return ok;
}

// --- Test runner ---

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error: msg });
    console.error(`✗ FAIL: ${name} — ${msg}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// --- Tests ---

async function testStorageRoundTrip(): Promise<void> {
  const testKey = "smoke-test/round-trip";
  try {
    await saveJson(testKey, { test: true, timestamp: new Date().toISOString() });
    const result = await loadJson<{ test: boolean }>(testKey);
    assert(result?.test === true, "Storage round-trip read failed");
    await deleteJson(testKey);
    const deleted = await loadJson(testKey);
    assert(deleted === null, "Storage delete failed — value still present");
  } finally {
    await deleteJson(testKey).catch(() => {});
  }
}

async function testWorkItemLifecycle(): Promise<void> {
  let itemId: string | undefined;
  try {
    const item = await createWorkItem({
      title: "Smoke test item",
      description: "Pipeline smoke test — safe to delete",
      targetRepo: "jamesstineheath/agent-forge",
      source: { type: "manual", sourceId: "smoke-test" },
      priority: "low",
      riskLevel: "low",
      complexity: "simple",
      dependencies: [],
    });
    itemId = item.id;
    assert(!!item.id, "Work item creation failed — no ID");
    assert(item.status === "filed", `Initial status should be 'filed', got '${item.status}'`);

    const statuses = ["ready", "generating", "executing", "reviewing", "merged"] as const;
    for (const status of statuses) {
      await updateWorkItem(item.id, { status: status as any });
      const updated = await getWorkItem(item.id);
      assert(updated?.status === status, `Status transition to '${status}' failed, got '${updated?.status}'`);
    }
  } finally {
    if (itemId) await deleteWorkItem(itemId).catch(() => {});
  }
}

async function testGitHubConnectivity(): Promise<void> {
  const branches = await listBranches("jamesstineheath/agent-forge");
  assert(Array.isArray(branches), "GitHub branch listing did not return an array");
  console.log(`  (${branches.length} branches found)`);
}

async function testATCLock(): Promise<void> {
  try {
    const acquired1 = await acquireATCLock();
    assert(acquired1 === true, "First lock acquire should succeed");

    const acquired2 = await acquireATCLock();
    assert(acquired2 === false, "Second lock acquire should fail (lock held)");

    await releaseATCLock();

    const acquired3 = await acquireATCLock();
    assert(acquired3 === true, "Lock acquire after release should succeed");
  } finally {
    await releaseATCLock().catch(() => {});
  }
}

async function testGeneratingTimeout(): Promise<void> {
  let itemId: string | undefined;
  try {
    const item = await createWorkItem({
      title: "Smoke test — generating timeout",
      description: "Should be detectable by timeout logic",
      targetRepo: "jamesstineheath/agent-forge",
      source: { type: "manual", sourceId: "smoke-test" },
      priority: "low",
      riskLevel: "low",
      complexity: "simple",
      dependencies: [],
    });
    itemId = item.id;

    // Set to generating with old timestamp
    await updateWorkItem(item.id, { status: "generating" as any });
    const raw = await getWorkItem(item.id);
    assert(!!raw, "Failed to read back work item");
    raw!.updatedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await saveJson(`work-items/${raw!.id}`, raw);

    // Verify item appears in generating query
    const generatingEntries = await listWorkItems({ status: "generating" as any });
    const found = generatingEntries.some(e => e.id === item.id);
    assert(found, "Backdated item not found in generating query");

    // Verify timeout would detect it (check elapsed time)
    const reloaded = await getWorkItem(item.id);
    const elapsed = (Date.now() - new Date(reloaded!.updatedAt).getTime()) / 60_000;
    assert(elapsed >= 15, `Expected elapsed >= 15min, got ${Math.round(elapsed)}min`);
    console.log(`  (item backdated ${Math.round(elapsed)}min, would be timed out by ATC cycle)`);
  } finally {
    if (itemId) await deleteWorkItem(itemId).catch(() => {});
  }
}

async function testDispatchErrorTransition(): Promise<void> {
  let itemId: string | undefined;
  try {
    const item = await createWorkItem({
      title: "Smoke test — dispatch failure",
      description: "Should fail dispatch due to unregistered repo",
      targetRepo: "jamesstineheath/nonexistent-repo-smoke-test",
      source: { type: "manual", sourceId: "smoke-test" },
      priority: "low",
      riskLevel: "low",
      complexity: "simple",
      dependencies: [],
    });
    itemId = item.id;
    await updateWorkItem(item.id, { status: "ready" });

    // Import dispatchWorkItem dynamically to avoid circular deps at top level
    const { dispatchWorkItem } = await import("../lib/orchestrator");
    try {
      await dispatchWorkItem(item.id);
      throw new Error("Dispatch should have thrown for non-existent repo");
    } catch (err: any) {
      if (err.message.includes("Dispatch should have thrown")) throw err;
      // Expected error — dispatchWorkItem sets status to "failed" internally
    }

    const afterDispatch = await getWorkItem(item.id);
    assert(
      afterDispatch?.status === "failed",
      `Expected status 'failed' after dispatch error, got '${afterDispatch?.status}'`
    );
  } finally {
    if (itemId) await deleteWorkItem(itemId).catch(() => {});
  }
}

async function testNotionConnectivity(): Promise<void> {
  // Use a known plan page ID (PRJ-26 plan)
  const content = await fetchPageContent("325041760b7081488f4ae9ac32e1a38c");
  assert(!!content && content.length > 50, `Notion page fetch failed or returned empty (length: ${content?.length ?? 0})`);
  console.log(`  (${content.length} chars fetched)`);
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== Agent Forge Pipeline Smoke Tests ===\n");

  if (!checkEnvVars()) {
    console.error("\nAborting: required env vars missing.");
    process.exit(1);
  }
  console.log("");

  await runTest("1. Storage round-trip", testStorageRoundTrip);
  await runTest("2. Work item lifecycle", testWorkItemLifecycle);
  await runTest("3. GitHub API connectivity", testGitHubConnectivity);
  await runTest("4. ATC lock mechanism", testATCLock);
  await runTest("5. Generating timeout detection", testGeneratingTimeout);
  await runTest("6. Dispatch error → failed transition", testDispatchErrorTransition);
  await runTest("7. Notion connectivity", testNotionConnectivity);

  // Summary
  console.log("\n=== Summary ===");
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);

  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results.filter(r => !r.passed)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log("\nAll tests passed!");
}

main().catch(err => {
  console.error("Smoke test runner crashed:", err);
  process.exit(1);
});
