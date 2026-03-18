/**
 * Unit tests for HLO code CI retry logic in health-monitor.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies before importing the function under test
vi.mock("@/lib/github", () => ({
  triggerWorkflow: vi.fn().mockResolvedValue(undefined),
  getWorkflowRuns: vi.fn().mockResolvedValue([]),
  getPRByBranch: vi.fn().mockResolvedValue(null),
  getPRByNumber: vi.fn().mockResolvedValue(null),
  getPRFiles: vi.fn().mockResolvedValue([]),
  getPRMergeability: vi.fn().mockResolvedValue({ mergeable: null, mergeableState: null }),
  rebasePR: vi.fn().mockResolvedValue({ success: true }),
  closePRWithReason: vi.fn().mockResolvedValue(undefined),
  deleteBranch: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/work-items", () => ({
  listWorkItems: vi.fn().mockResolvedValue([]),
  getWorkItem: vi.fn().mockResolvedValue(null),
  updateWorkItem: vi.fn().mockResolvedValue(null),
  getBlockedByDependencies: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/escalation", () => ({
  escalate: vi.fn().mockResolvedValue({ id: "esc_test" }),
}));

vi.mock("@/lib/repos", () => ({
  listRepos: vi.fn().mockResolvedValue([]),
  getRepo: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/knowledge-graph/indexer", () => ({
  incrementalIndex: vi.fn().mockResolvedValue({ entitiesUpdated: 0 }),
}));

vi.mock("@/lib/storage", () => ({
  loadJson: vi.fn().mockResolvedValue(null),
  saveJson: vi.fn().mockResolvedValue(undefined),
  deleteJson: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/atc/tracing", () => ({
  startTrace: vi.fn().mockReturnValue({ phases: [], decisions: [], errors: [] }),
  addPhase: vi.fn(),
  addDecision: vi.fn(),
  addError: vi.fn(),
  completeTrace: vi.fn(),
  persistTrace: vi.fn().mockResolvedValue(undefined),
  cleanupOldTraces: vi.fn().mockResolvedValue(undefined),
}));

import { handleCodeCIFailure } from "@/lib/atc/health-monitor";
import { triggerWorkflow } from "@/lib/github";
import { updateWorkItem } from "@/lib/work-items";
import { escalate } from "@/lib/escalation";
import type { WorkItem, ATCEvent } from "@/lib/types";
import type { CycleContext } from "@/lib/atc/types";

function makeMockItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi-test-001",
    title: "Test work item",
    description: "Test description",
    targetRepo: "jamesstineheath/agent-forge",
    source: { type: "direct" },
    priority: "medium",
    riskLevel: "medium",
    complexity: "moderate",
    status: "executing",
    dependencies: [],
    handoff: {
      content: "# Test handoff",
      branch: "feat/test-branch",
      budget: 5,
      generatedAt: new Date().toISOString(),
    },
    execution: {
      retryCount: 0,
      startedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryBudget: 1,
    ...overrides,
  };
}

function makeMockCtx(): CycleContext {
  return {
    now: new Date(),
    events: [] as ATCEvent[],
  };
}

describe("handleCodeCIFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers workflow dispatch on first failure (retryCount 0)", async () => {
    const item = makeMockItem();
    const ctx = makeMockCtx();

    await handleCodeCIFailure(item, "build error: cannot find module", ctx);

    expect(triggerWorkflow).toHaveBeenCalledWith(
      "jamesstineheath/agent-forge",
      "execute-handoff.yml",
      "feat/test-branch",
      expect.objectContaining({
        branch: "feat/test-branch",
        retry_context: expect.stringContaining("build error"),
      })
    );
    expect(updateWorkItem).toHaveBeenCalledWith("wi-test-001", {
      execution: expect.objectContaining({ retryCount: 1 }),
    });
    // Should emit ci_code_retry_triggered event
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].type).toBe("ci_code_retry_triggered");
    expect(ctx.events[0].workItemId).toBe("wi-test-001");
    // Should NOT escalate
    expect(escalate).not.toHaveBeenCalled();
  });

  it("marks failed and creates escalation when budget exhausted", async () => {
    const item = makeMockItem({
      execution: { retryCount: 1, startedAt: new Date().toISOString() },
      retryBudget: 1,
    });
    const ctx = makeMockCtx();

    await handleCodeCIFailure(item, "build error: type mismatch", ctx);

    // Should NOT trigger workflow dispatch
    expect(triggerWorkflow).not.toHaveBeenCalled();
    // Should mark as failed
    expect(updateWorkItem).toHaveBeenCalledWith("wi-test-001", { status: "failed" });
    // Should create escalation
    expect(escalate).toHaveBeenCalledWith(
      "wi-test-001",
      expect.stringContaining("CI failed with code error"),
      0.8,
      expect.objectContaining({ retryCount: 1, retryBudget: 1 })
    );
    // Should emit ci_code_retry_exhausted event
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0].type).toBe("ci_code_retry_exhausted");
  });

  it("caps error logs at 4000 chars in retry_context", async () => {
    const item = makeMockItem();
    const ctx = makeMockCtx();
    const longError = "x".repeat(10000);

    await handleCodeCIFailure(item, longError, ctx);

    const call = vi.mocked(triggerWorkflow).mock.calls[0];
    const inputs = call[3] as Record<string, string>;
    const context = JSON.parse(inputs.retry_context);
    expect(context.errorLogs.length).toBeLessThanOrEqual(4000);
  });

  it("defaults retryBudget to 1 when not set on item", async () => {
    const item = makeMockItem({ retryBudget: undefined });
    const ctx = makeMockCtx();

    await handleCodeCIFailure(item, "some error", ctx);

    // Should trigger retry since default budget is 1 and retryCount is 0
    expect(triggerWorkflow).toHaveBeenCalled();
  });

  it("skips retry if no handoff branch", async () => {
    const item = makeMockItem({ handoff: null });
    const ctx = makeMockCtx();

    await handleCodeCIFailure(item, "some error", ctx);

    expect(triggerWorkflow).not.toHaveBeenCalled();
    expect(updateWorkItem).not.toHaveBeenCalled();
  });

  it("skips duplicate retry within idempotency window", async () => {
    const item = makeMockItem();
    const ctx = makeMockCtx();
    // Simulate a recent retry event in the events array
    ctx.events.push({
      id: "evt-1",
      timestamp: new Date().toISOString(),
      type: "ci_code_retry_triggered",
      workItemId: "wi-test-001",
      details: "previous retry",
    });

    await handleCodeCIFailure(item, "some error", ctx);

    expect(triggerWorkflow).not.toHaveBeenCalled();
  });
});
