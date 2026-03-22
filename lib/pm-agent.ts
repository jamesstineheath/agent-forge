import { loadJson, saveJson } from "./storage";
import { routedAnthropicCall } from "./model-router";
import { listWorkItems, getWorkItem, updateWorkItem } from "./work-items";
import { listProjects } from "./projects";
import { handleSpikeCompletion } from "./spike-completion";
import { handlePlanSpikeCompletion } from "./spike-plan-completion";
import { listPlans, updatePlanStatus } from "./plans";
import { sendEmail } from "./gmail";
import { fetchPageContent, addCommentToPage, getPageComments } from "./notion";
import {
  buildBacklogReviewPrompt,
  buildHealthAssessmentPrompt,
  buildNextBatchPrompt,
  buildDigestPrompt,
  buildUncertaintyDetectionPrompt,
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
  BugsSummary,
} from "./pm-prompts";

// Storage keys (without af-data/ prefix and .json suffix — storage.ts adds those)
const STORAGE_KEYS = {
  latestReview: "pm-agent/latest-review",
  latestHealth: "pm-agent/latest-health",
  latestDigest: "pm-agent/latest-digest",
} as const;

/**
 * Calls Claude API via the model router with telemetry and escalation support.
 */
async function callClaude(prompt: string): Promise<string> {
  const { text } = await routedAnthropicCall({
    model: "claude-sonnet-4-6",
    taskType: "project_manager",
    prompt,
    floorModel: "sonnet", // prevent Sonnet→Opus escalation; pm-sweep is lightweight triage
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

const TERMINAL_PROJECT_STATES = ['Complete', 'Failed', 'Not Feasible'] as const;
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
// 0b. Uncertainty Detection for Idea-status PRDs
// ─────────────────────────────────────────────────────────────────────────────

const PRD_DATABASE_ID = "2a61cc49-73c5-41bf-981c-37ef1ab2f77b";
const UNCERTAINTY_COMMENT_MARKER = "Uncertainty Detected \u2014 Feasibility Spike Recommended";

interface UncertaintyResult {
  uncertaintySignals: string[];
  recommendedScope: string;
  technicalQuestion: string;
}

/**
 * Query the PRD database for pages with a given status.
 */
async function queryPRDsByStatus(status: string): Promise<Array<{ id: string; title: string }>> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) return [];

  try {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${PRD_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: { property: "Status", select: { equals: status } },
        }),
      },
    );

    if (!response.ok) return [];

    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.results ?? []).map((page: any) => ({
      id: page.id,
      title: page.properties?.["PRD Title"]?.title?.[0]?.plain_text ?? "Untitled",
    }));
  } catch (err) {
    console.error("[pm-agent] Failed to query PRDs by status:", err);
    return [];
  }
}

/**
 * Detect technical uncertainty in a PRD and post a Notion comment recommending
 * a feasibility spike if uncertainty signals are found.
 */
async function detectAndCommentUncertainty(
  pageId: string,
  prdTitle: string,
): Promise<UncertaintyResult | null> {
  // Fetch PRD content
  let prdContent: string;
  try {
    prdContent = await fetchPageContent(pageId);
  } catch (err) {
    console.error(`[pm-agent] Failed to fetch PRD content for "${prdTitle}" (${pageId}):`, err);
    return null;
  }

  if (!prdContent.trim()) {
    console.log(`[pm-agent] PRD "${prdTitle}" has no content — skipping uncertainty detection`);
    return null;
  }

  // Check idempotency: skip if already has an uncertainty comment
  const existingComments = await getPageComments(pageId);
  if (existingComments.some((c) => c.includes(UNCERTAINTY_COMMENT_MARKER))) {
    console.log(`[pm-agent] PRD "${prdTitle}" already has uncertainty comment — skipping`);
    return null;
  }

  // Call Claude to detect uncertainty
  const prompt = buildUncertaintyDetectionPrompt(prdContent);
  const raw = await callClaude(prompt);
  const result = safeParseJSON<UncertaintyResult>(raw, {
    uncertaintySignals: [],
    recommendedScope: "",
    technicalQuestion: "",
  });

  if (result.uncertaintySignals.length === 0) {
    console.log(`[pm-agent] No uncertainty detected in PRD "${prdTitle}"`);
    return result;
  }

  // Build and post the comment
  const signalsList = result.uncertaintySignals
    .map((s) => `  \u2022 ${s}`)
    .join("\n");

  const commentBody = `\uD83D\uDD0D ${UNCERTAINTY_COMMENT_MARKER}

Signals found:
${signalsList}

Recommended spike scope: ${result.recommendedScope}

Technical question to answer: ${result.technicalQuestion}`;

  try {
    await addCommentToPage(pageId, commentBody);
    console.log(`[pm-agent] Posted uncertainty comment on PRD "${prdTitle}" (${result.uncertaintySignals.length} signals)`);
  } catch (err) {
    console.error(`[pm-agent] Failed to post uncertainty comment on PRD "${prdTitle}":`, err);
  }

  return result;
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

  // Send notification (Slack primary, email fallback)
  const { sendWithFallback, sendSlackMessage } = await import("./slack");
  await sendWithFallback(
    () => sendSlackMessage(`:clipboard: *Backlog Review — ${new Date().toLocaleDateString()}*\n${review.summary.substring(0, 2500)}`),
    () => sendEmail({
      subject: `[Agent Forge] Backlog Review — ${new Date().toLocaleDateString()}`,
      body: review.summary,
    })
  ).catch((err) => {
    console.error("[pm-agent] Notification send failed (non-fatal):", err);
  });

  // --- Uncertainty detection for Idea-status PRDs ---
  try {
    const ideaPRDs = await queryPRDsByStatus("Idea");
    const backlogPRDs = await queryPRDsByStatus("Backlog");

    for (const prd of backlogPRDs) {
      console.log(`[pm-agent] Skipping Backlog-status PRD "${prd.title}" — uncertainty detection only applies to Idea-status PRDs`);
    }

    for (const prd of ideaPRDs) {
      try {
        await detectAndCommentUncertainty(prd.id, prd.title);
      } catch (err) {
        console.error(`[pm-agent] Uncertainty detection failed for PRD "${prd.title}":`, err);
      }
    }
  } catch (err) {
    console.error("[pm-agent] Uncertainty detection phase failed (non-fatal):", err);
  }

  // --- Spike completion phase (legacy work items) ---
  try {
    await processSpikeCompletions(workItems);
  } catch (err) {
    console.error("[pm-agent] Spike completion phase failed (non-fatal):", err);
  }

  // --- Spike completion phase (Pipeline v2 plans) ---
  try {
    await processPlanSpikeCompletions();
  } catch (err) {
    console.error("[pm-agent] Plan spike completion phase failed (non-fatal):", err);
  }

  return review;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Spike Completion Phase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process merged spike work items: read findings from target repo,
 * post Notion comment on parent PRD, and transition PRD status.
 */
async function processSpikeCompletions(allWorkItems: WorkItem[]): Promise<void> {
  const mergedSpikes = allWorkItems.filter(
    (item) =>
      item.type === "spike" &&
      item.status === "merged" &&
      !item.updatedAt.includes("spikeCompletionProcessed"), // fallback check
  );

  // Double-check: re-fetch each to ensure we have latest status and check metadata
  const spikesToProcess: WorkItem[] = [];
  for (const spike of mergedSpikes) {
    const fresh = await getWorkItem(spike.id);
    if (!fresh) continue;
    if (fresh.type === "spike" && fresh.status === "merged") {
      spikesToProcess.push(fresh);
    }
  }

  if (spikesToProcess.length === 0) {
    console.log("[pm-agent] No merged spikes awaiting completion processing");
    return;
  }

  console.log(
    `[pm-agent] Found ${spikesToProcess.length} spike(s) awaiting completion processing`,
  );

  for (const workItem of spikesToProcess) {
    try {
      const action = await handleSpikeCompletion(workItem);
      console.log(
        `[pm-agent] Spike ${workItem.id} completion: ${action.type}`,
      );

      // Mark as processed — transition to verified status
      await updateWorkItem(workItem.id, {
        status: "verified",
      });
    } catch (err) {
      console.error(
        `[pm-agent] Error processing spike completion for ${workItem.id}:`,
        err,
      );
      // Don't rethrow — continue processing other spikes
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1c. Plan Spike Completion Phase (Pipeline v2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process completed spike plans: read findings from target repo,
 * post Notion comment on parent PRD, and transition PRD status.
 * This is the Pipeline v2 equivalent of processSpikeCompletions().
 */
async function processPlanSpikeCompletions(): Promise<void> {
  const completePlans = await listPlans({ status: "complete" });
  const spikePlans = completePlans.filter(
    p => p.prdType === "spike" && p.spikeMetadata && !p.errorLog?.startsWith("spike_processed:")
  );

  if (spikePlans.length === 0) {
    console.log("[pm-agent] No completed spike plans awaiting processing");
    return;
  }

  console.log(`[pm-agent] Found ${spikePlans.length} completed spike plan(s) to process`);

  for (const plan of spikePlans) {
    try {
      const action = await handlePlanSpikeCompletion(plan);
      console.log(`[pm-agent] Spike plan ${plan.id} completion: ${action.type}`);

      // Mark plan as processed by moving to a terminal state
      // We reuse "complete" but add a note in the error log field
      await updatePlanStatus(plan.id, "complete", {
        completedAt: new Date().toISOString(),
        errorLog: `spike_processed:${action.type}`,
      });
    } catch (err) {
      console.error(`[pm-agent] Error processing spike plan completion for ${plan.id}:`, err);
    }
  }
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
// 3b. fetchBugsSummary
// ─────────────────────────────────────────────────────────────────────────────

const BUGS_DB_ID = '023f3621-2885-468d-a8cf-2e0bd1458bb3';

async function fetchBugsSummary(): Promise<BugsSummary> {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) {
    console.warn('[fetchBugsSummary] NOTION_API_KEY not set, returning empty summary');
    return {
      newCount: 0,
      fixedCount: 0,
      fixedWithPRs: [],
      openBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    };
  }

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const headers = {
    Authorization: `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // 1. Bugs filed in last 24h
  let newCount = 0;
  try {
    const newBugsRes = await fetch(
      `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: {
            timestamp: 'created_time',
            created_time: { after: yesterday },
          },
        }),
      }
    );
    if (newBugsRes.ok) {
      const newBugsData = await newBugsRes.json();
      newCount = newBugsData.results?.length ?? 0;
    }
  } catch (err) {
    console.error('[fetchBugsSummary] Failed to query new bugs:', err);
  }

  // 2. Bugs fixed in last 24h
  let fixedCount = 0;
  let fixedWithPRs: Array<{ title: string; prUrl: string }> = [];
  try {
    const fixedBugsRes = await fetch(
      `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: 'Status',
                status: { equals: 'Fixed' },
              },
              {
                timestamp: 'last_edited_time',
                last_edited_time: { after: yesterday },
              },
            ],
          },
        }),
      }
    );
    if (fixedBugsRes.ok) {
      const fixedBugsData = await fixedBugsRes.json();
      const fixedResults: Record<string, unknown>[] = fixedBugsData.results ?? [];
      fixedCount = fixedResults.length;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fixedWithPRs = fixedResults
        .map((page: any) => {
          const titleProp = page.properties?.Name ?? page.properties?.Title;
          const title =
            titleProp?.title?.[0]?.plain_text ?? titleProp?.rich_text?.[0]?.plain_text ?? 'Untitled';
          const prProp =
            page.properties?.PR ??
            page.properties?.['PR URL'] ??
            page.properties?.['Pull Request'];
          const prUrl =
            prProp?.url ?? prProp?.rich_text?.[0]?.plain_text ?? '';
          return prUrl ? { title, prUrl } : null;
        })
        .filter(Boolean) as Array<{ title: string; prUrl: string }>;
    }
  } catch (err) {
    console.error('[fetchBugsSummary] Failed to query fixed bugs:', err);
  }

  // 3. Open bugs by severity
  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const openBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };

  await Promise.all(
    severities.map(async (severity) => {
      try {
        const res = await fetch(
          `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              filter: {
                and: [
                  {
                    property: 'Status',
                    status: { does_not_equal: 'Fixed' },
                  },
                  {
                    property: 'Status',
                    status: { does_not_equal: "Won't Fix" },
                  },
                  {
                    property: 'Severity',
                    select: { equals: severity.charAt(0).toUpperCase() + severity.slice(1) },
                  },
                ],
              },
            }),
          }
        );
        if (res.ok) {
          const data = await res.json();
          openBySeverity[severity] = data.results?.length ?? 0;
        }
      } catch (err) {
        console.error(`[fetchBugsSummary] Failed to query ${severity} bugs:`, err);
      }
    })
  );

  return { newCount, fixedCount, fixedWithPRs, openBySeverity };
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

  // Fetch bugs summary (graceful fallback on error)
  let bugs: BugsSummary | undefined;
  try {
    bugs = await fetchBugsSummary();
  } catch (err) {
    console.error('[composeDigest] Failed to fetch bugs summary:', err);
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
    bugs,
  };

  const prompt = buildDigestPrompt(digestContext);
  const digestText = await callClaude(prompt);

  const digestRecord = {
    generatedAt: new Date().toISOString(),
    options,
    digest: digestText,
  };
  await saveJson(STORAGE_KEYS.latestDigest, digestRecord);

  // Send notification (Slack primary, email fallback)
  if (options.recipientEmail) {
    const { sendWithFallback, sendSlackMessage } = await import("./slack");
    await sendWithFallback(
      () => sendSlackMessage(`:bar_chart: *Pipeline Digest — ${new Date().toLocaleDateString()}*\n${digestText.substring(0, 2500)}`),
      () => sendEmail({
        subject: `[Agent Forge] Pipeline Digest — ${new Date().toLocaleDateString()}`,
        body: digestText,
      })
    ).catch((err) => {
      console.error("[pm-agent] Digest notification failed (non-fatal):", err);
    });
  }

  return digestText;
}
