/**
 * Tests for escalation email dedup, rate limiting, and project escalation records.
 *
 * Tests the dedup/rate-limit guard functions directly rather than the full email send
 * flow, since the Gmail client requires real OAuth credentials.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { store, dbRows, drizzleOrmMock, createDbMock } = vi.hoisted(() => {
  function whereFilter(data: Record<string, unknown>[], condition: unknown): Record<string, unknown>[] {
    if (!condition) return data;
    if (typeof condition === "function") return data.filter(condition as (r: Record<string, unknown>) => boolean);
    return data;
  }

  const store = new Map<string, string>();
  const dbRows = new Map<string, Record<string, unknown>>();

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

  return { store, dbRows, drizzleOrmMock, createDbMock };
});

vi.mock("drizzle-orm", () => drizzleOrmMock);
vi.mock("@/lib/db", () => createDbMock(dbRows));

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

// Mock gmail to avoid real email sends
vi.mock("@/lib/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail")>();
  return {
    ...actual,
    // Keep the guard functions but stub actual send
    getGmailClient: () => null,
  };
});

import {
  checkEscalationDedup,
  checkEscalationRateLimit,
  sendProjectEscalationEmail,
} from "@/lib/gmail";
import { escalate, findPendingProjectEscalation, listEscalations } from "@/lib/escalation";

describe("Escalation email dedup", () => {
  beforeEach(() => {
    store.clear();
    dbRows.clear();
  });

  it("returns false when no prior email exists", async () => {
    const result = await checkEscalationDedup("proj-new", "some_type");
    expect(result).toBe(false);
  });

  it("returns true when a dedup record exists within 24h", async () => {
    // Simulate a dedup record written recently
    const key = "project-escalation:proj-1:plan_validation_failed";
    store.set(key, JSON.stringify({ sentAt: new Date().toISOString() }));

    const result = await checkEscalationDedup("proj-1", "plan_validation_failed");
    expect(result).toBe(true);
  });

  it("returns false when dedup record is older than 24h", async () => {
    const key = "project-escalation:proj-1:plan_validation_failed";
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    store.set(key, JSON.stringify({ sentAt: oldDate }));

    const result = await checkEscalationDedup("proj-1", "plan_validation_failed");
    expect(result).toBe(false);
  });

  it("different escalation types are not deduped against each other", async () => {
    const key = "project-escalation:proj-1:plan_validation_failed";
    store.set(key, JSON.stringify({ sentAt: new Date().toISOString() }));

    // Different type should not be deduped
    const result = await checkEscalationDedup("proj-1", "budget_exceeded");
    expect(result).toBe(false);
  });

  it("sendProjectEscalationEmail returns false when dedup record exists", async () => {
    // Pre-populate dedup record
    const key = "project-escalation:proj-dup:plan_validation_failed";
    store.set(key, JSON.stringify({ sentAt: new Date().toISOString() }));

    const result = await sendProjectEscalationEmail({
      projectId: "proj-dup",
      projectTitle: "Dup Test",
      reason: "Plan validation failed",
      escalationType: "plan_validation_failed",
    });
    expect(result).toBe(false);
  });
});

describe("Escalation rate limiter", () => {
  beforeEach(() => {
    store.clear();
    dbRows.clear();
  });

  it("returns false for a fresh project", async () => {
    const result = await checkEscalationRateLimit("proj-fresh");
    expect(result).toBe(false);
  });

  it("returns false for project with fewer than 3 emails this hour", async () => {
    const hourStart = new Date();
    hourStart.setMinutes(0, 0, 0);

    const key = "escalation-rate:proj-2";
    store.set(key, JSON.stringify({ count: 2, hourStart: hourStart.toISOString() }));

    const result = await checkEscalationRateLimit("proj-2");
    expect(result).toBe(false);
  });

  it("returns true for project with 3+ emails this hour", async () => {
    const hourStart = new Date();
    hourStart.setMinutes(0, 0, 0);

    const key = "escalation-rate:proj-3";
    store.set(key, JSON.stringify({ count: 3, hourStart: hourStart.toISOString() }));

    const result = await checkEscalationRateLimit("proj-3");
    expect(result).toBe(true);
  });

  it("returns true when global limit of 10 is reached", async () => {
    const hourStart = new Date();
    hourStart.setMinutes(0, 0, 0);

    const globalKey = "escalation-rate:global";
    store.set(globalKey, JSON.stringify({ count: 10, hourStart: hourStart.toISOString() }));

    const result = await checkEscalationRateLimit("proj-new");
    expect(result).toBe(true);
  });

  it("resets counter for a new hour", async () => {
    // Old hour counter
    const oldHour = new Date(Date.now() - 2 * 60 * 60 * 1000);
    oldHour.setMinutes(0, 0, 0);

    const key = "escalation-rate:proj-reset";
    store.set(key, JSON.stringify({ count: 5, hourStart: oldHour.toISOString() }));

    const result = await checkEscalationRateLimit("proj-reset");
    expect(result).toBe(false);
  });

  it("sendProjectEscalationEmail returns false when rate limited", async () => {
    const hourStart = new Date();
    hourStart.setMinutes(0, 0, 0);

    const key = "escalation-rate:proj-limited";
    store.set(key, JSON.stringify({ count: 3, hourStart: hourStart.toISOString() }));

    const result = await sendProjectEscalationEmail({
      projectId: "proj-limited",
      projectTitle: "Rate Limited",
      reason: "test",
      escalationType: "test_type",
    });
    expect(result).toBe(false);
  });
});

describe("Project escalation records", () => {
  beforeEach(() => {
    store.clear();
    dbRows.clear();
  });

  it("creates a project escalation record with projectId", async () => {
    const escalation = await escalate(
      "project-proj-1",
      "Plan validation failed",
      0.9,
      { projectTitle: "Test Project" },
      "proj-1"
    );

    expect(escalation.projectId).toBe("proj-1");
    expect(escalation.status).toBe("pending");
    expect(escalation.reason).toBe("Plan validation failed");
  });

  it("findPendingProjectEscalation finds existing pending escalation", async () => {
    await escalate(
      "project-proj-2",
      "Budget exceeded",
      0.8,
      { projectTitle: "Test Project 2" },
      "proj-2"
    );

    const found = await findPendingProjectEscalation("proj-2", "Budget exceeded");
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe("proj-2");
  });

  it("findPendingProjectEscalation returns null for non-existent escalation", async () => {
    const found = await findPendingProjectEscalation("proj-none", "some reason");
    expect(found).toBeNull();
  });

  it("project escalations appear in listEscalations", async () => {
    await escalate(
      "project-proj-3",
      "Test reason",
      0.7,
      { projectTitle: "Test Project 3" },
      "proj-3"
    );

    const all = await listEscalations("all");
    const projectEscalations = all.filter((e) => e.projectId === "proj-3");
    expect(projectEscalations.length).toBe(1);
  });
});
