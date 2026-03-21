/**
 * Tests for work item status transition guards.
 *
 * Validates that terminal statuses (cancelled, merged, obsolete) cannot be
 * transitioned back to non-terminal states, preventing the lost-update bug
 * where ATC health monitor overwrites MCP-driven status changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { rows, drizzleOrmMock, createDbMock } = vi.hoisted(() => {
  function whereFilter(data: Record<string, unknown>[], condition: unknown): Record<string, unknown>[] {
    if (!condition) return data;
    if (typeof condition === "function") return data.filter(condition as (r: Record<string, unknown>) => boolean);
    return data;
  }

  const rows = new Map<string, Record<string, unknown>>();

  const drizzleOrmMock = {
    eq: (col: { name: string }, val: unknown) => (row: Record<string, unknown>) => row[col.name] === val,
    and: (...preds: ((row: Record<string, unknown>) => boolean)[]) => (row: Record<string, unknown>) => preds.every((p) => p?.(row) ?? true),
    inArray: (col: { name: string }, vals: unknown[]) => (row: Record<string, unknown>) => (vals as unknown[]).includes(row[col.name]),
    sql: (_strings: TemplateStringsArray, ..._values: unknown[]) => (_row: Record<string, unknown>) => true,
  };

  function createDbMock(rows: Map<string, Record<string, unknown>>) {
    const db = {
      select: (_cols?: unknown) => ({
        from: (_table: unknown) => {
          let w: unknown = undefined;
          let lim: number | undefined;
          const chain = {
            where: (cond: unknown) => { w = cond; return chain; },
            limit: (n: number) => { lim = n; return chain; },
            then: (res: (v: unknown[]) => void) => {
              let result = whereFilter([...rows.values()], w);
              if (lim !== undefined) result = result.slice(0, lim);
              res(result);
            },
          };
          return chain;
        },
      }),
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
          const arr = Array.isArray(vals) ? vals : [vals];
          return {
            returning: () => ({
              then: (res: (v: unknown[]) => void) => { for (const v of arr) rows.set(v.id as string, { ...v }); res(arr); },
            }),
            then: (res: (v: unknown[]) => void) => { for (const v of arr) rows.set(v.id as string, { ...v }); res(arr); },
          };
        },
      }),
      update: (_table: unknown) => ({
        set: (setCols: Record<string, unknown>) => {
          let w: unknown = undefined;
          const chain = {
            where: (cond: unknown) => { w = cond; return chain; },
            returning: () => ({
              then: (res: (v: unknown[]) => void) => {
                const matched = whereFilter([...rows.values()], w);
                const updated: Record<string, unknown>[] = [];
                for (const row of matched) { const merged = { ...row, ...setCols }; rows.set(merged.id as string, merged); updated.push(merged); }
                res(updated);
              },
            }),
          };
          return chain;
        },
      }),
      delete: (_table: unknown) => {
        let w: unknown = undefined;
        const chain = {
          where: (cond: unknown) => { w = cond; return chain; },
          returning: (_cols?: unknown) => ({
            then: (res: (v: unknown[]) => void) => {
              const matched = whereFilter([...rows.values()], w);
              for (const row of matched) rows.delete(row.id as string);
              res(matched);
            },
          }),
        };
        return chain;
      },
    };
    return { db };
  }

  return { rows, drizzleOrmMock, createDbMock };
});

vi.mock("drizzle-orm", () => drizzleOrmMock);
vi.mock("@/lib/db", () => createDbMock(rows));

import { createWorkItem, updateWorkItem } from "@/lib/work-items";

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
    rows.clear();
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
    const result = await updateWorkItem(item.id, { description: "Updated desc" });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("merged");
    expect(result!.description).toBe("Updated desc");
  });

  it("returns null for non-existent items", async () => {
    const result = await updateWorkItem("non-existent-id", { status: "ready" });
    expect(result).toBeNull();
  });
});
