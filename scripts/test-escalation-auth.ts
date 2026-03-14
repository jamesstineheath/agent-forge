// scripts/test-escalation-auth.ts
// Tests Bearer token authentication on the /api/escalations endpoint.
//
// Usage: AGENT_FORGE_URL=http://localhost:3002 ESCALATION_SECRET=test-secret npx tsx scripts/test-escalation-auth.ts
//
// This script verifies:
// 1. Requests without a token return 401
// 2. Requests with an invalid token return 401
// 3. Requests with a valid token are accepted (returns 400 for missing body, not 401)

const BASE_URL = process.env.AGENT_FORGE_URL || "http://localhost:3002";
const SECRET = process.env.ESCALATION_SECRET || "test-secret";
const ENDPOINT = `${BASE_URL}/api/escalations`;

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

async function main() {
  console.log(`Testing escalation auth at ${ENDPOINT}\n`);

  // Test 1: No auth header → 401
  await test("POST without Authorization header returns 401", async () => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workItemId: "test", reason: "test" }),
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert(body.error === "Unauthorized", `Expected "Unauthorized", got "${body.error}"`);
  });

  // Test 2: Wrong token → 401
  await test("POST with invalid Bearer token returns 401", async () => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ workItemId: "test", reason: "test" }),
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // Test 3: Valid token, missing body fields → 400 (auth passed, validation caught it)
  await test("POST with valid Bearer token passes auth (returns 400 for bad body)", async () => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert(
      body.error === "workItemId and reason are required",
      `Expected validation error, got "${body.error}"`
    );
  });

  // Test 4: GET without auth → 401
  await test("GET without Authorization header returns 401", async () => {
    const res = await fetch(ENDPOINT);
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  // Test 5: GET with valid token → 200
  await test("GET with valid Bearer token returns 200", async () => {
    const res = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
  });

  // Summary
  console.log("\n--- Results ---");
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
  console.error("Test runner error:", err);
  process.exit(1);
});
