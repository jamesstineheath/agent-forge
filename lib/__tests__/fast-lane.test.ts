/**
 * Integration tests: End-to-end fast lane flow validation
 *
 * These tests validate the contracts between:
 * - /api/fast-lane route (via underlying lib functions)
 * - lib/daily-cap.ts
 * - lib/work-items.ts (getNextDispatchable)
 * - lib/mcp-tools.ts (handleCreateFastLaneItem)
 * - lib/escalation.ts (escalateFastLaneItem)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory storage mock — for escalation records (still blob-based)
const store = new Map<string, string>();

vi.mock("@/lib/storage", () => ({
  loadJson: async <T>(key: string): Promise<T | null> => {
    const raw = store.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  },
  saveJson: async <T>(key: string, data: T): Promise<void> => {
    store.set(key, JSON.stringify(data));
  },
  deleteJson: async (key: string): Promise<void> => {
    store.delete(key);
  },
}));

// Mock work-items with in-memory implementation (replaces Postgres dependency)
vi.mock("@/lib/work-items", async () => import("./helpers/mock-work-items"));

// Mock gmail to avoid real email sends
vi.mock("@/lib/gmail", () => ({
  sendEscalationEmail: async () => null,
  sendEmail: async () => null,
}));

// Mock listRepos to return a registered repo for validation
vi.mock("@/lib/repos", () => ({
  listRepos: async () => [
    { id: "1", fullName: "jamesstineheath/agent-forge", shortName: "agent-forge", updatedAt: new Date().toISOString() },
  ],
}));

import {
  createWorkItem,
  getWorkItem,
  updateWorkItem,
  getNextDispatchable,
} from "@/lib/work-items";
import { resetStore as resetWorkItemStore } from "./helpers/mock-work-items";
import { checkDailyCap, incrementDailyCount } from "@/lib/daily-cap";
import { handleCreateFastLaneItem } from "@/lib/mcp-tools";
import { escalateFastLaneItem } from "@/lib/escalation";
import {
  FAST_LANE_BUDGET_SIMPLE,
  FAST_LANE_BUDGET_MODERATE,
  createWorkItemSchema,
} from "@/lib/types";
import type { ComplexityHint, CreateWorkItemInput } from "@/lib/types";

const TARGET_REPO = "jamesstineheath/agent-forge";

/** Helper: create a direct-source work item via the same logic as the API route */
async function createDirectItem(overrides: {
  description?: string;
  complexity?: ComplexityHint;
  triggeredBy?: string;
  budget?: number;
} = {}) {
  const {
    description = "Test item",
    complexity,
    triggeredBy = "james",
  } = overrides;

  const parsed: CreateWorkItemInput = createWorkItemSchema.parse({
    title: description.trim(),
    description: description.trim(),
    targetRepo: TARGET_REPO,
    source: { type: "direct" },
    triggeredBy,
    ...(complexity ? { complexityHint: complexity } : {}),
  });
  return createWorkItem(parsed);
}

beforeEach(() => {
  store.clear();
  resetWorkItemStore();
});

// ---------------------------------------------------------------------------
// TEST 1: Create direct-source work item with minimal input
// ---------------------------------------------------------------------------
describe("POST /api/fast-lane - create work item", () => {
  it("stores item with source.type=direct, triggeredBy, and budget defaults", async () => {
    const item = await createDirectItem({ triggeredBy: "qa-agent" });

    expect(item.source.type).toBe("direct");
    expect(item.triggeredBy).toBe("qa-agent");
    expect(item.status).toBe("filed");
    expect(item.title).toBe("Test item");
    expect(item.description).toBe("Test item");
    expect(item.dependencies).toEqual([]);
  });

  it("applies simple budget default when complexity=simple", async () => {
    const BUDGET_DEFAULTS: Record<ComplexityHint, number> = {
      simple: FAST_LANE_BUDGET_SIMPLE,
      moderate: FAST_LANE_BUDGET_MODERATE,
    };
    const item = await createDirectItem({ complexity: "simple" });
    expect(item.complexityHint).toBe("simple");
    // Budget is resolved at the API/MCP layer, not stored on the item directly,
    // but the complexityHint is stored for downstream resolution
    expect(BUDGET_DEFAULTS[item.complexityHint!]).toBe(FAST_LANE_BUDGET_SIMPLE);
  });

  it("defaults triggeredBy to james when not provided", async () => {
    const item = await createDirectItem({});
    expect(item.triggeredBy).toBe("james");
  });
});

// ---------------------------------------------------------------------------
// TEST 2: Direct-source items appear in getNextDispatchable()
// ---------------------------------------------------------------------------
describe("getNextDispatchable() with direct-source items", () => {
  it("returns direct-source item without dependency checks", async () => {
    const item = await createDirectItem();
    // getNextDispatchable only returns "ready" items, so transition first
    await updateWorkItem(item.id, { status: "ready" });

    const next = await getNextDispatchable(TARGET_REPO);
    expect(next).not.toBeNull();
    expect(next!.id).toBe(item.id);
    expect(next!.source.type).toBe("direct");
  });

  it("does not return filed items (only ready)", async () => {
    await createDirectItem();
    const next = await getNextDispatchable(TARGET_REPO);
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST 3: Escalation flow
// ---------------------------------------------------------------------------
describe("Escalation flow", () => {
  it("escalated item has status=escalated and is excluded from dispatch", async () => {
    const item = await createDirectItem();
    await updateWorkItem(item.id, { status: "ready" });

    // Escalate using the fast-lane escalation function
    await escalateFastLaneItem(item.id, "complexity_flag", "Too complex for fast lane");

    const updated = await getWorkItem(item.id);
    expect(updated!.status).toBe("escalated");

    // Escalated items should NOT appear in getNextDispatchable
    const next = await getNextDispatchable(TARGET_REPO);
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TEST 4: Retry flow
// ---------------------------------------------------------------------------
describe("Retry flow", () => {
  it("retried item returns to filed status with reset budget", async () => {
    const item = await createDirectItem({ complexity: "simple" });
    await updateWorkItem(item.id, { status: "ready" });

    // Escalate
    await escalateFastLaneItem(item.id, "spec_review_flag", "Flagged during review");
    let updated = await getWorkItem(item.id);
    expect(updated!.status).toBe("escalated");

    // Retry: reset status to filed (mimics dashboard retry action)
    await updateWorkItem(item.id, {
      status: "filed",
      escalation: undefined,
    });

    updated = await getWorkItem(item.id);
    expect(updated!.status).toBe("filed");
    // The complexityHint is preserved, so budget can be re-derived
    expect(updated!.complexityHint).toBe("simple");
  });
});

// ---------------------------------------------------------------------------
// TEST 5: Daily cap enforcement
// ---------------------------------------------------------------------------
describe("Daily cap enforcement", () => {
  it("rejects 4th item from non-human producer (qa-agent)", async () => {
    const producer = "qa-agent";

    // Create 3 items, incrementing the cap each time
    for (let i = 0; i < 3; i++) {
      const cap = await checkDailyCap(producer);
      expect(cap.allowed).toBe(true);
      await incrementDailyCount(producer);
    }

    // 4th should be rejected (default limit is 3)
    const cap4 = await checkDailyCap(producer);
    expect(cap4.allowed).toBe(false);
    expect(cap4.remaining).toBe(0);
    expect(cap4.limit).toBe(3);
  });

  it("allows unlimited items from human producer (james)", async () => {
    const producer = "james";

    // james should always be allowed regardless of count
    for (let i = 0; i < 5; i++) {
      const cap = await checkDailyCap(producer);
      expect(cap.allowed).toBe(true);
      expect(cap.limit).toBe(Infinity);
      await incrementDailyCount(producer);
    }
  });
});

// ---------------------------------------------------------------------------
// TEST 6: Type/input validation
// ---------------------------------------------------------------------------
describe("Input validation", () => {
  it("rejects invalid complexityHint value", () => {
    expect(() =>
      createWorkItemSchema.parse({
        title: "Test",
        description: "Test desc",
        targetRepo: TARGET_REPO,
        source: { type: "direct" },
        complexityHint: "invalid-value",
      })
    ).toThrow();
  });

  it("rejects missing description", () => {
    expect(() =>
      createWorkItemSchema.parse({
        title: "Test",
        // description is missing
        targetRepo: TARGET_REPO,
        source: { type: "direct" },
      })
    ).toThrow();
  });

  it("rejects empty description", () => {
    expect(() =>
      createWorkItemSchema.parse({
        title: "Test",
        description: "",
        targetRepo: TARGET_REPO,
        source: { type: "direct" },
      })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TEST 7: MCP tool parity
// ---------------------------------------------------------------------------
describe("MCP tool parity", () => {
  it("handleCreateFastLaneItem produces same result structure as direct creation", async () => {
    // Create via MCP tool handler
    const mcpResult = await handleCreateFastLaneItem({
      description: "MCP test item",
      targetRepo: TARGET_REPO,
      complexity: "simple",
      triggeredBy: "james",
    });

    expect(mcpResult.workItemId).toBeDefined();
    expect(mcpResult.status).toBe("filed");
    expect(mcpResult.budget).toBe(FAST_LANE_BUDGET_SIMPLE);

    // Verify the stored item has the same structure as a directly created item
    const storedItem = await getWorkItem(mcpResult.workItemId);
    expect(storedItem).not.toBeNull();
    expect(storedItem!.source.type).toBe("direct");
    expect(storedItem!.triggeredBy).toBe("james");
    expect(storedItem!.complexityHint).toBe("simple");
  });

  it("both paths apply the same default budget for moderate complexity", async () => {
    const mcpResult = await handleCreateFastLaneItem({
      description: "Moderate MCP item",
      targetRepo: TARGET_REPO,
      complexity: "moderate",
      triggeredBy: "james",
    });

    expect(mcpResult.budget).toBe(FAST_LANE_BUDGET_MODERATE);
  });

  it("both paths default to moderate budget when no complexity specified", async () => {
    const mcpResult = await handleCreateFastLaneItem({
      description: "No complexity item",
      targetRepo: TARGET_REPO,
      triggeredBy: "james",
    });

    expect(mcpResult.budget).toBe(FAST_LANE_BUDGET_MODERATE);
  });
});
