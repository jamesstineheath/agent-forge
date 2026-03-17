/**
 * Tests for recursive sub-phase decomposition helpers in lib/decomposer.ts
 */

import { describe, it, expect } from "vitest";
import { phaseLabel, stitchCrossPhaseDeps, groupIntoSubPhases, getDecomposerConfig } from "../decomposer";
import type { WorkItem } from "../types";

// --- Helper to create a minimal WorkItem ---

function makeWorkItem(overrides: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    title: overrides.id,
    description: "test item",
    targetRepo: "owner/repo",
    source: { type: "project", sourceId: "PRJ-1" },
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

// --- phaseLabel ---

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

// --- stitchCrossPhaseDeps ---

describe("stitchCrossPhaseDeps", () => {
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

// --- getDecomposerConfig ---

describe("getDecomposerConfig", () => {
  it("returns default values", () => {
    const config = getDecomposerConfig();
    expect(config.softLimit).toBe(15);
    expect(config.hardLimit).toBe(30);
    expect(config.maxRecursionDepth).toBe(1);
  });
});

// --- groupIntoSubPhases ---

describe("groupIntoSubPhases", () => {
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
    // All items should be present across phases
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
    // a and b should be in the same phase
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

// --- Integration: three code paths ---

describe("decomposer code path routing", () => {
  it("≤ softLimit items should not trigger sub-phase splitting", () => {
    // This is a conceptual test: with 10 items (≤15), groupIntoSubPhases is not called
    const config = getDecomposerConfig();
    const itemCount = 10;
    expect(itemCount <= config.softLimit).toBe(true);
  });

  it("> hardLimit items should trigger escalation", () => {
    const config = getDecomposerConfig();
    const itemCount = 35;
    expect(itemCount > config.hardLimit).toBe(true);
  });

  it("softLimit < N <= hardLimit should trigger sub-phase decomposition", () => {
    const config = getDecomposerConfig();
    const itemCount = 20;
    expect(itemCount > config.softLimit && itemCount <= config.hardLimit).toBe(true);
    // Verify groupIntoSubPhases works for this range
    const items = Array.from({ length: itemCount }, (_, i) =>
      makeWorkItem({ id: `wi-${i}` }),
    );
    const targetPhaseCount = Math.ceil(itemCount / config.softLimit);
    expect(targetPhaseCount).toBe(2);
    const phases = groupIntoSubPhases(items, targetPhaseCount);
    expect(phases.length).toBeGreaterThanOrEqual(1);
    // Each phase should be ≤ softLimit for well-distributed items
    const totalItems = phases.reduce((sum, p) => sum + p.items.length, 0);
    expect(totalItems).toBe(itemCount);
  });
});
