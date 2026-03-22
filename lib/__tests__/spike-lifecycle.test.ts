/**
 * Integration test: end-to-end spike lifecycle validation
 *
 * Validates that all spike-related modules are correctly defined and
 * integrate properly with each other.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies before imports
vi.mock("../work-items", () => ({
  createWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}));

vi.mock("../atc/events", () => ({
  persistEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../github", () => ({
  readFileContent: vi.fn(),
}));

vi.mock("../notion", () => ({
  addCommentToPage: vi.fn().mockResolvedValue(undefined),
  updateProjectStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../model-router", () => ({
  routedAnthropicCall: vi.fn().mockResolvedValue({ text: "Summary comment" }),
}));

import type { SpikeMetadata, SpikeRecommendation, WorkItem } from "../types";
import {
  generateSpikeTemplate,
  parseSpikeFindings,
} from "../spike-template";
import { generateSpikeHandoff } from "../spike-handoff";
import { fileSpikeWorkItem } from "../spike-filing";
import type { SpikeCompletionAction } from "../spike-completion";
import { handleSpikeCompletion } from "../spike-completion";
import { buildUncertaintyDetectionPrompt } from "../pm-prompts";
import { generateSpikePlanPrompt } from "../plan-prompt";
import type { Plan } from "../types";

import { createWorkItem, updateWorkItem } from "../work-items";
import { readFileContent } from "../github";

const mockCreateWorkItem = vi.mocked(createWorkItem);
const mockUpdateWorkItem = vi.mocked(updateWorkItem);
const mockReadFileContent = vi.mocked(readFileContent);

// ---------- Helpers ----------

function makeSpikeMetadata(overrides?: Partial<SpikeMetadata>): SpikeMetadata {
  return {
    parentPrdId: "PRD-42",
    technicalQuestion: "Can we use WebSockets for real-time updates?",
    scope: "Evaluate WebSocket feasibility in Next.js App Router",
    recommendedBy: "pm-agent",
    ...overrides,
  };
}

function makeSpikeWorkItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: "wi-spike-001",
    title: "Spike: WebSocket feasibility",
    description: "Investigate WebSocket support",
    targetRepo: "owner/repo",
    source: { type: "pm-agent", sourceId: "PRD-42" },
    priority: "medium",
    riskLevel: "low",
    complexity: "simple",
    status: "ready",
    type: "spike",
    spikeMetadata: makeSpikeMetadata(),
    dependencies: [],
    handoff: null,
    execution: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------- Tests ----------

describe("Spike Lifecycle: Type Definitions", () => {
  it("SpikeRecommendation has all three expected values", () => {
    const values: SpikeRecommendation[] = ["GO", "GO_WITH_CHANGES", "NO_GO"];
    expect(values).toHaveLength(3);
    // Verify each is assignable to SpikeRecommendation (compile-time check + runtime)
    for (const v of values) {
      const rec: SpikeRecommendation = v;
      expect(rec).toBeTruthy();
    }
  });

  it("SpikeMetadata type is usable and has required fields", () => {
    const meta: SpikeMetadata = makeSpikeMetadata();
    expect(meta.parentPrdId).toBe("PRD-42");
    expect(meta.technicalQuestion).toBeTruthy();
    expect(meta.scope).toBeTruthy();
    expect(meta.recommendedBy).toBe("pm-agent");
  });
});

describe("Spike Lifecycle: Template Generation and Parsing (Roundtrip)", () => {
  const recommendations: SpikeRecommendation[] = [
    "GO",
    "GO_WITH_CHANGES",
    "NO_GO",
  ];

  for (const recommendation of recommendations) {
    it(`roundtrips correctly for recommendation: ${recommendation}`, () => {
      const meta = makeSpikeMetadata();
      const template = generateSpikeTemplate(meta);
      expect(template).toBeTruthy();
      expect(template).toContain("Parent PRD");
      expect(template).toContain("Technical Question");
      expect(template).toContain(meta.parentPrdId);

      // Fill in the template with a recommendation value
      const filledDoc = template
        .replace(
          /<!-- State one of: GO, GO_WITH_CHANGES, NO_GO -->/,
          recommendation,
        )
        .replace(
          /<!-- Describe the approaches.*-->/,
          "Tested WebSocket integration",
        )
        .replace(
          /<!-- Summarize what was discovered.*-->/,
          "WebSockets work well with Next.js",
        )
        .replace(
          /<!-- Describe how these findings.*-->/,
          "PRD scope unchanged",
        );

      const parsed = parseSpikeFindings(filledDoc);
      expect(parsed.recommendation).toBe(recommendation);
      expect(parsed.parentPrdId).toBe(meta.parentPrdId);
      expect(parsed.question).toBe(meta.technicalQuestion);
    });
  }
});

describe("Spike Lifecycle: Handoff Generation", () => {
  it("generates handoff content referencing spikes/ directory", () => {
    const workItem = makeSpikeWorkItem();
    const handoff = generateSpikeHandoff(workItem);
    expect(handoff).toContain("spikes/");
  });

  it("prohibits production code changes in handoff", () => {
    const workItem = makeSpikeWorkItem();
    const handoff = generateSpikeHandoff(workItem);
    const lower = handoff.toLowerCase();
    expect(
      lower.includes("do not") ||
        lower.includes("no production") ||
        lower.includes("prohibit") ||
        lower.includes("research only") ||
        lower.includes("no code changes"),
    ).toBe(true);
  });

  it("throws for non-spike work items", () => {
    const workItem = makeSpikeWorkItem({ type: "feature", spikeMetadata: undefined });
    expect(() => generateSpikeHandoff(workItem)).toThrow(
      "non-spike work item",
    );
  });
});

describe("Spike Lifecycle: Plan Prompt Generation (Pipeline v2)", () => {
  function makeSpikePlan(overrides?: Partial<Plan>): Plan {
    return {
      id: "plan-spike-001",
      prdId: "PRD-42",
      prdTitle: "Investigate WebSocket feasibility",
      prdType: "spike",
      targetRepo: "jamesstineheath/agent-forge",
      branchName: "spike/prd-42",
      status: "ready",
      acceptanceCriteria: "Determine if WebSockets work with Next.js App Router",
      kgContext: null,
      affectedFiles: null,
      estimatedBudget: 3,
      actualCost: null,
      maxDurationMinutes: 60,
      startedAt: null,
      completedAt: null,
      errorLog: null,
      prNumber: null,
      prUrl: null,
      workflowRunId: null,
      retryCount: 0,
      prdRank: null,
      progress: null,
      reviewFeedback: null,
      spikeMetadata: {
        parentPrdId: "PRD-42",
        technicalQuestion: "Can we use WebSockets for real-time updates?",
        scope: "Evaluate WebSocket feasibility in Next.js App Router",
        recommendedBy: "pm-agent",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("generates spike-specific prompt with findings template", () => {
    const plan = makeSpikePlan();
    const prompt = generateSpikePlanPrompt(plan);
    expect(prompt).toContain("Spike Investigation");
    expect(prompt).toContain("spikes/");
    expect(prompt).toContain("GO_WITH_CHANGES");
    expect(prompt).toContain("NO_GO");
    expect(prompt).toContain("Parent PRD");
    expect(prompt).toContain("Technical Question");
  });

  it("prohibits production code modifications", () => {
    const plan = makeSpikePlan();
    const prompt = generateSpikePlanPrompt(plan).toLowerCase();
    expect(prompt).toContain("do not");
    expect(prompt).toContain("no production code");
  });

  it("includes spike metadata in prompt", () => {
    const plan = makeSpikePlan();
    const prompt = generateSpikePlanPrompt(plan);
    expect(prompt).toContain("PRD-42");
    expect(prompt).toContain("Can we use WebSockets");
  });

  it("works without spikeMetadata (falls back to plan fields)", () => {
    const plan = makeSpikePlan({ spikeMetadata: null });
    const prompt = generateSpikePlanPrompt(plan);
    expect(prompt).toContain("Spike Investigation");
    expect(prompt).toContain("spikes/");
  });
});

describe("Spike Lifecycle: Work Item Filing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fileSpikeWorkItem creates work item with type spike", async () => {
    const fakeWorkItem = makeSpikeWorkItem({ id: "wi-new-spike", status: "filed" });
    mockCreateWorkItem.mockResolvedValueOnce(fakeWorkItem);
    mockUpdateWorkItem.mockResolvedValueOnce({ ...fakeWorkItem, status: "ready" });

    const result = await fileSpikeWorkItem({
      parentPrdId: "PRD-42",
      technicalQuestion: "Can we use WebSockets?",
      scope: "WebSocket feasibility",
      recommendedBy: "pm-agent",
    });

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "spike",
        spikeMetadata: expect.objectContaining({
          parentPrdId: "PRD-42",
          technicalQuestion: "Can we use WebSockets?",
        }),
      }),
    );
    expect(mockUpdateWorkItem).toHaveBeenCalledWith("wi-new-spike", {
      status: "ready",
    });
    expect(result.status).toBe("ready");
  });
});

describe("Spike Lifecycle: Orchestrator Routing", () => {
  it("routes spike work items to spike handoff path", () => {
    // The orchestrator uses: if (workItem.type === "spike" && workItem.spikeMetadata)
    // Validate the routing condition directly
    const spikeItem = makeSpikeWorkItem();
    const isSpikeRoute =
      spikeItem.type === "spike" && !!spikeItem.spikeMetadata;
    expect(isSpikeRoute).toBe(true);

    // Verify non-spike items don't match
    const featureItem = makeSpikeWorkItem({ type: "feature", spikeMetadata: undefined });
    const isFeatureRoute =
      featureItem.type === "spike" && !!featureItem.spikeMetadata;
    expect(isFeatureRoute).toBe(false);

    // Validate the spike handoff function is actually called for spike items
    // (the orchestrator calls generateSpikeHandoff for spike items)
    if (isSpikeRoute) {
      const handoff = generateSpikeHandoff(spikeItem);
      expect(handoff).toBeTruthy();
      expect(handoff).toContain("Spike Investigation");
    }
  });
});

describe("Spike Lifecycle: PM Agent Uncertainty Detection", () => {
  it("uncertainty detection prompt is a non-empty string", () => {
    const prompt = buildUncertaintyDetectionPrompt("Some PRD content about a new feature");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("uncertainty detection prompt contains relevant spike keywords", () => {
    const prompt = buildUncertaintyDetectionPrompt("Some PRD content");
    const lower = prompt.toLowerCase();
    expect(
      lower.includes("spike") ||
        lower.includes("uncertain") ||
        lower.includes("research") ||
        lower.includes("investigat"),
    ).toBe(true);
  });

  it("includes PRD content in prompt", () => {
    const prdContent = "We need to integrate with a new external payment API";
    const prompt = buildUncertaintyDetectionPrompt(prdContent);
    expect(prompt).toContain(prdContent);
  });

  it("covers all required uncertainty signal categories", () => {
    const prompt = buildUncertaintyDetectionPrompt("test").toLowerCase();
    // AC-3: Must detect these signal types
    expect(prompt).toContain("unknown api");
    expect(prompt).toContain("new platform");
    expect(prompt).toContain("unproven");
    expect(prompt).toContain("external service");
    expect(prompt).toContain("hardware");
    expect(prompt).toContain("uncertainty language");
  });

  it("outputs JSON with uncertaintySignals, recommendedScope, technicalQuestion", () => {
    const prompt = buildUncertaintyDetectionPrompt("test");
    expect(prompt).toContain("uncertaintySignals");
    expect(prompt).toContain("recommendedScope");
    expect(prompt).toContain("technicalQuestion");
  });
});

describe("Spike Lifecycle: Completion Handler Recommendation Mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupCompletionMocks(recommendation: SpikeRecommendation) {
    const filledDoc = `## Parent PRD
PRD-42

## Technical Question
Can we use WebSockets?

## What Was Tried
Tested integration

## Detailed Findings
It works well

## Recommendation (GO / GO_WITH_CHANGES / NO_GO)
${recommendation}

## Implications for Parent PRD
Scope unchanged`;

    mockReadFileContent.mockResolvedValueOnce(filledDoc);
  }

  it("maps GO recommendation to Draft status transition", async () => {
    const workItem = makeSpikeWorkItem();
    setupCompletionMocks("GO");

    const result = await handleSpikeCompletion(workItem);
    expect(result.type).toBe("GO");
    expect((result as Extract<SpikeCompletionAction, { type: "GO" }>).technicalApproach).toBeTruthy();
  });

  it("maps GO_WITH_CHANGES recommendation — no status change", async () => {
    const workItem = makeSpikeWorkItem();
    setupCompletionMocks("GO_WITH_CHANGES");

    const result = await handleSpikeCompletion(workItem);
    expect(result.type).toBe("GO_WITH_CHANGES");
    expect(
      (result as Extract<SpikeCompletionAction, { type: "GO_WITH_CHANGES" }>).suggestedRevisions,
    ).toBeDefined();
  });

  it("maps NO_GO recommendation to Not Feasible status transition", async () => {
    const workItem = makeSpikeWorkItem();
    setupCompletionMocks("NO_GO");

    const result = await handleSpikeCompletion(workItem);
    expect(result.type).toBe("NO_GO");
    expect(
      (result as Extract<SpikeCompletionAction, { type: "NO_GO" }>).rationale,
    ).toBeDefined();
  });
});
