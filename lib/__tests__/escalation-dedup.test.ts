/**
 * Tests for escalation email dedup, rate limiting, and project escalation records.
 *
 * Tests the dedup/rate-limit guard functions directly rather than the full email send
 * flow, since the Gmail client requires real OAuth credentials.
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
import { resetStore as resetWorkItemStore } from "./helpers/mock-work-items";

describe("Escalation email dedup", () => {
  beforeEach(() => {
    store.clear();
    resetWorkItemStore();
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
    resetWorkItemStore();
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
    resetWorkItemStore();
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
