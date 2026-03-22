import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("../github", () => ({
  createGitHubRepo: vi.fn(),
  deleteGitHubRepo: vi.fn(),
  pushFile: vi.fn(),
  getRepoPublicKey: vi.fn(),
  setRepoSecret: vi.fn(),
  setActionsPermissions: vi.fn(),
  setDefaultWorkflowPermissions: vi.fn(),
  setBranchProtection: vi.fn(),
}));

vi.mock("../repos", () => ({
  createRepo: vi.fn(),
  isRepoRegistered: vi.fn(),
}));

vi.mock("../templates", () => ({
  getTemplateFiles: vi.fn(),
}));

vi.mock("libsodium-wrappers", () => {
  const mockSodium = {
    ready: Promise.resolve(),
    from_base64: vi.fn(() => new Uint8Array(32)),
    from_string: vi.fn(() => new Uint8Array(10)),
    crypto_box_seal: vi.fn(() => new Uint8Array(42)),
    to_base64: vi.fn(() => "encrypted-base64"),
    base64_variants: { ORIGINAL: 0 },
  };
  return { default: mockSodium };
});

import { bootstrapRepo } from "../bootstrapper";
import {
  createGitHubRepo,
  deleteGitHubRepo,
  pushFile,
  getRepoPublicKey,
  setRepoSecret,
  setActionsPermissions,
  setDefaultWorkflowPermissions,
  setBranchProtection,
} from "../github";
import { createRepo, isRepoRegistered } from "../repos";
import { getTemplateFiles } from "../templates";

const mockCreateGitHubRepo = vi.mocked(createGitHubRepo);
const mockDeleteGitHubRepo = vi.mocked(deleteGitHubRepo);
const mockPushFile = vi.mocked(pushFile);
const mockGetRepoPublicKey = vi.mocked(getRepoPublicKey);
const mockSetRepoSecret = vi.mocked(setRepoSecret);
const mockSetActionsPermissions = vi.mocked(setActionsPermissions);
const mockSetDefaultWorkflowPermissions = vi.mocked(setDefaultWorkflowPermissions);
const mockSetBranchProtection = vi.mocked(setBranchProtection);
const mockCreateRepo = vi.mocked(createRepo);
const mockIsRepoRegistered = vi.mocked(isRepoRegistered);
const mockGetTemplateFiles = vi.mocked(getTemplateFiles);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = "testowner";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.AGENT_FORGE_API_SECRET = "test-secret";
  process.env.AGENT_FORGE_URL = "https://agent-forge.test";

  // Default happy-path mocks
  mockIsRepoRegistered.mockResolvedValue(false);
  mockCreateGitHubRepo.mockResolvedValue({
    full_name: "testowner/my-repo",
    html_url: "https://github.com/testowner/my-repo",
    id: 12345,
    default_branch: "main",
  });
  mockGetTemplateFiles.mockResolvedValue([
    { path: ".github/workflows/execute-handoff.yml", content: "workflow-content" },
  ]);
  mockPushFile.mockResolvedValue({ pushed: true });
  mockGetRepoPublicKey.mockResolvedValue({ key_id: "key-1", key: "AAAA" });
  mockSetRepoSecret.mockResolvedValue(undefined);
  mockSetActionsPermissions.mockResolvedValue(undefined);
  mockSetDefaultWorkflowPermissions.mockResolvedValue(undefined);
  mockSetBranchProtection.mockResolvedValue(undefined);
  mockCreateRepo.mockResolvedValue({
    id: "reg-uuid-1",
    fullName: "testowner/my-repo",
    shortName: "my-repo",
    claudeMdPath: "CLAUDE.md",
    handoffDir: "handoffs/awaiting_handoff/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 1,
    defaultBudget: 8,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("bootstrapRepo", () => {
  it("successfully bootstraps a repo end-to-end", async () => {
    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "execute-only",
    });

    expect(result.repoUrl).toBe("https://github.com/testowner/my-repo");
    expect(result.repoId).toBe(12345);
    expect(result.registrationId).toBe("reg-uuid-1");

    const successSteps = result.steps.filter((s) => s.status === "success");
    expect(successSteps.length).toBeGreaterThanOrEqual(5);

    // Verify it called all the right functions
    expect(mockIsRepoRegistered).toHaveBeenCalledWith("testowner/my-repo");
    expect(mockCreateGitHubRepo).toHaveBeenCalled();
    expect(mockPushFile).toHaveBeenCalled();
    expect(mockSetActionsPermissions).toHaveBeenCalled();
    expect(mockSetBranchProtection).toHaveBeenCalled();
    expect(mockCreateRepo).toHaveBeenCalled();
  });

  it("generates a pre-flight checklist", async () => {
    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "full-tlm",
    });

    expect(result.checklist.length).toBeGreaterThan(0);
    // Should have GH_PAT and webhook items
    expect(result.checklist.some((c) => c.description.includes("GH_PAT"))).toBe(true);
    expect(result.checklist.some((c) => c.description.includes("webhook"))).toBe(true);
    // full-tlm should have tlm-memory item
    expect(result.checklist.some((c) => c.description.includes("tlm-memory"))).toBe(true);
  });

  it("blocks re-bootstrap of already-registered repos", async () => {
    mockIsRepoRegistered.mockResolvedValue(true);

    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "execute-only",
    });

    expect(result.repoUrl).toBe("");
    expect(result.steps[0].name).toBe("check-duplicate");
    expect(result.steps[0].status).toBe("failed");
    expect(result.steps[0].detail).toContain("already registered");
    // Should not attempt repo creation
    expect(mockCreateGitHubRepo).not.toHaveBeenCalled();
  });

  it("cleans up on failure after repo creation", async () => {
    mockPushFile.mockRejectedValue(new Error("push failed"));
    mockDeleteGitHubRepo.mockResolvedValue(undefined);

    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "execute-only",
    });

    // Should have attempted cleanup
    expect(mockDeleteGitHubRepo).toHaveBeenCalledWith("testowner", "my-repo");
    const cleanupStep = result.steps.find((s) => s.name === "cleanup");
    expect(cleanupStep?.status).toBe("success");
  });

  it("reports progress via onProgress callback", async () => {
    const progress: Array<{ step: string; status: string }> = [];

    await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "execute-only",
      onProgress: (step, status) => {
        progress.push({ step, status });
      },
    });

    // Should have progress events for each step
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.step === "create-repo" && p.status === "start")).toBe(true);
    expect(progress.some((p) => p.step === "create-repo" && p.status === "done")).toBe(true);
  });

  it("skips Vercel when not requested", async () => {
    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "execute-only",
    });

    const vercelStep = result.steps.find((s) => s.name === "vercel-project");
    expect(vercelStep?.status).toBe("skipped");
  });

  it("does not push local TLM action copies for full-tlm", async () => {
    // Simulate full-tlm template files (only workflows, no actions)
    mockGetTemplateFiles.mockResolvedValue([
      { path: ".github/workflows/execute-handoff.yml", content: "wf1" },
      { path: ".github/workflows/tlm-review.yml", content: "wf2" },
      { path: ".github/workflows/tlm-spec-review.yml", content: "wf3" },
      { path: ".github/workflows/tlm-outcome-tracker.yml", content: "wf4" },
    ]);

    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "full-tlm",
    });

    // Verify no .github/actions/ files were pushed
    const pushCalls = mockPushFile.mock.calls;
    const actionPushes = pushCalls.filter(
      (call) => typeof call[2] === "string" && call[2].includes(".github/actions/")
    );
    expect(actionPushes.length).toBe(0);

    expect(result.steps.find((s) => s.name === "push-workflows")?.detail).toContain(
      "cross-repo"
    );
  });

  it("handles create-repo failure without cleanup attempt", async () => {
    mockCreateGitHubRepo.mockRejectedValue(new Error("403 Forbidden"));

    const result = await bootstrapRepo("my-repo", {
      repoName: "my-repo",
      pipelineLevel: "execute-only",
    });

    expect(result.repoUrl).toBe("");
    expect(result.steps.find((s) => s.name === "create-repo")?.status).toBe("failed");
    // Should not try to delete since repo was never created
    expect(mockDeleteGitHubRepo).not.toHaveBeenCalled();
  });
});
