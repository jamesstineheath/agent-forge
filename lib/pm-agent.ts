import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { loadJson, saveJson } from "./storage";
import { listWorkItems, getWorkItem } from "./work-items";
import { listProjects } from "./projects";
import { getGmailClient } from "./gmail";
import {
  buildBacklogReviewPrompt,
  buildHealthAssessmentPrompt,
  buildNextBatchPrompt,
  buildDigestPrompt,
} from "./pm-prompts";
import type {
  BacklogReview,
  ProjectHealthReport,
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

const MODEL = "claude-sonnet-4-5";

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
 */
function parseJson<T>(raw: string): T {
  const stripped = raw
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();
  return JSON.parse(stripped) as T;
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

/**
 * Send a simple email via the Gmail client.
 * Returns the thread ID if sent, null otherwise.
 */
async function sendEmail(subject: string, body: string): Promise<string | null> {
  const client = getGmailClient();
  if (!client) {
    console.log("[pm-agent] Gmail not configured, skipping email.");
    return null;
  }

  const message = [
    "From: james.stine.heath@gmail.com",
    "To: james.stine.heath@gmail.com",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");

  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const response = await client.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage },
  });

  return response.data.threadId || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. reviewBacklog
// ─────────────────────────────────────────────────────────────────────────────

export async function reviewBacklog(): Promise<BacklogReview> {
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
  const review = parseJson<BacklogReview>(raw);

  await saveJson(STORAGE_KEYS.latestReview, review);

  // Send Gmail summary (non-fatal)
  await sendEmail(
    `PM Agent: Backlog Review — ${new Date().toLocaleDateString()}`,
    `Backlog review completed.\n\nSummary:\n${review.summary ?? JSON.stringify(review, null, 2)}`,
  ).catch((err) => {
    console.error("[pm-agent] Gmail send failed (non-fatal):", err);
  });

  return review;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. assessProjectHealth
// ─────────────────────────────────────────────────────────────────────────────

export async function assessProjectHealth(): Promise<ProjectHealthReport> {
  const [workItems, projects] = await Promise.all([
    fetchAllWorkItems(),
    listProjects(),
  ]);

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
  const healthReport = parseJson<ProjectHealthReport>(raw);

  await saveJson(STORAGE_KEYS.latestHealth, healthReport);

  return healthReport;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. suggestNextBatch
// ─────────────────────────────────────────────────────────────────────────────

export async function suggestNextBatch(): Promise<{ items: string[]; rationale: string }> {
  const [workItems, pipelineState] = await Promise.all([
    fetchAllWorkItems(),
    getPipelineState(),
  ]);

  const readyItems = workItems.filter((item) => item.status === "ready");
  const recentlyMerged = workItems
    .filter((item) => item.status === "merged")
    .map((item) => item.id);
  const recentlyFailed = workItems
    .filter((item) => item.status === "failed")
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
  const result = parseJson<{ items: string[]; rationale: string }>(raw);

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. composeDigest
// ─────────────────────────────────────────────────────────────────────────────

export async function composeDigest(options: DigestOptions): Promise<string> {
  const [reviewData, healthData, workItems, projects] = await Promise.all([
    loadJson<BacklogReview>(STORAGE_KEYS.latestReview).catch(() => null),
    loadJson<ProjectHealthReport>(STORAGE_KEYS.latestHealth).catch(() => null),
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

  // Build recommendations from latest review if available
  const recommendations: string[] = [];
  if (reviewData?.summary) {
    recommendations.push(reviewData.summary);
  }
  if (healthData?.overallSummary) {
    recommendations.push(healthData.overallSummary);
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

  return digestText;
}
