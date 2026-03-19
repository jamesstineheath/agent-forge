import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { loadJson, saveJson } from "./storage";
import { listWorkItems, getWorkItem } from "./work-items";
import { listProjects } from "./projects";
import { sendEmail } from "./gmail";
import {
  buildBacklogReviewPrompt,
  buildHealthAssessmentPrompt,
  buildNextBatchPrompt,
  buildDigestPrompt,
} from "./pm-prompts";
import type {
  BacklogReview,
  BacklogRecommendation,
  ProjectHealth,
  ProjectHealthReport,
  PMAgentConfig,
  DigestOptions,
  WorkItem,
  ATCState,
} from "./types";
import type {
  WorkItemSummary,
  ProjectSummary,
  PipelineState,
  ProjectHealthSummary,
  AvailableItem,
  NextBatchPipelineState,
  DigestProjectSummary,
  DigestContext,
} from "./pm-prompts";

// Storage keys (without af-data/ prefix and .json suffix — storage.ts adds those)
const STORAGE_KEYS = {
  latestReview: "pm-agent/latest-review",
  latestHealth: "pm-agent/latest-health",
  latestDigest: "pm-agent/latest-digest",
} as const;

const MODEL = "claude-sonnet-4-5-20250514";

/**
 * Calls Claude API with a prompt string.
 * Matches the pattern in lib/decomposer.ts.
 */
async function callClaude(prompt: string): Promise<string> {
  const { text } = await generateText({
    model: anthropic(MODEL),
    prompt,
  });
  return text;
}

/**
 * Safely parse JSON from Claude response.
 * Claude sometimes wraps JSON in markdown code fences — strip them first.
 * Returns fallback on parse failure instead of throwing.
 */
function safeParseJSON<T>(raw: string, fallback: T): T {
  try {
    const stripped = raw
      .replace(/^```(?:json)?\n?/m, "")
      .replace(/\n?```$/m, "")
      .trim();
    return JSON.parse(stripped) as T;
  } catch {
    console.error("[pm-agent] Failed to parse Claude JSON response:", raw.slice(0, 500));
    return fallback;
  }
}

/**
 * Fetch all work items (full objects) from storage.
 */
async function fetchAllWorkItems(): Promise<WorkItem[]> {
  const entries = await listWorkItems();
  const items = await Promise.all(entries.map((e) => getWorkItem(e.id)));
  return items.filter((i): i is WorkItem => i !== null);
}

/**
 * Reads pipeline state from ATC blob storage.
 */
async function getPipelineState(): Promise<{ inFlightCount: number; queueDepth: number }> {
  try {
    const state = await loadJson<ATCState>("atc/state");
    if (!state) return { inFlightCount: 0, queueDepth: 0 };
    return {
      inFlightCount: state.activeExecutions.length,
      queueDepth: state.queuedItems,
    };
  } catch {
    return { inFlightCount: 0, queueDepth: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. Early-exit guard — skip LLM calls if there's nothing to act on
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL_PROJECT_STATES = ['Complete', 'Failed'] as const;
const TERMINAL_WORK_ITEM_STATES = ['cancelled', 'merged', 'obsolete'] as const;

/**
 * Check if the PM Agent has any work to do.
 * Returns { shouldRun: true } if there are active projects or actionable work items,
 * or { shouldRun: false, reason: string } if early-exit is appropriate.
 */
export async function checkShouldRun(): Promise<{ shouldRun: boolean; reason?: string }> {
  const [allProjects, allWorkItems] = await Promise.all([
    listProjects(),
    fetchAllWorkItems(),
  ]);

  const activeProjects = allProjects.filter(
    p => !(TERMINAL_PROJECT_STATES as readonly string[]).includes(p.status)
  );

  const actionableWorkItems = allWorkItems.filter(
    wi => !(TERMINAL_WORK_ITEM_STATES as readonly string[]).includes(wi.status)
  );

  if (activeProjects.length === 0 && actionableWorkItems.length === 0) {
    return { shouldRun: false, reason: 'no active projects or actionable work items' };
  }

  return { shouldRun: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. reviewBacklog
// ─────────────────────────────────────────────────────────────────────────────

export async function reviewBacklog(config?: Partial<PMAgentConfig>): Promise<BacklogReview> {
  const [workItems, projects, pipelineState] = await Promise.all([
    fetchAllWorkItems(),
    listProjects(),
    getPipelineState(),
  ]);

  // Map to prompt context types
  const workItemSummaries: WorkItemSummary[] = workItems.map((item) => ({
    id: item.id,
    title: item.title,
    repo: item.targetRepo,
    status: item.status,
    priority: item.priority,
    createdAt: item.createdAt,
  }));

  const projectSummaries: ProjectSummary[] = projects.map((p) => ({
    id: p.projectId,
    name: p.title,
    status: p.status,
  }));

  const pipeline: PipelineState = {
    inFlight: pipelineState.inFlightCount,
    queued: pipelineState.queueDepth,
    concurrencyLimit: 5, // matches GLOBAL_CONCURRENCY_LIMIT in atc.ts
  };

  const prompt = buildBacklogReviewPrompt({
    workItems: workItemSummaries,
    projects: projectSummaries,
    pipelineState: pipeline,
  });

  const raw = await callClaude(prompt);

  // Parse Claude response defensively
  const parsed = safeParseJSON<{
    recommendations?: Array<{
      itemId: string;
      action: string;
      rationale: string;
      priority: number;
    }>;
    summary?: string;
  }>(raw, { recommendations: [], summary: raw });

  // Map to BacklogReview type
  const id = `br_${Date.now()}`;
  const recommendations: BacklogRecommendation[] = (parsed.recommendations ?? []).map((r) => ({
    workItemId: r.itemId,
    action: (["dispatch", "defer", "kill", "escalate"].includes(r.action)
      ? r.action
      : "defer") as BacklogRecommendation["action"],
    priority: r.priority >= 7 ? "high" : r.priority >= 4 ? "medium" : "low",
    rationale: r.rationale,
  }));

  const maxRecs = config?.maxRecommendations;
  const review: BacklogReview = {
    id,
    timestamp: new Date().toISOString(),
    repos: [...new Set(workItems.map((i) => i.targetRepo))],
    totalItemsReviewed: workItems.length,
    recommendations: maxRecs ? recommendations.slice(0, maxRecs) : recommendations,
    summary: parsed.summary ?? raw,
  };

  await saveJson(STORAGE_KEYS.latestReview, review);

  // Send Gmail summary (non-fatal)
  await sendEmail({
    subject: `[Agent Forge] Backlog Review — ${new Date().toLocaleDateString()}`,
    body: review.summary,
  }).catch((err) => {
    console.error("[pm-agent] Gmail send failed (non-fatal):", err);
  });

  return review;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. assessProjectHealth
// ─────────────────────────────────────────────────────────────────────────────

export async function assessProjectHealth(projectId?: string): Promise<ProjectHealth[]> {
  const [workItems, allProjects] = await Promise.all([
    fetchAllWorkItems(),
    listProjects(),
  ]);

  const projects = projectId
    ? allProjects.filter((p) => p.id === projectId || p.projectId === projectId)
    : allProjects;

  const projectHealthSummaries: ProjectHealthSummary[] = projects.map((project) => {
    const projectItems = workItems.filter(
      (item) => item.source.type === "project" && item.source.sourceId === project.projectId,
    );
    const totalItems = projectItems.length;
    const completedCount = projectItems.filter((item) => item.status === "merged").length;
    const blockedCount = projectItems.filter((item) => item.status === "blocked").length;
    const escalationCount = projectItems.filter(
      (item) => item.escalation !== undefined,
    ).length;

    // Avg time in queue (minutes) for items that have started executing
    const executedItems = projectItems.filter(
      (item) => item.execution?.startedAt && item.createdAt,
    );
    const avgQueueTime =
      executedItems.length > 0
        ? executedItems.reduce((sum, item) => {
            const created = new Date(item.createdAt).getTime();
            const started = new Date(item.execution!.startedAt!).getTime();
            return sum + (started - created) / 60_000;
          }, 0) / executedItems.length
        : 0;

    return {
      id: project.projectId,
      name: project.title,
      status: project.status,
      itemCount: totalItems,
      completedCount,
      escalations: escalationCount,
      blockedItems: blockedCount,
      avgQueueTime: Math.round(avgQueueTime),
    };
  });

  const prompt = buildHealthAssessmentPrompt({ projects: projectHealthSummaries });
  const raw = await callClaude(prompt);

  // Parse Claude's response defensively
  const parsed = safeParseJSON<{
    projectReports?: Array<{
      projectId: string;
      projectName: string;
      healthStatus: string;
      completionRate: number;
      concerns: string[];
    }>;
  }>(raw, { projectReports: [] });

  // Build ProjectHealth[] with computed metrics, enriched by Claude's analysis
  const statusMap: Record<string, ProjectHealth["status"]> = {
    healthy: "healthy",
    at_risk: "at-risk",
    stalling: "stalling",
    critical: "blocked",
  };

  const healthResults: ProjectHealth[] = projects.map((project) => {
    const summary = projectHealthSummaries.find((s) => s.id === project.projectId)!;
    const claudeReport = (parsed.projectReports ?? []).find(
      (r) => r.projectId === project.id || r.projectId === project.projectId,
    );

    const projectItems = workItems.filter(
      (item) => item.source.type === "project" && item.source.sourceId === project.projectId,
    );
    const total = summary.itemCount;
    const merged = summary.completedCount;
    const failed = projectItems.filter((i) => i.status === "failed").length;
    const completionRate = total > 0 ? merged / total : 0;

    return {
      projectId: project.projectId,
      projectName: project.title,
      status: claudeReport?.healthStatus
        ? statusMap[claudeReport.healthStatus] ?? "healthy"
        : "healthy",
      completionRate,
      escalationCount: summary.escalations,
      avgTimeInQueue: summary.avgQueueTime,
      blockedItems: summary.blockedItems,
      totalItems: total,
      mergedItems: merged,
      failedItems: failed,
      issues: claudeReport?.concerns ?? [],
    };
  });

  // Persist as ProjectHealthReport
  const report: ProjectHealthReport = {
    projects: healthResults,
    generatedAt: new Date().toISOString(),
    overallSummary: `Assessed ${projects.length} projects`,
  };
  await saveJson(STORAGE_KEYS.latestHealth, report);

  return healthResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. suggestNextBatch
// ─────────────────────────────────────────────────────────────────────────────

export async function suggestNextBatch(): Promise<{ workItemIds: string[]; rationale: string }> {
  const [workItems, pipelineState] = await Promise.all([
    fetchAllWorkItems(),
    getPipelineState(),
  ]);

  const readyItems = workItems.filter((item) => item.status === "ready");
  const recentlyMerged = workItems
    .filter((item) => item.status === "merged")
    .slice(0, 10)
    .map((item) => item.id);
  const recentlyFailed = workItems
    .filter((item) => item.status === "failed")
    .slice(0, 10)
    .map((item) => item.id);

  const availableItems: AvailableItem[] = readyItems.map((item) => ({
    id: item.id,
    title: item.title,
    repo: item.targetRepo,
    priority: item.priority,
    dependencies: item.dependencies,
  }));

  const nextBatchPipeline: NextBatchPipelineState = {
    inFlight: pipelineState.inFlightCount,
    queued: pipelineState.queueDepth,
    recentlyMerged,
    recentlyFailed,
  };

  const prompt = buildNextBatchPrompt({
    pipelineState: nextBatchPipeline,
    availableItems,
  });

  const raw = await callClaude(prompt);

  // Claude returns array of { itemId, title, repo, rationale, dispatchOrder }
  const parsed = safeParseJSON<Array<{ itemId: string; rationale: string }>>(raw, []);

  if (Array.isArray(parsed) && parsed.length > 0) {
    return {
      workItemIds: parsed.map((p) => p.itemId),
      rationale: parsed.map((p) => `${p.itemId}: ${p.rationale}`).join("; "),
    };
  }

  // Fallback: select oldest ready items
  const availableSlots = Math.max(0, 5 - pipelineState.inFlightCount);
  return {
    workItemIds: readyItems.slice(0, availableSlots).map((i) => i.id),
    rationale: "Fallback: selected oldest ready items by default.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. composeDigest
// ─────────────────────────────────────────────────────────────────────────────

export async function composeDigest(options: DigestOptions): Promise<string> {
  // Optionally invoke reviewBacklog and assessProjectHealth
  let backlogReview: BacklogReview | undefined;
  let healthResults: ProjectHealth[] | undefined;

  if (options.includeBacklog) {
    backlogReview = await reviewBacklog();
  }
  if (options.includeHealth) {
    healthResults = await assessProjectHealth();
  }

  const [workItems, projects] = await Promise.all([
    fetchAllWorkItems(),
    listProjects(),
  ]);

  const mergedCount = workItems.filter((i) => i.status === "merged").length;
  const failedCount = workItems.filter((i) => i.status === "failed").length;
  const blockedCount = workItems.filter((i) => i.status === "blocked").length;
  const escalationCount = workItems.filter((i) => i.escalation !== undefined).length;

  const projectSummaries: DigestProjectSummary[] = projects.map((p) => {
    const projectItems = workItems.filter(
      (i) => i.source.type === "project" && i.source.sourceId === p.projectId,
    );
    const merged = projectItems.filter((i) => i.status === "merged").length;
    const total = projectItems.length;
    return {
      name: p.title,
      status: p.status,
      delta: `${merged}/${total} items merged`,
    };
  });

  // Build recommendations from latest review/health if available
  const recommendations: string[] = [];
  if (backlogReview?.summary) {
    recommendations.push(backlogReview.summary);
  }
  if (healthResults) {
    const atRisk = healthResults.filter((h) => h.status !== "healthy");
    for (const h of atRisk) {
      recommendations.push(`${h.projectName}: ${h.issues.join(", ") || h.status}`);
    }
  }

  const digestContext: DigestContext = {
    period: "daily",
    stats: {
      merged: mergedCount,
      failed: failedCount,
      blocked: blockedCount,
      escalations: escalationCount,
    },
    projectSummaries,
    recommendations,
  };

  const prompt = buildDigestPrompt(digestContext);
  const digestText = await callClaude(prompt);

  const digestRecord = {
    generatedAt: new Date().toISOString(),
    options,
    digest: digestText,
  };
  await saveJson(STORAGE_KEYS.latestDigest, digestRecord);

  // Send via Gmail if recipientEmail provided
  if (options.recipientEmail) {
    await sendEmail({
      subject: `[Agent Forge] Pipeline Digest — ${new Date().toLocaleDateString()}`,
      body: digestText,
    }).catch((err) => {
      console.error("[pm-agent] Digest email send failed (non-fatal):", err);
    });
  }

  return digestText;
}
