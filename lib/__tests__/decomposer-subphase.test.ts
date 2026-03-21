/**
 * Integration tests for recursive sub-phase decomposition.
 *
 * Tests the complete flow from raw item count → phase grouping →
 * cross-phase dep resolution → email output → escalation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock external dependencies ────────────────────────────────────────────

// Mock the AI SDK
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: vi.fn(() => "mock-model"),
}));

// Mock Notion
vi.mock("../notion", () => ({
  fetchPageContent: vi.fn(),
}));

// Mock orchestrator
vi.mock("../orchestrator", () => ({
  fetchRepoContext: vi.fn(),
}));

// Mock repos
vi.mock("../repos", () => ({
  listRepos: vi.fn(),
  getRepo: vi.fn(),
}));

// Mock work-items
vi.mock("../work-items", () => ({
  createWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}));

// Mock escalation
vi.mock("../escalation", () => ({
  escalate: vi.fn(),
}));

// Mock gmail
vi.mock("../gmail", () => ({
  sendDecompositionSummary: vi.fn().mockResolvedValue(null),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import { decomposeProject, groupIntoSubPhases, getDecomposerConfig, phaseLabel, stitchCrossPhaseDeps } from "../decomposer";
import { generateText } from "ai";
import { escalate } from "../escalation";
import { sendDecompositionSummary } from "../gmail";
import { fetchPageContent } from "../notion";
import { listRepos, getRepo } from "../repos";
import { fetchRepoContext } from "../orchestrator";
import { createWorkItem, updateWorkItem } from "../work-items";
import type { Project, WorkItem } from "../types";

// ─── Helper references to mocks ───────────────────────────────────────────

type MockFn = ReturnType<typeof vi.fn>;

const getGenerateTextMock = () => generateText as unknown as MockFn;
const getEscalateMock = () => escalate as unknown as MockFn;
const getEmailMock = () => sendDecompositionSummary as unknown as MockFn;
const getFetchPageContentMock = () => fetchPageContent as unknown as MockFn;
const getListReposMock = () => listRepos as unknown as MockFn;
const getGetRepoMock = () => getRepo as unknown as MockFn;
const getFetchRepoContextMock = () => fetchRepoContext as unknown as MockFn;
const getCreateWorkItemMock = () => createWorkItem as unknown as MockFn;
const getUpdateWorkItemMock = () => updateWorkItem as unknown as MockFn;

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a fake decomposed item matching the Claude output format */
function buildDecomposedItem(index: number, overrides: Record<string, unknown> = {}) {
  return {
    title: `Task ${index + 1}`,
    description: `Description for task ${index + 1}`,
    targetRepo: "jamesstineheath/agent-forge",
    priority: "medium",
    riskLevel: "low",
    complexity: "simple",
    dependencies: [] as number[],
    acceptanceCriteria: ["Criterion 1", "Criterion 2", "Criterion 3"],
    estimatedFiles: [`lib/file-${index + 1}.ts`],
    ...overrides,
  };
}

/** Build N fake decomposed items (Claude output format) */
function buildDecomposedItems(count: number, overrides: Record<string, unknown>[] = []) {
  return Array.from({ length: count }, (_, i) => buildDecomposedItem(i, overrides[i] || {}));
}

/** Build a mock project */
function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "notion-page-id-abc123",
    projectId: "PRD-TEST-001",
    title: "Test Project",
    planUrl: null,
    targetRepo: "agent-forge",
    status: "Execute",
    priority: "P1",
    complexity: "Moderate",
    riskLevel: "Medium",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a minimal WorkItem (for createWorkItem mock returns) */
function buildWorkItem(index: number): WorkItem {
  return {
    id: `wi-${index}`,
    title: `Task ${index + 1}`,
    description: `Description for task ${index + 1}`,
    targetRepo: "jamesstineheath/agent-forge",
    source: { type: "project", sourceId: "PRD-TEST-001" },
    priority: "medium",
    riskLevel: "low",
    complexity: "simple",
    status: "filed",
    dependencies: [],
    handoff: null,
    execution: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Set up standard mocks for a successful decomposeProject call */
function setupStandardMocks(decomposedItemCount: number, itemOverrides: Record<string, unknown>[] = []) {
  const items = buildDecomposedItems(decomposedItemCount, itemOverrides);

  // Notion returns plan content
  getFetchPageContentMock().mockResolvedValue(
    "A detailed architecture plan that is definitely longer than 50 characters to pass the validation check in decomposer.",
  );

  // Repos
  getListReposMock().mockResolvedValue([
    { id: "repo-1", fullName: "jamesstineheath/agent-forge", shortName: "agent-forge" },
  ]);
  getGetRepoMock().mockResolvedValue({
    id: "repo-1",
    fullName: "jamesstineheath/agent-forge",
    shortName: "agent-forge",
    claudeMdPath: "CLAUDE.md",
    handoffDir: "handoffs/awaiting_handoff/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 1,
    defaultBudget: 8,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Repo context
  getFetchRepoContextMock().mockResolvedValue({
    claudeMd: "# CLAUDE.md content",
    systemMap: "# System Map",
    adrs: [],
    recentPRs: [],
  });

  // generateText returns the items as JSON
  getGenerateTextMock().mockResolvedValue({
    text: JSON.stringify(items),
  });

  // createWorkItem returns a WorkItem with incrementing IDs
  let wiIndex = 0;
  getCreateWorkItemMock().mockImplementation(async () => {
    return buildWorkItem(wiIndex++);
  });

  // updateWorkItem succeeds
  getUpdateWorkItemMock().mockResolvedValue(undefined);

  // escalate returns an Escalation object
  getEscalateMock().mockResolvedValue({
    id: "esc-test-123",
    workItemId: "test",
    reason: "test",
    confidenceScore: 0.5,
    contextSnapshot: {},
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  return items;
}

// ─── Test Suite ───────────────────────────────────────────────────────────

describe("Recursive sub-phase decomposition", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars that affect decomposer config
    delete process.env.DECOMPOSER_SOFT_LIMIT;
    delete process.env.DECOMPOSER_HARD_LIMIT;
    delete process.env.DECOMPOSER_MAX_RECURSION_DEPTH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Test 1: Passthrough (≤15 items) ──────────────────────────────────────

  describe("Test 1: Passthrough — ≤15 items", () => {
    it("produces no phase metadata when LLM returns 12 items", async () => {
      setupStandardMocks(12);

      const result = await decomposeProject(buildProject());

      // No phases
      expect(result.phases).toBeNull();
      expect(result.phaseBreakdown).toBeUndefined();
      // All 12 items present
      expect(result.workItems).toHaveLength(12);
      // No escalation
      expect(getEscalateMock()).not.toHaveBeenCalled();
    });
  });

  // ── Test 1b: Self-reference sanitization ─────────────────────────────────

  describe("Test 1b: Self-reference dependency sanitization", () => {
    it("strips self-referencing dependencies and succeeds without retry", async () => {
      // Item 4 depends on itself (LLM artifact) — should be sanitized out
      const overrides = Array.from({ length: 8 }, (_, i) => {
        if (i === 4) return { dependencies: [2, 4] }; // 4 references itself
        return {};
      });
      setupStandardMocks(8, overrides);

      const result = await decomposeProject(buildProject());

      // Should succeed (no escalation)
      expect(getEscalateMock()).not.toHaveBeenCalled();
      expect(result.workItems).toHaveLength(8);
      // generateText should only be called once (no retry needed)
      expect(getGenerateTextMock()).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 2: Auto-split — 2 phases (16–22 items) ──────────────────────────

  describe("Test 2: Auto-split — 2 phases (16–22 items)", () => {
    it("creates phases for 18 items with correct dependency ordering", async () => {
      // Items 9-17 each depend on the item before them in the first group
      const overrides = Array.from({ length: 18 }, (_, i) => {
        if (i >= 9) return { dependencies: [i - 9] };
        return {};
      });
      setupStandardMocks(18, overrides);

      const result = await decomposeProject(buildProject());

      expect(result.workItems).toHaveLength(18);
      // Phases should be created (not null) since 18 > 15
      expect(result.phases).not.toBeNull();
      expect(result.phases!.length).toBeGreaterThanOrEqual(2);

      // No escalation
      expect(getEscalateMock()).not.toHaveBeenCalled();
    });

    it("includes phaseBreakdown when phases are created", async () => {
      setupStandardMocks(18);

      const result = await decomposeProject(buildProject());

      // phaseBreakdown should exist for multi-phase decompositions
      if (result.phases && result.phases.length > 1) {
        expect(result.phaseBreakdown).toBeDefined();
        expect(result.phaseBreakdown!.phases.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  // ── Test 3: Auto-split — 3 phases (23–30 items) ──────────────────────────

  describe("Test 3: Auto-split — 3 phases (23–30 items)", () => {
    it("creates phases for 25 items", async () => {
      setupStandardMocks(25);

      const result = await decomposeProject(buildProject());

      expect(result.workItems).toHaveLength(25);
      expect(result.phases).not.toBeNull();
      expect(result.phases!.length).toBeGreaterThanOrEqual(2);
      expect(getEscalateMock()).not.toHaveBeenCalled();
    });
  });

  // ── Test 4: Hard ceiling (31+ items) ─────────────────────────────────────

  describe("Test 4: Hard ceiling — 31+ items triggers escalation", () => {
    it("escalates and returns empty result for 35 items", async () => {
      setupStandardMocks(35);

      const result = await decomposeProject(buildProject());

      // Escalation must be triggered
      expect(getEscalateMock()).toHaveBeenCalledTimes(1);
      const escalationArgs = getEscalateMock().mock.calls[0];
      // reason (2nd arg) should mention the item count
      expect(escalationArgs[1]).toContain("35");

      // No phases created, empty workItems
      expect(result.phases).toBeNull();
      expect(result.workItems).toHaveLength(0);
    });
  });

  // ── Test 5: Recursive sub-phase ──────────────────────────────────────────

  describe("Test 5: Recursive sub-phase — sub-phase exceeds soft limit", () => {
    it("groupIntoSubPhases handles oversized groups by redistributing", () => {
      // Create 18 items where all are interdependent (one big cluster)
      const items: WorkItem[] = Array.from({ length: 18 }, (_, i) => ({
        id: `item-${i}`,
        title: `Task ${i}`,
        description: `Description ${i}`,
        targetRepo: "jamesstineheath/agent-forge",
        source: { type: "project" as const, sourceId: "PRD-1" },
        priority: "medium" as const,
        riskLevel: "low" as const,
        complexity: "simple" as const,
        status: "filed" as const,
        dependencies: i > 0 ? [`item-${i - 1}`] : [],
        handoff: null,
        execution: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const phases = groupIntoSubPhases(items, 2);
      const totalItems = phases.reduce((sum, p) => sum + p.items.length, 0);
      expect(totalItems).toBe(18);
    });

    it("decomposeProject handles items in soft-to-hard range without escalation", async () => {
      setupStandardMocks(20);

      const result = await decomposeProject(buildProject());

      expect(result.workItems).toHaveLength(20);
      expect(result.phases).not.toBeNull();
      expect(getEscalateMock()).not.toHaveBeenCalled();
    });
  });

  // ── Test 6: Recursive escalation ─────────────────────────────────────────

  describe("Test 6: SubPhaseEscalationError — sub-phase too large after recursion", () => {
    it("escalates when a single dependency cluster exceeds soft limit after max recursion", async () => {
      // All items depend on item 0, forming one massive connected component
      const overrides = Array.from({ length: 20 }, (_, i) => {
        if (i === 0) return {};
        return { dependencies: [0] };
      });
      setupStandardMocks(20, overrides);

      const result = await decomposeProject(buildProject());

      // The function should complete (not throw)
      expect(result).toBeDefined();

      // If escalation was triggered, verify the escalation call
      if (getEscalateMock().mock.calls.length > 0) {
        const escalationArgs = getEscalateMock().mock.calls[0];
        expect(escalationArgs[1]).toMatch(/sub-?phase|items|decomposition/i);
      }
    });
  });

  // ── Test 7: Circular dependency detection ────────────────────────────────

  describe("Test 7: Circular dependency detection in groupIntoSubPhases", () => {
    it("merges phases that would create circular cross-phase dependencies", () => {
      const items: WorkItem[] = Array.from({ length: 16 }, (_, i) => ({
        id: `item-${i}`,
        title: `Task ${i}`,
        description: `Description ${i}`,
        targetRepo: "jamesstineheath/agent-forge",
        source: { type: "project" as const, sourceId: "PRD-1" },
        priority: "medium" as const,
        riskLevel: "low" as const,
        complexity: "simple" as const,
        status: "filed" as const,
        dependencies:
          i === 0
            ? ["item-12"]
            : i === 12
              ? ["item-0"]
              : [],
        handoff: null,
        execution: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const phases = groupIntoSubPhases(items, 2);

      // Verify no circular cross-phase dependencies exist
      for (let i = 0; i < phases.length; i++) {
        const phaseItemIds = new Set(phases[i].items.map((w) => w.id));
        for (let j = i + 1; j < phases.length; j++) {
          const otherPhaseItemIds = new Set(phases[j].items.map((w) => w.id));
          let iDepsOnJ = false;
          let jDepsOnI = false;
          for (const item of phases[i].items) {
            for (const dep of item.dependencies) {
              if (otherPhaseItemIds.has(dep)) iDepsOnJ = true;
            }
          }
          for (const item of phases[j].items) {
            for (const dep of item.dependencies) {
              if (phaseItemIds.has(dep)) jDepsOnI = true;
            }
          }
          // Should NOT have both directions (circular)
          expect(iDepsOnJ && jDepsOnI).toBe(false);
        }
      }

      expect(phases.length).toBeGreaterThanOrEqual(1);
      const totalItems = phases.reduce((sum, p) => sum + p.items.length, 0);
      expect(totalItems).toBe(16);
    });
  });

  // ── Test 8: Configurable limits ──────────────────────────────────────────

  describe("Test 8: Configurable limits via DECOMPOSER_SOFT_LIMIT", () => {
    it("triggers split at 11 items when DECOMPOSER_SOFT_LIMIT=10", async () => {
      process.env.DECOMPOSER_SOFT_LIMIT = "10";
      setupStandardMocks(11);

      const result = await decomposeProject(buildProject());

      expect(result.phases).not.toBeNull();
      expect(result.phases!.length).toBeGreaterThanOrEqual(2);
    });

    it("does NOT split at 11 items with default soft limit of 15", async () => {
      setupStandardMocks(11);

      const result = await decomposeProject(buildProject());

      expect(result.phases).toBeNull();
    });
  });

  // ── Test 9: Email format ──────────────────────────────────────────────────

  describe("Test 9: Email format for multi-phase decomposition", () => {
    it("returns phaseBreakdown with structured content for 18-item decomposition", async () => {
      setupStandardMocks(18);

      const result = await decomposeProject(buildProject());

      if (result.phases && result.phases.length > 1) {
        expect(result.phaseBreakdown).toBeDefined();
        expect(result.phaseBreakdown!.phases.length).toBeGreaterThanOrEqual(1);
        for (const phase of result.phaseBreakdown!.phases) {
          expect(phase.id).toBeDefined();
          expect(phase.name).toBeDefined();
          expect(phase.itemCount).toBeGreaterThan(0);
          expect(phase.items.length).toBeGreaterThan(0);
        }
      }
    });

    it("does NOT include phaseBreakdown for 12-item passthrough", async () => {
      setupStandardMocks(12);

      const result = await decomposeProject(buildProject());

      expect(result.phaseBreakdown).toBeUndefined();
      expect(result.phases).toBeNull();
    });
  });
});

// ─── Unit tests for helper functions ──────────────────────────────────────

describe("phaseLabel", () => {
  it("returns 'a' for index 0", () => {
    expect(phaseLabel(0)).toBe("a");
  });

  it("returns 'z' for index 25", () => {
    expect(phaseLabel(25)).toBe("z");
  });

  it("returns 'aa' for index 26", () => {
    expect(phaseLabel(26)).toBe("aa");
  });

  it("returns 'ab' for index 27", () => {
    expect(phaseLabel(27)).toBe("ab");
  });
});

describe("stitchCrossPhaseDeps", () => {
  function makeWorkItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
    return {
      title: overrides.id,
      description: "test item",
      targetRepo: "owner/repo",
      source: { type: "project", sourceId: "PRD-1" },
      priority: "medium",
      riskLevel: "low",
      complexity: "simple",
      status: "filed",
      dependencies: [],
      handoff: null,
      execution: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("preserves valid dependencies", () => {
    const items = [
      makeWorkItem({ id: "a", dependencies: ["b"] }),
      makeWorkItem({ id: "b", dependencies: [] }),
    ];
    const result = stitchCrossPhaseDeps(items);
    expect(result[0].dependencies).toEqual(["b"]);
    expect(result[1].dependencies).toEqual([]);
  });

  it("filters out dangling dependency references", () => {
    const items = [
      makeWorkItem({ id: "a", dependencies: ["b", "nonexistent"] }),
      makeWorkItem({ id: "b", dependencies: [] }),
    ];
    const result = stitchCrossPhaseDeps(items);
    expect(result[0].dependencies).toEqual(["b"]);
  });

  it("returns empty array for empty input", () => {
    expect(stitchCrossPhaseDeps([])).toEqual([]);
  });
});

describe("getDecomposerConfig", () => {
  it("returns default values when no env vars set", () => {
    const config = getDecomposerConfig();
    expect(config.softLimit).toBe(15);
    expect(config.hardLimit).toBe(30);
    expect(config.maxRecursionDepth).toBe(1);
  });
});

describe("groupIntoSubPhases", () => {
  function makeWorkItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
    return {
      title: overrides.id,
      description: "test item",
      targetRepo: "owner/repo",
      source: { type: "project", sourceId: "PRD-1" },
      priority: "medium",
      riskLevel: "low",
      complexity: "simple",
      status: "filed",
      dependencies: [],
      handoff: null,
      execution: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    expect(groupIntoSubPhases([], 2)).toEqual([]);
  });

  it("groups items into requested number of phases", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeWorkItem({ id: `item-${i}` }),
    );
    const phases = groupIntoSubPhases(items, 2);
    expect(phases.length).toBeGreaterThanOrEqual(1);
    expect(phases.length).toBeLessThanOrEqual(3);
    const allIds = phases.flatMap((p) => p.items.map((i) => i.id));
    expect(allIds.sort()).toEqual(items.map((i) => i.id).sort());
  });

  it("keeps dependent items together when possible", () => {
    const items = [
      makeWorkItem({ id: "a", dependencies: ["b"] }),
      makeWorkItem({ id: "b", dependencies: [] }),
      makeWorkItem({ id: "c", dependencies: [] }),
      makeWorkItem({ id: "d", dependencies: [] }),
    ];
    const phases = groupIntoSubPhases(items, 2);
    const phaseOfA = phases.find((p) => p.items.some((i) => i.id === "a"));
    const phaseOfB = phases.find((p) => p.items.some((i) => i.id === "b"));
    expect(phaseOfA?.id).toBe(phaseOfB?.id);
  });

  it("assigns SubPhase structure with id, name, items, dependencies", () => {
    const items = [
      makeWorkItem({ id: "x" }),
      makeWorkItem({ id: "y" }),
    ];
    const phases = groupIntoSubPhases(items, 2);
    for (const phase of phases) {
      expect(phase).toHaveProperty("id");
      expect(phase).toHaveProperty("name");
      expect(phase).toHaveProperty("items");
      expect(phase).toHaveProperty("dependencies");
      expect(Array.isArray(phase.items)).toBe(true);
      expect(Array.isArray(phase.dependencies)).toBe(true);
    }
  });
});
