/**
 * Architecture Planner — Bridge from PRD + Acceptance Criteria to code-level plans.
 *
 * Takes PM-language acceptance criteria and produces code-level CriterionPlans
 * that the existing decomposer can consume. Also handles gap analysis mode
 * when the Intent Validator finds failed criteria.
 *
 * Uses Claude Opus for all planning (per standing decision: Opus for everything
 * until Model Routing ships).
 */

import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { loadJson, saveJson } from "./storage";
import { listRepos, getRepo } from "./repos";
import { fetchRepoContext, type RepoContext } from "./orchestrator";
import type {
  ArchitecturePlan,
  CriterionPlan,
  IntentCriteria,
  Criterion,
  ValidationResult,
  RepoConfig,
} from "./types";

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL = "claude-opus-4-6";
const PLAN_PREFIX = "architecture-plans";

// ── Storage ──────────────────────────────────────────────────────────────────

function planKey(prdId: string, version: number): string {
  return `${PLAN_PREFIX}/${prdId}-v${version}`;
}

function latestPlanKey(prdId: string): string {
  return `${PLAN_PREFIX}/${prdId}-latest`;
}

export async function getArchitecturePlan(
  prdId: string,
): Promise<ArchitecturePlan | null> {
  return loadJson<ArchitecturePlan>(latestPlanKey(prdId));
}

export async function saveArchitecturePlan(
  plan: ArchitecturePlan,
): Promise<void> {
  await saveJson(planKey(plan.prdId, plan.version), plan);
  await saveJson(latestPlanKey(plan.prdId), plan);
}

// ── Repo Resolution ──────────────────────────────────────────────────────────

async function resolveRepo(
  targetRepo: string | undefined,
): Promise<RepoConfig | null> {
  if (!targetRepo) return null;

  const repos = await listRepos();
  const fullName = targetRepo.includes("/")
    ? targetRepo
    : `jamesstineheath/${targetRepo}`;

  for (const entry of repos) {
    if (entry.fullName === fullName || entry.shortName === targetRepo) {
      return getRepo(entry.id);
    }
  }
  return null;
}

// ── Plan Generation ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an Architecture Planner for an autonomous development pipeline.

Your job: translate PM-language acceptance criteria into code-level implementation plans.

You receive:
- A PRD title and description (PM-language, high-level)
- Acceptance criteria (testable PM-language assertions)
- Repository context (CLAUDE.md, SYSTEM_MAP, ADRs, recent PRs)

You produce: a JSON object with a CriterionPlan per acceptance criterion.

Each CriterionPlan must include:
- approach: 2-3 sentences describing the technical approach
- filesToCreate: new files that need to be created (full paths from repo root)
- filesToModify: existing files that need changes (full paths from repo root)
- apiEndpoints: new or modified API routes (e.g., "GET /api/realestate/listings")
- dataModels: new types/interfaces needed (e.g., "TravelProfile in lib/types.ts")
- dependencies: array of criterionIds that must be completed first
- complexity: "simple" | "moderate" | "complex"
- estimatedCost: dollar amount ($3-5 simple, $5-8 moderate, $8-15 complex)

CRITICAL RULES:
1. Be SPECIFIC about file paths. Use the SYSTEM_MAP and existing code structure to name exact files.
2. Each criterion should touch 1-5 files max. If more, split the approach.
3. Prefer modifying existing files over creating new ones when the feature fits.
4. Identify shared types/models that multiple criteria need and list them in sharedTypes.
5. Dependencies should be minimal. Only add when criterion B literally cannot work without criterion A being merged first.
6. Be honest about complexity. "Simple" means <30 lines of new code. "Complex" means new subsystem.
7. List prerequisites (manual human steps) like adding API keys, DNS config, etc.
8. The decomposer downstream will turn each CriterionPlan into 1-3 work items. Size your plans accordingly.

Output ONLY valid JSON matching this schema:
{
  "criterionPlans": [...],
  "sharedTypes": ["description of shared type and where it goes"],
  "prerequisites": ["manual step needed before execution"],
  "riskAssessment": "1-2 sentence risk summary",
  "estimatedWorkItems": number
}`;

const GAP_ANALYSIS_PROMPT = `You are an Architecture Planner in GAP ANALYSIS mode.

A previous round of development executed against acceptance criteria but some criteria FAILED validation.
You receive the failed criteria with evidence of what went wrong.

Your job: produce targeted fix plans for ONLY the failed criteria.
You also receive the current codebase state (what was already built) so you can plan targeted fixes, not rebuilds.

Be surgical: identify the minimal code change to make each criterion pass.
Prefer fixes over rewrites. If a file exists but has a bug, modify it. Don't recreate.

Output the same JSON schema as normal planning mode, but only for the failed criteria.`;

export interface PlanInput {
  criteria: IntentCriteria;
  prdContent?: string;          // raw PRD text from Notion
  mode: "plan" | "gap-analysis";
  failedResults?: ValidationResult[];  // only in gap-analysis mode
}

export async function generateArchitecturePlan(
  input: PlanInput,
): Promise<ArchitecturePlan> {
  const { criteria, prdContent, mode, failedResults } = input;

  // Resolve repos and fetch context (primary + secondary)
  const repoConfig = await resolveRepo(criteria.targetRepo);
  let repoContext = "";

  if (repoConfig) {
    const ctx = await fetchRepoContext(repoConfig);
    repoContext = formatRepoContext(repoConfig.fullName, ctx);
  } else {
    console.warn(
      `[architecture-planner] No repo config for "${criteria.targetRepo}", planning without codebase context`,
    );
  }

  // Fetch secondary repo context
  if (criteria.secondaryRepos?.length) {
    for (const secondaryRepo of criteria.secondaryRepos) {
      const secondaryConfig = await resolveRepo(secondaryRepo);
      if (secondaryConfig) {
        const ctx = await fetchRepoContext(secondaryConfig);
        repoContext += "\n\n" + formatRepoContext(secondaryConfig.fullName, ctx);
      }
    }
  }

  // Build the user prompt
  const userPrompt = mode === "gap-analysis"
    ? buildGapAnalysisPrompt(criteria, failedResults ?? [], repoContext)
    : buildPlanPrompt(criteria, prdContent, repoContext);

  const systemPrompt = mode === "gap-analysis"
    ? GAP_ANALYSIS_PROMPT
    : SYSTEM_PROMPT;

  // Call Claude
  const cacheEphemeral = {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  };

  const { text } = await generateText({
    model: anthropic(MODEL),
    system: {
      role: "system" as const,
      content: systemPrompt,
      providerOptions: cacheEphemeral,
    },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: repoContext,
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          },
          {
            type: "text",
            text: userPrompt,
          },
        ],
      },
    ],
  });

  // Parse response
  const cleaned = text
    .replace(/^```(?:json)?\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  let parsed: {
    criterionPlans: Omit<CriterionPlan, "criterionId" | "criterionDescription">[];
    sharedTypes: string[];
    prerequisites: string[];
    riskAssessment: string;
    estimatedWorkItems: number;
  };

  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("[architecture-planner] Failed to parse Claude response:", cleaned.slice(0, 500));
    throw new Error(`Architecture plan generation failed: invalid JSON response`);
  }

  // Determine version
  const existing = await getArchitecturePlan(criteria.prdId);
  const version = existing ? existing.version + 1 : 1;

  // Map criterion plans to criteria IDs
  const targetCriteria = mode === "gap-analysis"
    ? criteria.criteria.filter((c) => failedResults?.some((r) => r.criterionId === c.id))
    : criteria.criteria;

  const criterionPlans: CriterionPlan[] = parsed.criterionPlans.map(
    (plan, i) => ({
      ...plan,
      criterionId: targetCriteria[i]?.id ?? `criterion-${i}`,
      criterionDescription: targetCriteria[i]?.description ?? "",
      // Sanitize cost — Claude sometimes returns "$12" instead of 12
      estimatedCost: typeof plan.estimatedCost === "string"
        ? parseFloat(String(plan.estimatedCost).replace(/[^0-9.]/g, "")) || 5
        : (plan.estimatedCost ?? 5),
    }),
  );

  // Build final plan
  const architecturePlan: ArchitecturePlan = {
    prdId: criteria.prdId,
    version,
    targetRepo: criteria.targetRepo
      ? (criteria.targetRepo.includes("/")
        ? criteria.targetRepo
        : `jamesstineheath/${criteria.targetRepo}`)
      : "unknown",
    criterionPlans,
    sharedTypes: parsed.sharedTypes ?? [],
    prerequisites: parsed.prerequisites ?? [],
    riskAssessment: parsed.riskAssessment ?? "",
    estimatedWorkItems: parsed.estimatedWorkItems ?? criterionPlans.length,
    totalEstimatedCost: criterionPlans.reduce((sum, p) => {
      const cost = typeof p.estimatedCost === "string"
        ? parseFloat(String(p.estimatedCost).replace(/[^0-9.]/g, "")) || 5
        : (p.estimatedCost ?? 5);
      return sum + cost;
    }, 0),
    generatedAt: new Date().toISOString(),
    generatedBy: mode === "gap-analysis" ? "gap-analysis" : "architecture-planner",
  };

  await saveArchitecturePlan(architecturePlan);

  return architecturePlan;
}

// ── Plan → Decomposer Markdown ───────────────────────────────────────────────

/**
 * Convert an ArchitecturePlan into the markdown format the existing
 * decomposer expects as "plan content."
 */
export function planToDecomposerMarkdown(
  plan: ArchitecturePlan,
  prdTitle: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${prdTitle}`);
  lines.push("");
  lines.push("## Architecture Plan");
  lines.push("");

  if (plan.sharedTypes?.length > 0) {
    lines.push("### Shared Types & Models");
    for (const t of plan.sharedTypes) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  if (plan.prerequisites?.length > 0) {
    lines.push("### Prerequisites (manual steps)");
    for (const p of plan.prerequisites) {
      lines.push(`- [ ] ${p}`);
    }
    lines.push("");
  }

  lines.push(`### Risk Assessment`);
  lines.push(plan.riskAssessment ?? "");
  lines.push("");

  lines.push("## Implementation Steps");
  lines.push("");

  const criterionPlans = plan.criterionPlans ?? [];
  for (let i = 0; i < criterionPlans.length; i++) {
    const cp = criterionPlans[i];
    lines.push(`### Step ${i + 1}: ${cp.criterionDescription}`);
    lines.push("");
    lines.push(`**Approach:** ${cp.approach}`);
    lines.push("");

    if (cp.filesToCreate?.length > 0) {
      lines.push("**New files:**");
      for (const f of cp.filesToCreate) lines.push(`- \`${f}\``);
      lines.push("");
    }

    if (cp.filesToModify?.length > 0) {
      lines.push("**Modified files:**");
      for (const f of cp.filesToModify) lines.push(`- \`${f}\``);
      lines.push("");
    }

    if (cp.apiEndpoints?.length > 0) {
      lines.push("**API endpoints:**");
      for (const e of cp.apiEndpoints) lines.push(`- ${e}`);
      lines.push("");
    }

    if (cp.dataModels?.length > 0) {
      lines.push("**Data models:**");
      for (const m of cp.dataModels) lines.push(`- ${m}`);
      lines.push("");
    }

    if (cp.dependencies?.length > 0) {
      const depNames = cp.dependencies
        .map((depId) => {
          const dep = criterionPlans.find((p) => p.criterionId === depId);
          return dep ? dep.criterionDescription : depId;
        })
        .join(", ");
      lines.push(`**Depends on:** ${depNames}`);
      lines.push("");
    }

    lines.push(`**Complexity:** ${cp.complexity} | **Est. cost:** $${cp.estimatedCost}`);
    lines.push("");
  }

  lines.push(`---`);
  lines.push(`*Generated by Architecture Planner v${plan.version} at ${plan.generatedAt}*`);
  lines.push(`*Estimated ${plan.estimatedWorkItems} work items | Total cost: $${plan.totalEstimatedCost}*`);

  return lines.join("\n");
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

function buildPlanPrompt(
  criteria: IntentCriteria,
  prdContent: string | undefined,
  repoContext: string,
): string {
  const lines: string[] = [];
  lines.push("## PRD");
  lines.push(`**Title:** ${criteria.prdTitle}`);
  if (prdContent) {
    lines.push("");
    lines.push(prdContent.slice(0, 5000));
  }
  lines.push("");
  lines.push("## Acceptance Criteria to Plan");
  lines.push("");
  for (const c of criteria.criteria) {
    lines.push(`- **[${c.id}]** (${c.type}): ${c.description}`);
  }
  lines.push("");
  lines.push("Generate a CriterionPlan for each criterion above.");
  lines.push("Output ONLY valid JSON.");

  return lines.join("\n");
}

function buildGapAnalysisPrompt(
  criteria: IntentCriteria,
  failedResults: ValidationResult[],
  repoContext: string,
): string {
  const lines: string[] = [];
  lines.push("## Failed Criteria — Gap Analysis");
  lines.push("");
  for (const result of failedResults) {
    const criterion = criteria.criteria.find((c) => c.id === result.criterionId);
    lines.push(`### ${criterion?.description ?? result.criterionDescription}`);
    lines.push(`- **ID:** ${result.criterionId}`);
    lines.push(`- **Status:** ${result.status}`);
    lines.push(`- **Evidence:** ${result.evidence}`);
    if (result.probe) {
      lines.push(`- **Probe:** ${result.probe.method} ${result.probe.path}`);
      lines.push(`- **HTTP Status:** ${result.responseStatus ?? "N/A"}`);
    }
    lines.push("");
  }
  lines.push("Generate targeted fix plans for ONLY the failed criteria above.");
  lines.push("Be surgical. Fix the specific issue, don't rebuild.");
  lines.push("Output ONLY valid JSON.");

  return lines.join("\n");
}

function formatRepoContext(repoName: string, ctx: RepoContext): string {
  const lines: string[] = [];
  lines.push(`## Repository Context: ${repoName}`);
  lines.push("");

  if (ctx.claudeMd) {
    lines.push("### CLAUDE.md");
    lines.push(ctx.claudeMd);
    lines.push("");
  }

  if (ctx.systemMap) {
    lines.push("### System Map");
    lines.push(ctx.systemMap);
    lines.push("");
  }

  if (ctx.adrs.length > 0) {
    lines.push("### Architecture Decision Records");
    for (const adr of ctx.adrs) {
      lines.push(`- **${adr.title}** (${adr.status}): ${adr.decision}`);
    }
    lines.push("");
  }

  if (ctx.recentPRs.length > 0) {
    lines.push("### Recent Merged PRs");
    for (const pr of ctx.recentPRs) {
      lines.push(`- ${pr.title}`);
      lines.push(`  Files: ${pr.files.slice(0, 5).join(", ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
