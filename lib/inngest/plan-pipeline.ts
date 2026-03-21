import { inngest } from "./client";
import { isPipelineKilled } from "@/lib/atc/kill-switch";
import { acquireLock, releaseLock } from "@/lib/atc/lock";
import { writeExecutionLog } from "./execution-log";
import { saveJson } from "@/lib/storage";
import { recordAgentRun } from "@/lib/atc/utils";
import { startTrace, addPhase, addDecision, addError, completeTrace, persistTrace, cleanupOldTraces } from "@/lib/atc/tracing";
import { ATC_STATE_KEY } from "@/lib/atc/types";
import { queryProjects, fetchPageContent, updateProjectStatus } from "@/lib/notion";
import { createPlan, listPlans, generateBranchName } from "@/lib/plans";
import { loadGraph } from "@/lib/knowledge-graph/storage";
import { queryGraph, getBlastRadius, getRelevantSystemMapSections, getRelevantADRs } from "@/lib/knowledge-graph/query";

const PLAN_PIPELINE_LOCK_KEY = "atc/plan-pipeline-lock";

/** Budget multipliers per criterion type/complexity. */
const BUDGET_PER_CRITERION = 8; // default $/criterion
const MAX_AUTO_BUDGET = 30; // above this → needs_review

/** Duration estimates based on criteria count. */
function estimateMaxDuration(criteriaCount: number): number {
  if (criteriaCount <= 3) return 60;
  if (criteriaCount <= 6) return 120;
  return 180;
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

      // Query Notion for Approved PRDs
      const approvedPRDs = await queryProjects("Approved");
      console.log(`[plan-pipeline v2] queryProjects("Approved") returned ${approvedPRDs.length} PRD(s)`);
      if (approvedPRDs.length > 0) {
        console.log(`[plan-pipeline v2] PRDs: ${approvedPRDs.map(p => `${p.projectId} "${p.title}" (repo: ${p.targetRepo ?? "none"})`).join(", ")}`);
      }

      if (approvedPRDs.length === 0) {
        decisions.push("No Approved PRDs found");
      } else {
        // Get existing plans to avoid duplicates
        const existingPlans = await listPlans();
        const existingPrdIds = new Set(existingPlans.map(p => p.prdId));
        console.log(`[plan-pipeline v2] Existing plans: ${existingPlans.length} (prdIds: ${[...existingPrdIds].join(", ") || "none"})`);

        for (const prd of approvedPRDs) {
          // Skip if plan already exists for this PRD
          if (existingPrdIds.has(prd.projectId)) {
            console.log(`[plan-pipeline v2] Skipping "${prd.title}" — plan already exists for ${prd.projectId}`);
            continue;
          }

          try {
            // 1. Fetch PRD content (acceptance criteria)
            const prdContent = await fetchPageContent(prd.id);
            if (!prdContent || prdContent.trim().length === 0) {
              errors.push(`PRD "${prd.title}" has no content — skipped`);
              continue;
            }
            console.log(`[plan-pipeline v2] Fetched content for "${prd.title}" (${prdContent.length} chars)`);

            // 2. Query KG for affected files
            const targetRepo = prd.targetRepo;
            if (!targetRepo) {
              errors.push(`PRD "${prd.title}" has no target repo — skipped`);
              continue;
            }

            let kgContext: {
              affectedFiles: string[];
              systemMapSections: string;
              relevantADRs: Array<{ title: string; status: string; decision: string }>;
              entityCount: number;
            } | null = null;
            let affectedFiles: string[] = [];

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

            // 3. Estimate budget and duration
            const criteriaCount = countCriteria(prdContent);
            const estimatedBudget = criteriaCount * BUDGET_PER_CRITERION;
            const maxDuration = estimateMaxDuration(criteriaCount);

            // 4. Scope guardrail
            const status = estimatedBudget > MAX_AUTO_BUDGET ? "needs_review" : "ready";

            // 5. Create Plan record
            const branchName = generateBranchName(prd.projectId, prd.title);
            const plan = await createPlan({
              prdId: prd.projectId,
              prdTitle: prd.title,
              targetRepo,
              branchName,
              acceptanceCriteria: prdContent,
              kgContext,
              affectedFiles: affectedFiles.length > 0 ? affectedFiles : undefined,
              estimatedBudget,
              maxDurationMinutes: maxDuration,
              status,
              prdRank: prd.rank,
            });

            // 6. Update PRD status to Executing
            try {
              await updateProjectStatus(prd.id, "Executing");
            } catch (notionErr) {
              console.warn(`[plan-pipeline v2] Failed to update PRD status for "${prd.title}":`, notionErr);
            }

            plansCreated++;
            const statusNote = status === "needs_review" ? " (needs_review: budget > $30)" : "";
            decisions.push(
              `Created plan ${plan.id} for "${prd.title}" — ${criteriaCount} criteria, est. $${estimatedBudget}, ${maxDuration}min${statusNote}`
            );
            console.log(`[plan-pipeline v2] Created plan ${plan.id} for "${prd.title}" (${status})`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Failed to create plan for "${prd.title}": ${msg}`);
            console.error(`[plan-pipeline v2] Failed to create plan for "${prd.title}":`, err);
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

      console.log(`[plan-pipeline v2] Complete: ${plansCreated} plans created, ${decisions.length} decisions, ${errors.length} errors`);
      return { success: true, plansCreated, decisions: decisions.length, errors: errors.length };
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
