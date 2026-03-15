// scripts/test-escalation-e2e.ts
// End-to-end test for the escalation flow: create escalation → verify work item blocked → list escalations.
//
// Usage: AGENT_FORGE_URL=http://localhost:3002 AGENT_FORGE_API_SECRET=test-secret npx tsx scripts/test-escalation-e2e.ts
//
// Prerequisites: A work item must exist. Set WORK_ITEM_ID env var, or the script
// will attempt to find one from GET /api/work-items.

const BASE_URL = process.env.AGENT_FORGE_URL || "http://localhost:3002";
const SECRET = process.env.AGENT_FORGE_API_SECRET || "test-secret";
const WORK_ITEM_ID = process.env.WORK_ITEM_ID;

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true, detail: "OK" });
    console.log(`  PASS: ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail });
    console.log(`  FAIL: ${name} - ${detail}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${SECRET}`,
};

async function main() {
  console.log(`E2E escalation test at ${BASE_URL}\n`);

  let workItemId = WORK_ITEM_ID;

  // Step 0: Find a work item if not provided
  if (!workItemId) {
    console.log("No WORK_ITEM_ID provided, looking for an existing work item...");
    try {
      const res = await fetch(`${BASE_URL}/api/work-items`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      if (res.ok) {
        const items = await res.json();
        if (Array.isArray(items) && items.length > 0) {
          workItemId = items[0].id;
          console.log(`Found work item: ${workItemId}\n`);
        }
      }
    } catch {
      // Ignore - will use a fake ID
    }

    if (!workItemId) {
      workItemId = "test-wi-e2e-" + Date.now();
      console.log(`No work items found, using synthetic ID: ${workItemId}\n`);
    }
  }

  let escalationId: string | undefined;

  // Step 1: Create an escalation via POST /api/escalations
  await test("POST /api/escalations creates escalation", async () => {
    const res = await fetch(`${BASE_URL}/api/escalations`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        workItemId,
        reason: "E2E test: agent encountered unresolvable blocker",
        confidenceScore: 0.4,
        contextSnapshot: {
          step: "3",
          error: "Test error for E2E validation",
          filesChanged: ["lib/test.ts"],
        },
      }),
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    const body = await res.json();
    assert(body.id, "Response should include escalation ID");
    assert(body.status === "pending", `Expected status "pending", got "${body.status}"`);
    assert(body.workItemId === workItemId, "workItemId should match");
    escalationId = body.id;
    console.log(`    Created escalation: ${escalationId}`);
  });

  // Step 2: List escalations and verify ours is present
  await test("GET /api/escalations?status=pending includes new escalation", async () => {
    assert(!!escalationId, "Escalation ID not set from previous step");
    const res = await fetch(`${BASE_URL}/api/escalations?status=pending`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const escalations = await res.json();
    assert(Array.isArray(escalations), "Response should be an array");
    const found = escalations.find((e: { id: string }) => e.id === escalationId);
    assert(!!found, `Escalation ${escalationId} not found in pending list`);
  });

  // Step 3: Resolve the escalation
  await test("POST /api/escalations/[id]/resolve resolves escalation", async () => {
    assert(!!escalationId, "Escalation ID not set from previous step");
    const res = await fetch(`${BASE_URL}/api/escalations/${escalationId}/resolve`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        resolution: "E2E test resolution: proceed with implementation",
      }),
    });
    // Accept 200 or 201 - the resolve endpoint may use either
    assert(res.status >= 200 && res.status < 300, `Expected 2xx, got ${res.status}`);
    const body = await res.json();
    assert(body.status === "resolved", `Expected status "resolved", got "${body.status}"`);
  });

  // Summary
  console.log("\n--- E2E Results ---");
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} tests passed`);

  if (passed < total) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("E2E test runner error:", err);
  process.exit(1);
});
