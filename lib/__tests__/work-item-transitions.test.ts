/**
 * Tests for work item status transition guards.
 *
 * Validates that terminal statuses (cancelled, merged, obsolete) cannot be
 * transitioned back to non-terminal states, preventing the lost-update bug
 * where ATC health monitor overwrites MCP-driven status changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory storage mock
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

import { createWorkItem, updateWorkItem, getWorkItem } from "@/lib/work-items";

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    title: "Test item",
    description: "Test description",
    targetRepo: "jamesstineheath/agent-forge",
    source: { type: "direct" as const },
    priority: "medium" as const,
    riskLevel: "low" as const,
    complexity: "simple" as const,
    dependencies: [] as string[],
    ...overrides,
  };
}

describe("updateWorkItem — terminal status guards", () => {
  beforeEach(() => {
    store.clear();
    // Initialize the index as empty array
    store.set("work-items/index", JSON.stringify([]));
  });

  it("blocks transition from cancelled → failed", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "cancelled" });

    const result = await updateWorkItem(item.id, { status: "failed" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("cancelled");
  });

  it("blocks transition from merged → ready", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "merged" });

    const result = await updateWorkItem(item.id, { status: "ready" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("merged");
  });

  it("blocks transition from merged → executing", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "merged" });

    const result = await updateWorkItem(item.id, { status: "executing" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("merged");
  });

  it("allows transition from cancelled → merged (terminal to terminal)", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "cancelled" });

    const result = await updateWorkItem(item.id, { status: "merged" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("merged");
  });

  it("allows transition from merged → cancelled (terminal to terminal)", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "merged" });

    const result = await updateWorkItem(item.id, { status: "cancelled" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("cancelled");
  });

  it("allows non-terminal transitions (ready → executing)", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "ready" });

    const result = await updateWorkItem(item.id, { status: "executing" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("executing");
  });

  it("allows transition to terminal from non-terminal (failed → cancelled)", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "failed" });

    const result = await updateWorkItem(item.id, { status: "cancelled" });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("cancelled");
  });

  it("allows updating non-status fields on terminal items", async () => {
    const item = await createWorkItem(makeItem());
    await updateWorkItem(item.id, { status: "merged" });

    const result = await updateWorkItem(item.id, { notes: "Updated note" } as any);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("merged");
    expect((result as any).notes).toBe("Updated note");
  });

  it("returns null for non-existent items", async () => {
    const result = await updateWorkItem("non-existent-id", { status: "ready" });
    expect(result).toBeNull();
  });
});
