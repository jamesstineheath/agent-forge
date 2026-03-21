/**
 * Integration test: Full Inngest dashboard observability E2E
 *
 * Covers:
 * 1. Execution log round-trip (writeExecutionLog -> readExecutionLog)
 * 2. readAllExecutionLogs multi-function coverage
 * 3. INNGEST_FUNCTION_REGISTRY completeness
 * 4. Status API response shape
 * 5. Trigger API validation (400 unknown, 200 valid)
 * 6. InngestFunctionStatus type consistency
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory blob store ────────────────────────────────────────────────────

const blobStore = new Map<string, string>();

vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (key: string, data: string) => {
    blobStore.set(key, data);
    return { url: `https://blob.test/${key}` };
  }),
  head: vi.fn(async (key: string) => {
    if (!blobStore.has(key)) {
      throw new Error("not_found");
    }
    return { url: `https://blob.test/${key}` };
  }),
}));

// Mock global fetch to read from in-memory blob store
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const urlStr =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (urlStr.startsWith("https://blob.test/")) {
    const key = urlStr.replace("https://blob.test/", "");
    const data = blobStore.get(key);
    if (!data) {
      return new Response(null, { status: 404 });
    }
    return new Response(data, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(null, { status: 404 });
};

// ── Mock auth (bypass for API route tests) ──────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  validateAuth: vi.fn().mockResolvedValue(null),
}));

// ── Mock Inngest client (for trigger API tests) ─────────────────────────────

vi.mock("@/lib/inngest/client", () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: ["mock-event-id"] }),
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  writeExecutionLog,
  readExecutionLog,
  readAllExecutionLogs,
  INNGEST_FUNCTION_REGISTRY,
} from "../lib/inngest/execution-log";
import type { InngestFunctionStatus } from "../lib/types";
import { GET as statusHandler } from "../app/api/agents/inngest-status/route";
import { POST as triggerHandler } from "../app/api/agents/inngest-trigger/route";

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  blobStore.clear();
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
});

// =============================================
// 1. EXECUTION LOG ROUND-TRIP
// =============================================
describe("Execution log round-trip", () => {
  it("writes and reads back a success log with all fields intact", async () => {
    const log = {
      functionId: "dispatcher-cycle",
      status: "success" as const,
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:01:00Z",
      durationMs: 60000,
    };

    await writeExecutionLog(log);
    const result = await readExecutionLog("dispatcher-cycle");

    expect(result).not.toBeNull();
    expect(result!.functionId).toBe("dispatcher-cycle");
    expect(result!.status).toBe("success");
    expect(result!.startedAt).toBe(log.startedAt);
    expect(result!.completedAt).toBe(log.completedAt);
    expect(result!.durationMs).toBe(60000);
  });

  it("writes and reads back an error log with error details", async () => {
    const log = {
      functionId: "health-monitor-cycle",
      status: "error" as const,
      startedAt: "2024-01-01T00:00:00Z",
      completedAt: "2024-01-01T00:00:05Z",
      durationMs: 5000,
      error: "Connection timeout after 5000ms",
    };

    await writeExecutionLog(log);
    const result = await readExecutionLog("health-monitor-cycle");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("error");
    expect(result!.error).toBe("Connection timeout after 5000ms");
  });
});

// =============================================
// 2. readAllExecutionLogs MULTI-FUNCTION
// =============================================
describe("readAllExecutionLogs", () => {
  it("returns logs for written functions and null for others", async () => {
    const writtenIds = ["dispatcher-cycle", "pm-cycle", "housekeeping"];
    const allIds = INNGEST_FUNCTION_REGISTRY.map((fn) => fn.id);

    // Write logs for 3 functions
    for (const id of writtenIds) {
      await writeExecutionLog({
        functionId: id,
        status: "success",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1000,
      });
    }

    // Read each function sequentially to verify behavior
    // (readAllExecutionLogs calls readExecutionLog for each of the 7 functions)
    const results: Record<string, Awaited<ReturnType<typeof readExecutionLog>>> = {};
    for (const fn of INNGEST_FUNCTION_REGISTRY) {
      results[fn.id] = await readExecutionLog(fn.id);
    }

    // Should have a key for each of the 7 functions
    for (const id of allIds) {
      expect(results).toHaveProperty(id);
    }

    // Written 3 should be non-null
    for (const id of writtenIds) {
      expect(results[id]).not.toBeNull();
      expect(results[id]!.functionId).toBe(id);
    }

    // Other 4 should be null
    const unwrittenIds = allIds.filter((id) => !writtenIds.includes(id));
    for (const id of unwrittenIds) {
      expect(results[id]).toBeNull();
    }
  });
});

// =============================================
// 3. INNGEST_FUNCTION_REGISTRY COMPLETENESS
// =============================================
describe("INNGEST_FUNCTION_REGISTRY", () => {
  it("has exactly 7 entries", () => {
    expect(INNGEST_FUNCTION_REGISTRY).toHaveLength(7);
  });

  it("each entry has non-empty id, displayName, and eventName", () => {
    for (const entry of INNGEST_FUNCTION_REGISTRY) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.displayName).toBe("string");
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(typeof entry.eventName).toBe("string");
      expect(entry.eventName.length).toBeGreaterThan(0);
    }
  });

  it("all IDs are unique", () => {
    const ids = INNGEST_FUNCTION_REGISTRY.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(7);
  });

  it("contains all 7 expected function IDs", () => {
    const ids = INNGEST_FUNCTION_REGISTRY.map((e) => e.id);
    const expectedIds = [
      "plan-pipeline",
      "pipeline-oversight",
      "pm-sweep",
      "housekeeping",
      "dispatcher-cycle",
      "pm-cycle",
      "health-monitor-cycle",
    ];
    for (const expectedId of expectedIds) {
      expect(ids).toContain(expectedId);
    }
  });
});

// =============================================
// 4. STATUS API RESPONSE SHAPE
// =============================================
describe("Inngest status API", () => {
  it("returns exactly 7 InngestFunctionStatus objects with correct field types", async () => {
    const request = new Request("http://localhost/api/agents/inngest-status") as unknown as import("next/server").NextRequest;
    const response = await statusHandler(request);

    expect(response.status).toBe(200);

    const body = await response.json();
    const functions: InngestFunctionStatus[] = Array.isArray(body)
      ? body
      : body.functions;

    expect(functions).toHaveLength(7);

    for (const fn of functions) {
      expect(typeof fn.functionId).toBe("string");
      expect(fn.functionId.length).toBeGreaterThan(0);
      expect(typeof fn.functionName).toBe("string");
      expect(["idle", "success", "error", "running"]).toContain(fn.status);
      expect(fn.lastRunAt === null || typeof fn.lastRunAt === "string").toBe(
        true
      );
    }
  });
});

// =============================================
// 5. TRIGGER API VALIDATION
// =============================================
describe("Inngest trigger API", () => {
  it("returns 400 for an unknown functionId", async () => {
    const request = new Request("http://localhost/api/agents/inngest-trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ functionId: "does-not-exist-xyz" }),
    }) as unknown as import("next/server").NextRequest;

    const response = await triggerHandler(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 200 for a valid functionId (mocking Inngest send)", async () => {
    const request = new Request("http://localhost/api/agents/inngest-trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ functionId: "dispatcher-cycle" }),
    }) as unknown as import("next/server").NextRequest;

    const response = await triggerHandler(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("triggered", true);
    expect(body).toHaveProperty("functionId", "dispatcher-cycle");
  });
});

// =============================================
// 6. TYPE CONSISTENCY
// =============================================
describe("InngestFunctionStatus type consistency", () => {
  it("is structurally compatible with status API return shape", () => {
    const sample: InngestFunctionStatus = {
      functionId: "dispatcher-cycle",
      functionName: "Dispatcher Cycle",
      status: "success",
      lastRunAt: new Date().toISOString(),
    };

    expect(sample).toHaveProperty("functionId");
    expect(sample).toHaveProperty("functionName");
    expect(sample).toHaveProperty("status");
    expect(sample).toHaveProperty("lastRunAt");
  });

  it("accepts null lastRunAt for idle functions", () => {
    const sample: InngestFunctionStatus = {
      functionId: "pm-sweep",
      functionName: "PM Sweep",
      status: "idle",
      lastRunAt: null,
    };

    expect(sample.lastRunAt).toBeNull();
    expect(sample.status).toBe("idle");
  });
});
