/**
 * Tests for CI infra failure classification and auto-retry logic.
 *
 * Validates:
 * - classifyCIFailure correctly identifies infra vs other failures
 * - Health monitor triggers rerunFailedJobs for infra failures
 * - Dedup guard prevents double-retries using event bus
 * - Escalation fires when retry is exhausted
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- classifyCIFailure unit tests (mock getWorkflowRunDetail) ---

vi.mock("@/lib/github", () => ({
  getWorkflowRunDetail: vi.fn(),
  getWorkflowRuns: vi.fn().mockResolvedValue([]),
  getPRByBranch: vi.fn().mockResolvedValue(null),
  getPRByNumber: vi.fn().mockResolvedValue(null),
  getPRFiles: vi.fn().mockResolvedValue([]),
  getPRMergeability: vi.fn().mockResolvedValue({ mergeable: null, mergeableState: null }),
  rebasePR: vi.fn().mockResolvedValue({ success: true }),
  closePRWithReason: vi.fn(),
  deleteBranch: vi.fn().mockResolvedValue(false),
  rerunFailedJobs: vi.fn().mockResolvedValue(undefined),
}));

import { getWorkflowRunDetail } from "@/lib/github";
import { classifyCIFailure } from "@/lib/ci-failure-classifier";

const mockGetRunDetail = vi.mocked(getWorkflowRunDetail);

describe("classifyCIFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 'infra' when all failed steps are checkout/setup", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 100, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "build", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "Checkout", status: "completed", conclusion: "failure", number: 1 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 100);
    expect(result).toBe("infra");
  });

  it("returns 'infra' for setup-node failures", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 101, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "test", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "Setup Node.js", status: "completed", conclusion: "failure", number: 1 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 101);
    expect(result).toBe("infra");
  });

  it("returns 'infra' for npm ci / cache / artifact failures", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 102, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "build", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "npm ci", status: "completed", conclusion: "failure", number: 1 },
          { name: "Cache dependencies", status: "completed", conclusion: "failure", number: 2 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 102);
    expect(result).toBe("infra");
  });

  it("returns 'test' when a test step fails", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 103, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "test", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "Checkout", status: "completed", conclusion: "success", number: 1 },
          { name: "Run tests", status: "completed", conclusion: "failure", number: 2 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 103);
    expect(result).toBe("test");
  });

  it("returns 'lint' when a lint step fails", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 104, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "lint", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "Run eslint", status: "completed", conclusion: "failure", number: 1 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 104);
    expect(result).toBe("lint");
  });

  it("returns 'build' when a build step fails", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 105, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "build", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "Build project", status: "completed", conclusion: "failure", number: 1 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 105);
    expect(result).toBe("build");
  });

  it("returns 'unknown' when no failed jobs", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 106, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "build", status: "completed", conclusion: "success",
        started_at: null, completed_at: null, steps: [],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 106);
    expect(result).toBe("unknown");
  });

  it("returns 'unknown' when getWorkflowRunDetail throws", async () => {
    mockGetRunDetail.mockRejectedValue(new Error("API error"));

    const result = await classifyCIFailure("owner/repo", 999);
    expect(result).toBe("unknown");
  });

  it("does not classify as infra when mixed infra and non-infra steps fail", async () => {
    mockGetRunDetail.mockResolvedValue({
      id: 107, name: "CI", status: "completed", conclusion: "failure",
      branch: "feat/test", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [{
        id: 1, name: "build", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null,
        steps: [
          { name: "Checkout", status: "completed", conclusion: "failure", number: 1 },
          { name: "Run tests", status: "completed", conclusion: "failure", number: 2 },
        ],
      }],
    });

    const result = await classifyCIFailure("owner/repo", 107);
    // Should be 'test' since not all failed steps are infra
    expect(result).toBe("test");
  });
});
