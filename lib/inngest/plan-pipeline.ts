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
import type { Project } from "@/lib/types";

const SUPERVISOR_LOCK_KEY = "atc/supervisor-lock";

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
 * Replaces the old criteria-import → architecture-planning → decomposition
 * flow with a single data-gathering step. No LLM calls.
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
  async ({ step }) => {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      await writeExecutionLog({ functionId: 'plan-pipeline', status: 'running', startedAt, completedAt: null, durationMs: null });
    } catch (e) {
      console.error('[plan-pipeline] Failed to write running log:', e);
    }

    // Step 1: Preflight — kill switch + lock
    const preflight = await step.run("preflight", async () => {
      if (await isPipelineKilled()) {
        return { skipped: true, reason: "kill-switch" } as const;
      }
      const locked = await acquireLock(SUPERVISOR_LOCK_KEY);
      if (!locked) {
        return { skipped: true, reason: "lock held" } as const;
      }
      return { skipped: false } as const;
    });

    if (preflight.skipped) {
      return { success: true, skipped: true, reason: preflight.reason };
    }

    const trace = startTrace("plan-pipeline");
    const decisions: string[] = [];
    const errors: string[] = [];
    let plansCreated = 0;

    try {
      // Step 2: Create plans for Approved PRDs
      const result = await step.run("create-plans", async () => {
        const phaseStart = Date.now();

        // Query Notion for Approved PRDs
        const approvedPRDs = await queryProjects("Approved" as Project["status"]);
        if (approvedPRDs.length === 0) {
          return { plansCreated: 0, decisions: ["No Approved PRDs found"], errors: [], durationMs: Date.now() - phaseStart };
        }

        // Get existing plans to avoid duplicates
        const existingPlans = await listPlans();
        const existingPrdIds = new Set(existingPlans.map(p => p.prdId));

        const localDecisions: string[] = [];
        const localErrors: string[] = [];
        let created = 0;

        for (const prd of approvedPRDs) {
          // Skip if plan already exists for this PRD
          if (existingPrdIds.has(prd.projectId)) {
            continue;
          }

          try {
            // 1. Fetch PRD content (acceptance criteria)
            const prdContent = await fetchPageContent(prd.id);
            if (!prdContent || prdContent.trim().length === 0) {
              localErrors.push(`PRD "${prd.title}" has no content — skipped`);
              continue;
            }

            // 2. Query KG for affected files
            const targetRepo = prd.targetRepo;
            if (!targetRepo) {
              localErrors.push(`PRD "${prd.title}" has no target repo — skipped`);
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
                // Search KG for entities matching keywords from criteria
                const keywords = extractKeywords(prdContent);
                const matchedFiles = new Set<string>();

                for (const keyword of keywords) {
                  const results = queryGraph(graph, { namePattern: keyword });
                  for (const entity of results.entities) {
                    matchedFiles.add(entity.filePath);
                  }
                }

                // Get blast radius from matched files
                const matchedFileArray = [...matchedFiles];
                if (matchedFileArray.length > 0) {
                  const blast = getBlastRadius(graph, matchedFileArray, 2);
                  affectedFiles = blast.affectedFiles;
                }

                // Get system map sections and relevant ADRs
                // (pass empty strings for data we might not have)
                const systemMapSections = getRelevantSystemMapSections(
                  "", // Will be populated if available
                  affectedFiles
                );
                const relevantADRs = getRelevantADRs(
                  [], // Will be populated if available
                  affectedFiles,
                  keywords
                );

                kgContext = {
                  affectedFiles: affectedFiles.slice(0, 50), // Cap at 50 files
                  systemMapSections,
                  relevantADRs,
                  entityCount: graph.entities.size,
                };
              }
            } catch (kgErr) {
              console.warn(`[plan-pipeline] KG query failed for ${targetRepo}:`, kgErr);
              // Non-fatal: proceed without KG context
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
              console.warn(`[plan-pipeline] Failed to update PRD status for "${prd.title}":`, notionErr);
            }

            created++;
            const statusNote = status === "needs_review" ? " (needs_review: budget > $30)" : "";
            localDecisions.push(
              `Created plan ${plan.id} for "${prd.title}" — ${criteriaCount} criteria, est. $${estimatedBudget}, ${maxDuration}min${statusNote}`
            );
            console.log(`[plan-pipeline] Created plan ${plan.id} for "${prd.title}" (${status})`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            localErrors.push(`Failed to create plan for "${prd.title}": ${msg}`);
            console.error(`[plan-pipeline] Failed to create plan for "${prd.title}":`, err);
          }
        }

        return {
          plansCreated: created,
          decisions: localDecisions,
          errors: localErrors,
          durationMs: Date.now() - phaseStart,
        };
      });

      plansCreated = result.plansCreated;
      decisions.push(...result.decisions);
      errors.push(...result.errors);

      addPhase(trace, { name: "create-plans", durationMs: result.durationMs });
      for (const d of result.decisions) addDecision(trace, { action: "create-plans", reason: d });
      for (const e of result.errors) addError(trace, `create-plans: ${e}`);

      // Step 3: Persist results + release lock
      await step.run("persist-results", async () => {
        // Update ATC state with plan counts
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
        await releaseLock(SUPERVISOR_LOCK_KEY);
      });

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

      await step.run("release-lock-on-error", async () => {
        await releaseLock(SUPERVISOR_LOCK_KEY);
      });
      throw err;
    }
  },
);

/**
 * Extract keywords from acceptance criteria text for KG search.
 * Looks for file paths, component names, module names, etc.
 */
function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();

  // Extract file paths (e.g., lib/plans.ts, app/api/plans/route.ts)
  const filePathRegex = /(?:[\w-]+\/)+[\w.-]+\.\w+/g;
  for (const match of text.matchAll(filePathRegex)) {
    const parts = match[0].split("/");
    // Add the filename without extension as a keyword
    const filename = parts[parts.length - 1].replace(/\.\w+$/, "");
    keywords.add(filename);
    // Add directory names too
    for (const part of parts.slice(0, -1)) {
      if (part.length > 2) keywords.add(part);
    }
  }

  // Extract PascalCase/camelCase identifiers
  const identifierRegex = /\b[A-Z][a-zA-Z0-9]{2,}\b/g;
  for (const match of text.matchAll(identifierRegex)) {
    keywords.add(match[0]);
  }

  // Extract quoted terms
  const quotedRegex = /`([^`]+)`/g;
  for (const match of text.matchAll(quotedRegex)) {
    if (match[1].length > 2 && match[1].length < 50) {
      keywords.add(match[1]);
    }
  }

  return [...keywords].slice(0, 30); // Cap at 30 keywords
}

/**
 * Count acceptance criteria in PRD content.
 * Looks for numbered lists, checkbox items, and AC-prefixed items.
 */
function countCriteria(text: string): number {
  // Count items that look like acceptance criteria
  const patterns = [
    /^\s*\d+\.\s+\[/gm,        // "1. [DATA]" or "1. [UI]"
    /^\s*-\s+\[[ x]\]/gm,       // "- [ ]" or "- [x]" checkboxes
    /^\s*AC-?\d+/gim,           // "AC-1" or "AC1"
    /^\s*\*\*AC/gm,             // "**AC"
  ];

  let count = 0;
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) count += matches.length;
  }

  // Fallback: count numbered list items if no AC patterns found
  if (count === 0) {
    const numberedItems = text.match(/^\s*\d+\.\s+\S/gm);
    count = numberedItems?.length ?? 1;
  }

  return Math.max(count, 1); // At least 1
}
