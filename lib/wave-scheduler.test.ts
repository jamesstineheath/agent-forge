import { describe, it, expect } from "vitest";
import { assignWaves, assignWavesSafe, detectCircularDependencies, WaveSchedulerInput } from "./wave-scheduler";

// Helper to build a minimal WaveSchedulerInput
function makeItem(
  id: string,
  dependsOn: string[] = [],
  filesBeingModified: string[] = []
): WaveSchedulerInput {
  return { id, dependsOn, filesBeingModified, createdAt: new Date("2024-01-01") };
}

// Helper to get a map of workItemId → waveNumber from results
function waveMap(
  items: WaveSchedulerInput[]
): Record<string, number> {
  const result = assignWaves(items);
  return Object.fromEntries(result.map((r) => [r.workItemId, r.waveNumber]));
}

describe("assignWaves", () => {
  describe("empty and single-item inputs", () => {
    it("returns empty array for empty input", () => {
      expect(assignWaves([])).toEqual([]);
    });

    it("assigns wave 0 to a single item with no dependencies", () => {
      const waves = waveMap([makeItem("A")]);
      expect(waves).toEqual({ A: 0 });
    });

    it("assigns wave 0 to a single item with an empty dependsOn array", () => {
      const waves = waveMap([makeItem("A", [])]);
      expect(waves).toEqual({ A: 0 });
    });
  });

  describe("items with no dependencies", () => {
    it("assigns wave 0 to all independent items", () => {
      const items = [makeItem("A"), makeItem("B"), makeItem("C")];
      const waves = waveMap(items);
      expect(waves).toEqual({ A: 0, B: 0, C: 0 });
    });
  });

  describe("linear chain", () => {
    it("assigns sequential waves to a linear dependency chain", () => {
      // A → B → C → D (D depends on C, C on B, B on A)
      const items = [
        makeItem("A"),
        makeItem("B", ["A"]),
        makeItem("C", ["B"]),
        makeItem("D", ["C"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(2);
      expect(waves.D).toBe(3);
    });

    it("handles items provided in reverse dependency order", () => {
      // Input order: D, C, B, A — output should still be correct
      const items = [
        makeItem("D", ["C"]),
        makeItem("C", ["B"]),
        makeItem("B", ["A"]),
        makeItem("A"),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(2);
      expect(waves.D).toBe(3);
    });
  });

  describe("diamond DAG", () => {
    it("correctly assigns wave 2 to the convergence node in a diamond", () => {
      // A → B, A → C, B → D, C → D
      // Wave: A=0, B=1, C=1, D=2
      const items = [
        makeItem("A"),
        makeItem("B", ["A"]),
        makeItem("C", ["A"]),
        makeItem("D", ["B", "C"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(1);
      expect(waves.D).toBe(2);
    });
  });

  describe("parallel branches", () => {
    it("assigns independent waves to parallel branches", () => {
      // Two separate chains: A→B→C and X→Y
      const items = [
        makeItem("A"),
        makeItem("B", ["A"]),
        makeItem("C", ["B"]),
        makeItem("X"),
        makeItem("Y", ["X"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(1);
      expect(waves.C).toBe(2);
      expect(waves.X).toBe(0);
      expect(waves.Y).toBe(1);
    });
  });

  describe("complex DAG — longest path wins", () => {
    it("assigns wave based on longest path when multiple paths reach same node", () => {
      // A=0, B=0, C depends on A (wave 1), D depends on B (wave 1), E depends on C and D
      // but also: F=0, G depends on F (wave 1), H depends on G (wave 2), E also depends on H
      // So E's wave = max(1, 1, 2) + 1 = 3
      const items = [
        makeItem("A"),
        makeItem("B"),
        makeItem("C", ["A"]),
        makeItem("D", ["B"]),
        makeItem("F"),
        makeItem("G", ["F"]),
        makeItem("H", ["G"]),
        makeItem("E", ["C", "D", "H"]),
      ];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(0);
      expect(waves.F).toBe(0);
      expect(waves.C).toBe(1);
      expect(waves.D).toBe(1);
      expect(waves.G).toBe(1);
      expect(waves.H).toBe(2);
      expect(waves.E).toBe(3);
    });
  });

  describe("dangling/unknown dependency references", () => {
    it("treats items with only unknown dependencies as wave 0", () => {
      // B depends on 'NONEXISTENT' which is not in the input set
      const items = [makeItem("A"), makeItem("B", ["NONEXISTENT"])];
      const waves = waveMap(items);
      expect(waves.A).toBe(0);
      expect(waves.B).toBe(0);
    });

    it("filters out unknown dependency IDs from WaveAssignment.dependsOn", () => {
      const items = [makeItem("A"), makeItem("B", ["A", "GHOST"])];
      const results = assignWaves(items);
      const bResult = results.find((r) => r.workItemId === "B")!;
      expect(bResult.dependsOn).toEqual(["A"]);
      expect(bResult.waveNumber).toBe(1);
    });
  });

  describe("WaveAssignment output shape", () => {
    it("includes workItemId, waveNumber, dependsOn, and filesBeingModified", () => {
      const items = [
        makeItem("A", [], ["lib/foo.ts"]),
        makeItem("B", ["A"], ["lib/bar.ts", "lib/baz.ts"]),
      ];
      const results = assignWaves(items);

      expect(results).toHaveLength(2);

      const aResult = results.find((r) => r.workItemId === "A")!;
      expect(aResult.workItemId).toBe("A");
      expect(aResult.waveNumber).toBe(0);
      expect(aResult.dependsOn).toEqual([]);
      expect(aResult.filesBeingModified).toEqual(["lib/foo.ts"]);

      const bResult = results.find((r) => r.workItemId === "B")!;
      expect(bResult.workItemId).toBe("B");
      expect(bResult.waveNumber).toBe(1);
      expect(bResult.dependsOn).toEqual(["A"]);
      expect(bResult.filesBeingModified).toEqual(["lib/bar.ts", "lib/baz.ts"]);
    });

    it("preserves input order in the output array", () => {
      const items = [makeItem("C"), makeItem("A"), makeItem("B")];
      const results = assignWaves(items);
      expect(results.map((r) => r.workItemId)).toEqual(["C", "A", "B"]);
    });
  });

  describe("circular dependency detection — assignWaves throws", () => {
    it("throws on a simple two-node cycle", () => {
      const items = [makeItem("A", ["B"]), makeItem("B", ["A"])];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });

    it("throws on a three-node cycle", () => {
      const items = [
        makeItem("A", ["C"]),
        makeItem("B", ["A"]),
        makeItem("C", ["B"]),
      ];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });

    it("includes the cycle path in the error message", () => {
      const items = [makeItem("A", ["B"]), makeItem("B", ["A"])];
      let errorMessage = "";
      try {
        assignWaves(items);
      } catch (e) {
        errorMessage = (e as Error).message;
      }
      // Cycle path should mention both nodes
      expect(errorMessage).toMatch(/A/);
      expect(errorMessage).toMatch(/B/);
      expect(errorMessage).toMatch(/→/);
    });

    it("throws on a self-referencing item", () => {
      const items = [makeItem("A", ["A"])];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });

    it("throws even when cycle is embedded in a larger valid graph", () => {
      const items = [
        makeItem("Root"),
        makeItem("A", ["Root"]),
        makeItem("B", ["A", "C"]),
        makeItem("C", ["B"]), // B → C → B cycle
      ];
      expect(() => assignWaves(items)).toThrow(/[Cc]ircular/);
    });
  });
});

describe("assignWaves — file-overlap conflict detection", () => {
  function makeOverlapItem(
    id: string,
    deps: string[],
    files: string[],
    createdAt: string
  ): WaveSchedulerInput {
    return {
      id,
      dependsOn: deps,
      filesBeingModified: files,
      createdAt: new Date(createdAt),
    };
  }

  it("does not bump items when no file overlap exists", () => {
    const items = [
      makeOverlapItem("a", [], ["src/foo.ts"], "2024-01-01T00:00:00Z"),
      makeOverlapItem("b", [], ["src/bar.ts"], "2024-01-01T00:01:00Z"),
    ];
    const result = waveMap(items);
    expect(result.a).toBe(0);
    expect(result.b).toBe(0);
  });

  it("bumps the later item (by createdAt) when file overlap is detected", () => {
    const items = [
      makeOverlapItem("a", [], ["src/shared.ts"], "2024-01-01T00:00:00Z"),
      makeOverlapItem("b", [], ["src/shared.ts"], "2024-01-01T00:01:00Z"),
    ];
    const result = waveMap(items);
    expect(result.a).toBe(0);
    expect(result.b).toBe(1);
  });

  it("cascades dependents of a bumped item to a later wave", () => {
    const items = [
      makeOverlapItem("a", [], ["src/shared.ts"], "2024-01-01T00:00:00Z"),
      makeOverlapItem("b", [], ["src/shared.ts"], "2024-01-01T00:01:00Z"),
      makeOverlapItem("c", ["b"], ["src/other.ts"], "2024-01-01T00:02:00Z"),
    ];
    const result = waveMap(items);
    expect(result.a).toBe(0);
    expect(result.b).toBe(1);
    expect(result.c).toBe(2);
  });

  it("never triggers conflict for items with empty filesBeingModified", () => {
    const items = [
      makeOverlapItem("a", [], [], "2024-01-01T00:00:00Z"),
      makeOverlapItem("b", [], [], "2024-01-01T00:01:00Z"),
    ];
    const result = waveMap(items);
    expect(result.a).toBe(0);
    expect(result.b).toBe(0);
  });

  it("never triggers conflict for items with undefined filesBeingModified", () => {
    const items = [
      { id: "a", dependsOn: [], createdAt: new Date("2024-01-01T00:00:00Z") },
      { id: "b", dependsOn: [], createdAt: new Date("2024-01-01T00:01:00Z") },
    ];
    const result = waveMap(items as unknown as WaveSchedulerInput[]);
    expect(result.a).toBe(0);
    expect(result.b).toBe(0);
  });
});

describe("detectCircularDependencies", () => {
  it("returns null for an empty list", () => {
    expect(detectCircularDependencies([])).toBeNull();
  });

  it("returns null for a valid DAG", () => {
    const items = [
      makeItem("A"),
      makeItem("B", ["A"]),
      makeItem("C", ["A", "B"]),
    ];
    expect(detectCircularDependencies(items)).toBeNull();
  });

  it("returns the cycle path for a two-node cycle", () => {
    const items = [makeItem("A", ["B"]), makeItem("B", ["A"])];
    const cycle = detectCircularDependencies(items);
    expect(cycle).not.toBeNull();
    expect(Array.isArray(cycle)).toBe(true);
    expect(cycle!.length).toBeGreaterThanOrEqual(2);
    // The cycle array should start and end with the same node
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it("returns null when dependsOn references unknown IDs (no actual cycle)", () => {
    const items = [makeItem("A", ["UNKNOWN"]), makeItem("B", ["A"])];
    expect(detectCircularDependencies(items)).toBeNull();
  });

  it("returns cycle path for a self-reference", () => {
    const items = [makeItem("A", ["A"])];
    const cycle = detectCircularDependencies(items);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain("A");
  });
});

describe("assignWaves — undefined/null dependsOn handling", () => {
  it("treats undefined dependsOn as wave 0 (normal flow)", () => {
    const item = makeItem("x");
    (item as unknown as Record<string, unknown>).dependsOn = undefined;
    const result = assignWaves([item]);
    expect(result[0].waveNumber).toBe(0);
  });

  it("treats null dependsOn as wave 0 (normal flow)", () => {
    const item = makeItem("y");
    (item as unknown as Record<string, unknown>).dependsOn = null;
    const result = assignWaves([item]);
    expect(result[0].waveNumber).toBe(0);
  });
});

describe("assignWavesSafe", () => {
  it("returns fallback=false on successful assignment", () => {
    const items = [makeItem("a"), makeItem("b", ["a"])];
    const result = assignWavesSafe(items);
    expect(result.fallback).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.assignments).toHaveLength(2);
  });

  it("returns fallback=true with all items at wave 0 on circular dependency", () => {
    const items = [makeItem("a", ["b"]), makeItem("b", ["a"])];
    const result = assignWavesSafe(items);
    expect(result.fallback).toBe(true);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/[Cc]ircular/);
    expect(result.assignments).toHaveLength(2);
    for (const a of result.assignments) {
      expect(a.waveNumber).toBe(0);
    }
  });

  it("includes all item IDs in fallback assignments", () => {
    const items = [makeItem("x", ["y"]), makeItem("y", ["x"])];
    const result = assignWavesSafe(items);
    expect(result.fallback).toBe(true);
    const ids = result.assignments.map((a) => a.workItemId).sort();
    expect(ids).toEqual(["x", "y"]);
  });
});
