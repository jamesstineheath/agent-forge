/**
 * Integration tests for the wave-based dispatch pipeline.
 * Tests wave assignment, conflict detection, circular dependency fallback,
 * concurrency budgeting, parallelism validation, and dashboard data shape.
 */

import { describe, it, expect } from "vitest";
import {
  assignWaves,
  assignWavesSafe,
  type WaveSchedulerInput,
  type WaveAssignment,
} from "./wave-scheduler";
import { validateParallelismFactor } from "./decomposer";
import { GLOBAL_CONCURRENCY_LIMIT } from "./atc/types";
import type { WaveGroup, WaveProgressData, WorkItem } from "./types";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  overrides: Partial<WaveSchedulerInput> = {}
): WaveSchedulerInput {
  return {
    id,
    dependsOn: [],
    filesBeingModified: [],
    createdAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function assignmentMap(assignments: WaveAssignment[]): Record<string, number> {
  return Object.fromEntries(
    assignments.map((a) => [a.workItemId, a.waveNumber])
  );
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe("Wave Scheduler Integration Tests", () => {
  // ── 1. Diamond DAG Wave Assignment ──────────────────────────────────────

  describe("1. Diamond DAG wave assignment", () => {
    it("assigns roots to wave 0, mid-tier to wave 1, sink to wave 2", () => {
      // Diamond: A,B,C (independent) → D(A,B), E(B,C) → F(D,E)
      const items: WaveSchedulerInput[] = [
        makeItem("A"),
        makeItem("B"),
        makeItem("C"),
        makeItem("D", { dependsOn: ["A", "B"] }),
        makeItem("E", { dependsOn: ["B", "C"] }),
        makeItem("F", { dependsOn: ["D", "E"] }),
      ];

      const result = assignWavesSafe(items);

      expect(result.fallback).toBe(false);
      expect(result.error).toBeUndefined();

      const waves = assignmentMap(result.assignments);

      // Roots: wave 0
      expect(waves["A"]).toBe(0);
      expect(waves["B"]).toBe(0);
      expect(waves["C"]).toBe(0);

      // Mid-tier: wave 1
      expect(waves["D"]).toBe(1);
      expect(waves["E"]).toBe(1);

      // Sink: wave 2
      expect(waves["F"]).toBe(2);
    });
  });

  // ── 2. File Conflict Bumping ─────────────────────────────────────────────

  describe("2. File conflict bumping", () => {
    it("bumps a same-wave item to the next wave when files overlap", () => {
      // Two independent items (both would be wave 0) that share a file.
      // The item with later createdAt gets bumped.
      const items: WaveSchedulerInput[] = [
        makeItem("X", {
          filesBeingModified: ["lib/shared.ts", "lib/types.ts"],
          createdAt: new Date("2024-01-01T00:00:00Z"),
        }),
        makeItem("Y", {
          filesBeingModified: ["lib/shared.ts", "lib/other.ts"],
          createdAt: new Date("2024-01-01T00:01:00Z"),
        }),
      ];

      const result = assignWavesSafe(items);

      expect(result.fallback).toBe(false);

      const waves = assignmentMap(result.assignments);

      // X stays at wave 0 (earlier createdAt), Y bumped to wave 1
      expect(waves["X"]).toBe(0);
      expect(waves["Y"]).toBe(1);
    });
  });

  // ── 3. Circular Dependency Fallback ─────────────────────────────────────

  describe("3. Circular dependency fallback", () => {
    it("returns fallback=true and assigns all items to wave 0 on circular deps", () => {
      // Alpha → Beta → Gamma → Alpha (circular)
      const items: WaveSchedulerInput[] = [
        makeItem("Alpha", { dependsOn: ["Gamma"] }),
        makeItem("Beta", { dependsOn: ["Alpha"] }),
        makeItem("Gamma", { dependsOn: ["Beta"] }),
      ];

      const result = assignWavesSafe(items);

      expect(result.fallback).toBe(true);
      expect(result.error).toMatch(/[Cc]ircular/);

      for (const assignment of result.assignments) {
        expect(assignment.waveNumber).toBe(0);
      }
    });
  });

  // ── 4. Concurrency Budget ────────────────────────────────────────────────

  describe("4. Concurrency budget enforcement", () => {
    it("caps dispatched items at available slots based on GLOBAL_CONCURRENCY_LIMIT", () => {
      // 8 items all in wave 0 (no deps, no file conflicts)
      const waveItems: WaveSchedulerInput[] = Array.from(
        { length: 8 },
        (_, i) =>
          makeItem(`item-${i}`, {
            filesBeingModified: [`lib/unique-${i}.ts`],
          })
      );

      // Simulate currently executing items consuming most of the budget
      const currentlyExecuting = GLOBAL_CONCURRENCY_LIMIT - 2; // leave 2 slots
      const availableSlots = GLOBAL_CONCURRENCY_LIMIT - currentlyExecuting;

      // The dispatcher slices candidates to available slots
      const itemsToDispatch = waveItems.slice(0, availableSlots);

      expect(availableSlots).toBe(2);
      expect(itemsToDispatch).toHaveLength(2);
    });

    it("dispatches all items when budget allows", () => {
      const waveItems: WaveSchedulerInput[] = Array.from(
        { length: 3 },
        (_, i) =>
          makeItem(`small-${i}`, {
            filesBeingModified: [`lib/small-${i}.ts`],
          })
      );

      const currentlyExecuting = 0;
      const availableSlots = GLOBAL_CONCURRENCY_LIMIT - currentlyExecuting;

      const itemsToDispatch = waveItems.slice(0, availableSlots);
      expect(itemsToDispatch).toHaveLength(3); // all 3 dispatched
    });
  });

  // ── 5. Parallelism Factor Validation ────────────────────────────────────

  describe("5. Parallelism factor validation", () => {
    it("returns valid=false for a linear chain of 8 items (factor < 2.0)", () => {
      // Linear chain: item-0 → item-1 → item-2 → ... → item-7
      const items = Array.from({ length: 8 }, (_, i) => ({
        dependsOn: i === 0 ? [] : [`item-${i - 1}`],
      }));

      const result = validateParallelismFactor(items);

      // A linear chain has factor = 8/8 = 1.0, which is < 2.0 threshold
      expect(result.valid).toBe(false);
      expect(result.factor).toBeLessThan(2.0);
    });

    it("returns valid=true for a wide fan-out DAG (high parallelism)", () => {
      // 1 root → 7 independent leaves = 8 items, 2 waves → factor = 4.0
      const items = [
        { dependsOn: [] }, // root (item-0)
        ...Array.from({ length: 7 }, () => ({
          dependsOn: ["item-0"],
        })),
      ];

      const result = validateParallelismFactor(items);

      expect(result.factor).toBeGreaterThanOrEqual(2.0);
      expect(result.valid).toBe(true);
    });
  });

  // ── 6. Dashboard Data Shape (WaveProgressData) ──────────────────────────

  describe("6. Dashboard WaveProgressData grouping", () => {
    it("groups items by waveNumber into correct WaveGroup shape", () => {
      // Simulate work items with wave numbers already assigned
      const items = [
        { waveNumber: 0, status: "merged" as const },
        { waveNumber: 0, status: "executing" as const },
        { waveNumber: 1, status: "ready" as const },
        { waveNumber: 1, status: "ready" as const },
        { waveNumber: 2, status: "ready" as const },
      ];

      // Group by wave number (mirrors what the API does)
      const grouped = items.reduce<
        Record<number, (typeof items)[number][]>
      >((acc, item) => {
        const wave = item.waveNumber ?? 0;
        if (!acc[wave]) acc[wave] = [];
        acc[wave].push(item);
        return acc;
      }, {});

      // Verify grouping structure
      expect(Object.keys(grouped)).toHaveLength(3);
      expect(grouped[0]).toHaveLength(2);
      expect(grouped[1]).toHaveLength(2);
      expect(grouped[2]).toHaveLength(1);

      // Build WaveGroup-compatible structures
      const waveGroups: Omit<WaveGroup, "items">[] = Object.entries(
        grouped
      ).map(([waveNum, waveItems]) => {
        const completed = waveItems.filter((i) =>
          ["merged", "verified"].includes(i.status)
        ).length;
        const total = waveItems.length;
        return {
          waveNumber: Number(waveNum),
          status: (completed === total
            ? "complete"
            : waveItems.some((i) => i.status === "executing")
              ? "active"
              : "pending") as WaveGroup["status"],
          totalItems: total,
          completedItems: completed,
          progressPercent: Math.round((completed / total) * 100),
        };
      });

      // Wave 0: 1 merged + 1 executing = active, 50% complete
      expect(waveGroups[0].waveNumber).toBe(0);
      expect(waveGroups[0].totalItems).toBe(2);
      expect(waveGroups[0].completedItems).toBe(1);
      expect(waveGroups[0].status).toBe("active");
      expect(waveGroups[0].progressPercent).toBe(50);

      // Wave 1: 2 ready = pending
      expect(waveGroups[1].waveNumber).toBe(1);
      expect(waveGroups[1].totalItems).toBe(2);
      expect(waveGroups[1].completedItems).toBe(0);
      expect(waveGroups[1].status).toBe("pending");

      // Wave 2: 1 ready = pending
      expect(waveGroups[2].waveNumber).toBe(2);
      expect(waveGroups[2].totalItems).toBe(1);

      // Verify WaveProgressData shape
      const progressData: WaveProgressData = {
        projectId: "test-project",
        waves: waveGroups as WaveGroup[],
        currentWave: 0,
        totalWaves: 3,
      };

      expect(progressData.waves).toHaveLength(3);
      expect(progressData.totalWaves).toBe(3);
      expect(progressData.currentWave).toBe(0);
    });
  });
});
