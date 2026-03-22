import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { writeExecutionLog } from "./execution-log";
import { saveJson } from "@/lib/storage";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import { fetchPageContent, updateProjectStatus } from "@/lib/notion";
import { createPlan, listPlans, generateBranchName } from "@/lib/plans";
import { loadGraph } from "@/lib/knowledge-graph/storage";
import { queryGraph, getBlastRadius, getRelevantSystemMapSections, getRelevantADRs } from "@/lib/knowledge-graph/query";
import { queryTriagedBugs, updateBugPage, type TriagedBug } from "@/lib/bugs";

const PLAN_PIPELINE_LOCK_KEY = "atc/plan-pipeline-lock";

/**
 * PRD database ID — the PRDs & Acceptance Criteria database in Notion.
 * This is NOT the old Projects DB (NOTION_PROJECTS_DB_ID env var).
 */
const PRD_DATABASE_ID = "2a61cc49-73c5-41bf-981c-37ef1ab2f77b";

interface ApprovedPRD {
  id: string;
  projectId: string;
  title: string;
  targetRepo: string | null;
  rank: number | null;
  type: "feature" | "spike";
}

/**
 * Query the PRD database directly for Approved PRDs.
 * Uses the correct database ID and property names (PRD Title, Target Repo, etc.)
 * instead of queryProjects() which reads from the old Projects DB.
 */
async function queryApprovedPRDs(): Promise<ApprovedPRD[]> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) {
    console.error("[plan-pipeline v2] NOTION_API_KEY not set");
    return [];
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${PRD_DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Status", select: { equals: "Approved" } },
        sorts: [{ property: "Rank", direction: "ascending" }],
        page_size: 50,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error(`[plan-pipeline v2] Notion PRD query failed: ${res.status}`, data.message ?? data);
      return [];
    }

    interface NotionPRDPage {
      id: string;
      properties: {
        "PRD Title"?: { title?: Array<{ plain_text?: string }> };
        Status?: { select?: { name?: string } };
        "Target Repo"?: { select?: { name?: string } };
        Rank?: { number?: number | null };
        "AF Project ID"?: { rich_text?: Array<{ plain_text?: string }> };
        ID?: { unique_id?: { prefix?: string; number?: number } };
        Type?: { select?: { name?: string } };
      };
    }

    return (data.results as NotionPRDPage[]).map((page) => {
      let projectId = page.properties?.["AF Project ID"]?.rich_text?.[0]?.plain_text;
      if (!projectId) {
        const uid = page.properties?.ID?.unique_id;
        if (uid) {
          projectId = `${uid.prefix ?? "PRD"}-${uid.number}`;
        }
      }

      const rawType = page.properties?.Type?.select?.name?.toLowerCase();
      return {
        id: page.id,
        projectId: projectId ?? page.id,
        title: page.properties?.["PRD Title"]?.title?.[0]?.plain_text ?? "Untitled",
        targetRepo: page.properties?.["Target Repo"]?.select?.name ?? null,
        rank: page.properties?.Rank?.number ?? null,
        type: rawType === "spike" ? "spike" as const : "feature" as const,
      };
    });
  } catch (err) {
    console.error("[plan-pipeline v2] Failed to query PRD database:", err);
    return [];
  }
}

/** Budget multipliers per criterion type/complexity. */
const BUDGET_PER_CRITERION = 3; // default $/criterion (historical actuals run 5-10x below estimates at $8)
const MAX_AUTO_BUDGET = 100; // above this → needs_review

/** Default budget for bug plans (bugs are typically smaller scope). */
const BUG_DEFAULT_BUDGET = 5;
const BUG_DEFAULT_DURATION = 60;

/** Duration estimates based on criteria count. */
function estimateMaxDuration(criteriaCount: number): number {
  if (criteriaCount <= 3) return 60;
  if (criteriaCount <= 6) return 120;
  return 180;
}

/**
 * A unified work item for the plan pipeline — either a PRD or a bug.
 * Used for severity-based ordering.
 */
interface PipelineItem {
  type: "prd" | "bug";
  /** For PRDs: projectId. For bugs: "BUG-{pageId}" */
  id: string;
  /** Notion page ID */
  pageId: string;
  title: string;
  targetRepo: string | null;
  /** PRD rank (null for bugs) */
  rank: number | null;
  /** Bug severity (null for PRDs) */
  severity: TriagedBug["severity"] | null;
  /** ISO timestamp for creation-time ordering */
  createdTime: string;
  /** Bug context (acceptance criteria equivalent) — null for PRDs (fetched later) */
  bugContext: string | null;
  /** Bug affected files — null for PRDs (computed via KG) */
  bugAffectedFiles: string[] | null;
}

/**
 * Build a severity-ordered list of pipeline items.
 *
 * Ordering rules:
 * - Critical bugs first (before all PRDs)
 * - High bugs interleaved with PRDs (sorted by creation time)
 * - Medium/Low bugs only after all PRDs
 */
function buildOrderedPipelineItems(
  prds: ApprovedPRD[],
  bugs: TriagedBug[],
): PipelineItem[] {
  const criticalBugs: PipelineItem[] = [];
  const highBugs: PipelineItem[] = [];
  const lowBugs: PipelineItem[] = [];

  for (const bug of bugs) {
    const item: PipelineItem = {
      type: "bug",
      id: `BUG-${bug.id}`,
      pageId: bug.id,
      title: bug.title,
      targetRepo: bug.targetRepo,
      rank: null,
      severity: bug.severity,
      createdTime: bug.createdTime,
      bugContext: bug.context,
      bugAffectedFiles: bug.affectedFiles,
    };

    if (bug.severity === "Critical") {
      criticalBugs.push(item);
    } else if (bug.severity === "High") {
      highBugs.push(item);
    } else {
      lowBugs.push(item);
    }
  }

  const prdItems: PipelineItem[] = prds.map((prd) => ({
    type: "prd" as const,
    id: prd.projectId,
    pageId: prd.id,
    title: prd.title,
    targetRepo: prd.targetRepo,
    rank: prd.rank,
    severity: null,
    createdTime: new Date().toISOString(), // PRDs don't have createdTime, use now for interleaving
    bugContext: null,
    bugAffectedFiles: null,
  }));

  // High bugs interleaved with PRDs by creation order
  const interleaved = [...highBugs, ...prdItems].sort((a, b) => {
    // PRDs maintain rank order among themselves
    if (a.type === "prd" && b.type === "prd") {
      return (a.rank ?? 999) - (b.rank ?? 999);
    }
    // Bugs sorted by creation time among themselves
    if (a.type === "bug" && b.type === "bug") {
      return new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime();
    }
    // Bug vs PRD: interleave by creation time
    return new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime();
  });

  // Medium/Low bugs only if no PRDs waiting
  const tail = prdItems.length === 0 ? lowBugs : [];

  return [...criticalBugs, ...interleaved, ...tail];
}

/**
 * Generate a branch name for a bug plan.
 * Convention: bug-{shortId}/{slugified-title}
 */
function generateBugBranchName(bugPageId: string, title: string): string {
  const shortId = bugPageId.replace(/-/g, "").slice(0, 8);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `bug-${shortId}/${slug}`;
}

/**
 * Pipeline v2: Plan Pipeline
 *
 * Single-request execution (no Inngest step.run wrappers) to avoid
 * step scheduling issues. This function is fast (data-gathering only,
 * no LLM calls) so durable steps are unnecessary.
 *
 * For each Approved PRD without an existing Plan:
 * 1. Fetch PRD page content from Notion (acceptance criteria text)
 * 2. Query KG for affected files (blast radius from keyword search)
 * 3. Estimate budget and max duration
 * 4. Create Plan record in Neon
 * 5. Update PRD status to Executing
 */
export const planPipeline = inngest.createFunction(
  {
    id: "plan-pipeline",
    name: "Plan Pipeline",
    triggers: [
      { cron: "*/10 * * * *" },
      { event: "agent/supervisor.requested" },
    ],
  },
  async () => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    console.log("[plan-pipeline v2] Starting (single-request mode)");

    try {
      await writeExecutionLog({ functionId: 'plan-pipeline', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[plan-pipeline] Failed to write running log:', e);
    }

    // Preflight — kill switch + lock
    if (await isPipelineKilled()) {
      console.log("[plan-pipeline v2] Kill switch is ON — skipping");
      return { success: true, skipped: true, reason: "kill-switch" };
    }
    const locked = await acquireLock(PLAN_PIPELINE_LOCK_KEY);
    if (!locked) {
      console.log("[plan-pipeline v2] Lock held — skipping");
      return { success: true, skipped: true, reason: "lock held" };
    }
    console.log("[plan-pipeline v2] Preflight passed, lock acquired");

    const trace = startTrace("plan-pipeline");
    const decisions: string[] = [];
    const errors: string[] = [];
    let plansCreated = 0;

    try {
      const phaseStart = Date.now();

      // Query PRD database directly for Approved PRDs
      const approvedPRDs = await queryApprovedPRDs();
      console.log(`[plan-pipeline v2] queryApprovedPRDs() returned ${approvedPRDs.length} PRD(s)`);
      if (approvedPRDs.length > 0) {
        console.log(`[plan-pipeline v2] PRDs: ${approvedPRDs.map(p => `${p.projectId} "${p.title}" (repo: ${p.targetRepo ?? "none"})`).join(", ")}`);
      }

      // Query Bugs database for Triaged bugs
      let triagedBugs: TriagedBug[] = [];
      try {
        triagedBugs = await queryTriagedBugs();
        console.log(`[plan-pipeline v2] queryTriagedBugs() returned ${triagedBugs.length} bug(s)`);
        if (triagedBugs.length > 0) {
          console.log(`[plan-pipeline v2] Bugs: ${triagedBugs.map(b => `${b.severity} "${b.title}" (repo: ${b.targetRepo})`).join(", ")}`);
        }
      } catch (bugErr) {
        console.error("[plan-pipeline v2] Failed to query triaged bugs:", bugErr);
        errors.push(`Failed to query triaged bugs: ${bugErr instanceof Error ? bugErr.message : String(bugErr)}`);
      }

      // Build severity-ordered pipeline items
      const pipelineItems = buildOrderedPipelineItems(approvedPRDs, triagedBugs);

      if (pipelineItems.length === 0) {
        decisions.push("No Approved PRDs or Triaged bugs found");
      } else {
        // Get existing plans to avoid duplicates
        const existingPlans = await listPlans();
        const existingPrdIds = new Set(existingPlans.map(p => p.prdId));
        console.log(`[plan-pipeline v2] Existing plans: ${existingPlans.length} (prdIds: ${[...existingPrdIds].join(", ") || "none"})`);

        for (const item of pipelineItems) {
          // Skip if plan already exists for this item
          if (existingPrdIds.has(item.id)) {
            console.log(`[plan-pipeline v2] Skipping "${item.title}" — plan already exists for ${item.id}`);
            continue;
          }

          try {
            const targetRepo = item.targetRepo;
            if (!targetRepo) {
              errors.push(`${item.type === "bug" ? "Bug" : "PRD"} "${item.title}" has no target repo — skipped`);
              continue;
            }

            let acceptanceCriteria: string;
            let estimatedBudget: number;
            let maxDuration: number;
            let branchName: string;
            let kgContext: {
              affectedFiles: string[];
              systemMapSections: string;
              relevantADRs: Array<{ title: string; status: string; decision: string }>;
              entityCount: number;
            } | null = null;
            let affectedFiles: string[] = [];

            if (item.type === "bug") {
              // Bug: use context as acceptance criteria, affected files from bug report
              acceptanceCriteria = item.bugContext || item.title;
              affectedFiles = item.bugAffectedFiles ?? [];
              estimatedBudget = BUG_DEFAULT_BUDGET;
              maxDuration = BUG_DEFAULT_DURATION;
              branchName = generateBugBranchName(item.pageId, item.title);

              // Use bug's affected files as KG hints if available
              if (affectedFiles.length > 0) {
                try {
                  const graph = await loadGraph(targetRepo);
                  if (graph) {
                    const blast = getBlastRadius(graph, affectedFiles, 2);
                    const systemMapSections = getRelevantSystemMapSections("", blast.affectedFiles);
                    const relevantADRs = getRelevantADRs([], blast.affectedFiles, []);

                    kgContext = {
                      affectedFiles: blast.affectedFiles.slice(0, 50),
                      systemMapSections,
                      relevantADRs,
                      entityCount: graph.entities.size,
                    };
                    affectedFiles = blast.affectedFiles;
                  }
                } catch (kgErr) {
                  console.warn(`[plan-pipeline v2] KG query failed for bug "${item.title}":`, kgErr);
                }
              }
            } else {
              // PRD: fetch content and compute KG context
              const prdContent = await fetchPageContent(item.pageId);
              if (!prdContent || prdContent.trim().length === 0) {
                errors.push(`PRD "${item.title}" has no content — skipped`);
                continue;
              }
              console.log(`[plan-pipeline v2] Fetched content for "${item.title}" (${prdContent.length} chars)`);

              acceptanceCriteria = prdContent;
              branchName = generateBranchName(item.id, item.title);

              try {
                const graph = await loadGraph(targetRepo);
                if (graph) {
                  const keywords = extractKeywords(prdContent);
                  const matchedFiles = new Set<string>();

                  for (const keyword of keywords) {
                    const results = queryGraph(graph, { namePattern: keyword });
                    for (const entity of results.entities) {
                      matchedFiles.add(entity.filePath);
                    }
                  }

                  const matchedFileArray = [...matchedFiles];
                  if (matchedFileArray.length > 0) {
                    const blast = getBlastRadius(graph, matchedFileArray, 2);
                    affectedFiles = blast.affectedFiles;
                  }

                  const systemMapSections = getRelevantSystemMapSections("", affectedFiles);
                  const relevantADRs = getRelevantADRs([], affectedFiles, keywords);

                  kgContext = {
                    affectedFiles: affectedFiles.slice(0, 50),
                    systemMapSections,
                    relevantADRs,
                    entityCount: graph.entities.size,
                  };
                  console.log(`[plan-pipeline v2] KG context: ${affectedFiles.length} affected files, ${graph.entities.size} entities`);
                } else {
                  console.log(`[plan-pipeline v2] No KG graph for ${targetRepo}`);
                }
              } catch (kgErr) {
                console.warn(`[plan-pipeline v2] KG query failed for ${targetRepo}:`, kgErr);
              }

              const criteriaCount = countCriteria(prdContent);
              estimatedBudget = criteriaCount * BUDGET_PER_CRITERION;
              maxDuration = estimateMaxDuration(criteriaCount);
            }

            // Scope guardrail (bugs are always auto-dispatched — small budget)
            const isBug = item.type === "bug";
            const status = (isBug || estimatedBudget <= MAX_AUTO_BUDGET) ? "ready" : "needs_review";

            // Create Plan record
            const plan = await createPlan({
              prdId: item.id,
              prdTitle: item.title,
              targetRepo,
              branchName,
              acceptanceCriteria,
              kgContext,
              affectedFiles: affectedFiles.length > 0 ? affectedFiles : undefined,
              estimatedBudget,
              maxDurationMinutes: maxDuration,
              status,
              prdRank: item.rank ?? undefined,
            });

            // Update source in Notion
            if (item.type === "bug") {
              try {
                await updateBugPage(item.pageId, plan.id);
                console.log(`[plan-pipeline v2] Updated bug "${item.title}" — status: In Progress, workItemId: ${plan.id}`);
              } catch (notionErr) {
                console.warn(`[plan-pipeline v2] Failed to update bug status for "${item.title}":`, notionErr);
              }
            } else {
              try {
                await updateProjectStatus(item.pageId, "Executing");
              } catch (notionErr) {
                console.warn(`[plan-pipeline v2] Failed to update PRD status for "${item.title}":`, notionErr);
              }
            }

            plansCreated++;
            const typeLabel = item.type === "bug" ? `[${item.severity}]` : "";
            const statusNote = status === "needs_review" ? " (needs_review: budget > $100)" : "";
            decisions.push(
              `Created ${item.type} plan ${plan.id} ${typeLabel} for "${item.title}" — est. $${estimatedBudget}, ${maxDuration}min${statusNote}`
            );
            console.log(`[plan-pipeline v2] Created ${item.type} plan ${plan.id} for "${item.title}" (${status})`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Failed to create plan for "${item.title}": ${msg}`);
            console.error(`[plan-pipeline v2] Failed to create plan for "${item.title}":`, err);
          }
        }
      }

      addPhase(trace, { name: "create-plans", durationMs: Date.now() - phaseStart });
      for (const d of decisions) addDecision(trace, { action: "create-plans", reason: d });
      for (const e of errors) addError(trace, `create-plans: ${e}`);

      // Persist results
      const readyPlans = await listPlans({ status: "ready" });
      const executingPlans = await listPlans({ status: "executing" });

      await saveJson(ATC_STATE_KEY, {
        lastRunAt: new Date().toISOString(),
        activeExecutions: executingPlans.map(p => ({
          workItemId: p.id,
          targetRepo: p.targetRepo,
          branch: p.branchName,
          status: p.status,
          startedAt: p.startedAt ?? p.createdAt,
          elapsedMinutes: p.startedAt
            ? Math.round((Date.now() - new Date(p.startedAt).getTime()) / 60000)
            : 0,
          filesBeingModified: p.affectedFiles ?? [],
        })),
        queuedItems: readyPlans.length,
        recentEvents: decisions.slice(-20).map((d) => ({
          type: "auto_dispatch",
          timestamp: new Date().toISOString(),
          details: d,
        })),
      });

      completeTrace(trace, errors.length > 0 ? "error" : "success");
      await persistTrace(trace);
      await cleanupOldTraces("plan-pipeline", 7);
      await recordAgentRun("supervisor");
      await releaseLock(PLAN_PIPELINE_LOCK_KEY);

      try {
        await writeExecutionLog({
          functionId: 'plan-pipeline',
          status: 'success',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
        });
      } catch (e) {
        console.error('[plan-pipeline] Failed to write success log:', e);
      }

      console.log(`[plan-pipeline v2] Complete: ${plansCreated} plans created (${triagedBugs.length} bugs scanned), ${decisions.length} decisions, ${errors.length} errors`);
      return { success: true, plansCreated, bugsScanned: triagedBugs.length, decisions: decisions.length, errors: errors.length };
    } catch (err) {
      try {
        await writeExecutionLog({
          functionId: 'plan-pipeline',
          status: 'error',
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch (logErr) {
        console.error('[plan-pipeline] Failed to write error log:', logErr);
      }

      await releaseLock(PLAN_PIPELINE_LOCK_KEY);
      throw err;
    }
  },
);

/**
 * Extract keywords from acceptance criteria text for KG search.
 */
function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();

  const filePathRegex = /(?:[\w-]+\/)+[\w.-]+\.\w+/g;
  for (const match of text.matchAll(filePathRegex)) {
    const parts = match[0].split("/");
    const filename = parts[parts.length - 1].replace(/\.\w+$/, "");
    keywords.add(filename);
    for (const part of parts.slice(0, -1)) {
      if (part.length > 2) keywords.add(part);
    }
  }

  const identifierRegex = /\b[A-Z][a-zA-Z0-9]{2,}\b/g;
  for (const match of text.matchAll(identifierRegex)) {
    keywords.add(match[0]);
  }

  const quotedRegex = /`([^`]+)`/g;
  for (const match of text.matchAll(quotedRegex)) {
    if (match[1].length > 2 && match[1].length < 50) {
      keywords.add(match[1]);
    }
  }

  return [...keywords].slice(0, 30);
}

/**
 * Count acceptance criteria in PRD content.
 */
function countCriteria(text: string): number {
  const patterns = [
    /^\s*\d+\.\s+\[/gm,
    /^\s*-\s+\[[ x]\]/gm,
    /^\s*AC-?\d+/gim,
    /^\s*\*\*AC/gm,
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  if (count === 0) {
    const numberedItems = text.match(/^\s*\d+\.\s+\S/gm);
    count = numberedItems?.length ?? 1;
  }

  return Math.max(count, 1);
}
