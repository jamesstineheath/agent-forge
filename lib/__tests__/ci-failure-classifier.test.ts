import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentTrace } from "../atc/tracing";

// Mock lib/github.ts
vi.mock("../github", () => ({
  getWorkflowRunDetail: vi.fn(),
}));

// Mock tracing
vi.mock("../atc/tracing", () => ({
  addDecision: vi.fn(),
}));

import { classifyCIFailure } from "../atc/ci-classifier";
import { getWorkflowRunDetail } from "../github";
import { addDecision } from "../atc/tracing";

const mockGetDetail = vi.mocked(getWorkflowRunDetail);
const mockAddDecision = vi.mocked(addDecision);

function makeTrace(): AgentTrace {
  return {
    agent: "health-monitor",
    startedAt: new Date().toISOString(),
    phases: [],
    decisions: [],
    errors: [],
    _startMs: Date.now(),
  };
}

describe("classifyCIFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("classifies checkout failure as infra", async () => {
    mockGetDetail.mockResolvedValueOnce({
      id: 123, name: "CI", status: "completed", conclusion: "failure",
      branch: "main", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [
        {
          id: 1, name: "build", status: "completed", conclusion: "failure",
          started_at: null, completed_at: null,
          steps: [
            { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
            { name: "checkout", status: "completed", conclusion: "failure", number: 2 },
            { name: "npm run build", status: "completed", conclusion: null, number: 3 },
          ],
        },
      ],
    });

    const result = await classifyCIFailure(123, "owner/repo");

    expect(result.classification).toBe("infra");
    expect(result.failedStep).toBe("checkout");
    expect(result.reason).toContain("infra");
  });

  it("classifies npm run build failure as code", async () => {
    mockGetDetail.mockResolvedValueOnce({
      id: 456, name: "CI", status: "completed", conclusion: "failure",
      branch: "main", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [
        {
          id: 1, name: "build", status: "completed", conclusion: "failure",
          started_at: null, completed_at: null,
          steps: [
            { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
            { name: "checkout", status: "completed", conclusion: "success", number: 2 },
            { name: "npm run build", status: "completed", conclusion: "failure", number: 3 },
          ],
        },
      ],
    });

    const result = await classifyCIFailure(456, "owner/repo");

    expect(result.classification).toBe("code");
    expect(result.failedStep).toBe("npm run build");
  });

  it("returns unknown for unrecognized step name", async () => {
    mockGetDetail.mockResolvedValueOnce({
      id: 789, name: "CI", status: "completed", conclusion: "failure",
      branch: "main", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [
        {
          id: 1, name: "build", status: "completed", conclusion: "failure",
          started_at: null, completed_at: null,
          steps: [
            { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
            { name: "Run some-custom-script.sh", status: "completed", conclusion: "failure", number: 2 },
          ],
        },
      ],
    });

    const result = await classifyCIFailure(789, "owner/repo");

    expect(result.classification).toBe("unknown");
    expect(result.failedStep).toBe("Run some-custom-script.sh");
  });

  it("classifies cancelled job conclusion as infra", async () => {
    mockGetDetail.mockResolvedValueOnce({
      id: 999, name: "CI", status: "completed", conclusion: "cancelled",
      branch: "main", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [
        {
          id: 1, name: "build", status: "completed", conclusion: "cancelled",
          started_at: null, completed_at: null,
          steps: [],
        },
      ],
    });

    const result = await classifyCIFailure(999, "owner/repo");

    expect(result.classification).toBe("infra");
    expect(result.reason).toContain("cancelled");
  });

  it("emits ci.failure_detected and ci.failure_classified trace events", async () => {
    mockGetDetail.mockResolvedValueOnce({
      id: 111, name: "CI", status: "completed", conclusion: "failure",
      branch: "main", event: "push", created_at: "", updated_at: "",
      url: "", run_attempt: 1,
      jobs: [
        {
          id: 1, name: "build", status: "completed", conclusion: "failure",
          started_at: null, completed_at: null,
          steps: [
            { name: "npm test", status: "completed", conclusion: "failure", number: 1 },
          ],
        },
      ],
    });

    const trace = makeTrace();
    await classifyCIFailure(111, "owner/repo", trace);

    const actions = mockAddDecision.mock.calls.map((call) => call[1].action);
    expect(actions).toContain("ci.failure_detected");
    expect(actions).toContain("ci.failure_classified");
  });
});
