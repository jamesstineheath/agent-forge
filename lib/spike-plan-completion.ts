/**
 * lib/spike-plan-completion.ts
 *
 * Handles post-execution actions for a completed spike plan (Pipeline v2).
 * Reads findings from the target repo, posts a Notion comment on the parent PRD,
 * and transitions the PRD status based on the spike recommendation.
 *
 * This is the plan-based equivalent of spike-completion.ts (which handles work items).
 */

import type { Plan, ProjectStatus } from "./types";
import { readFileContent } from "./github";
import { parseSpikeFindings } from "./spike-template";
import type { SpikeFindingsParsed } from "./spike-template";
import { addCommentToPage, updateProjectStatus } from "./notion";
import { buildSpikeCompletionSummaryPrompt } from "./pm-prompts";
import { routedAnthropicCall } from "./model-router";

export type SpikeCompletionAction =
  | { type: "GO"; technicalApproach: string }
  | { type: "GO_WITH_CHANGES"; suggestedRevisions: string }
  | { type: "NO_GO"; rationale: string };

/**
 * Handle post-execution actions for a completed spike plan.
 * Reads findings from the target repo, posts a Notion comment on the parent PRD,
 * and transitions the PRD status based on the spike recommendation.
 */
export async function handlePlanSpikeCompletion(
  plan: Plan,
): Promise<SpikeCompletionAction> {
  const meta = plan.spikeMetadata;
  if (!meta) {
    throw new Error(
      `No spikeMetadata on plan ${plan.id} — cannot process spike completion`,
    );
  }

  // 1. Determine target repo coordinates
  const [owner, repo] = plan.targetRepo.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Cannot determine repo for plan ${plan.id}: targetRepo="${plan.targetRepo}"`,
    );
  }

  // 2. Read spike findings markdown from target repo
  const spikePath = `spikes/${plan.prdId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`;
  const rawFindings = await readFileContent(owner, repo, spikePath);

  // 3. Parse findings
  const findings: SpikeFindingsParsed = parseSpikeFindings(rawFindings);

  // 4. Determine the parent PRD Notion page ID
  const parentPrdId = meta.parentPrdId;

  // 5. Generate summary comment via Claude
  const prompt = buildSpikeCompletionSummaryPrompt(
    { id: plan.id, title: plan.prdTitle },
    findings,
  );
  const { text: summaryComment } = await routedAnthropicCall({
    model: "claude-sonnet-4-6",
    taskType: "project_manager",
    prompt,
    floorModel: "sonnet",
  });

  // 6. Post summary comment on Notion PRD
  await addCommentToPage(parentPrdId, summaryComment);

  // 7. Take action based on recommendation
  const rec = findings.recommendation;

  if (rec === "GO") {
    await updateProjectStatus(parentPrdId, "Draft" as ProjectStatus);
    if (findings.findings) {
      await addCommentToPage(
        parentPrdId,
        `Technical Approach (from spike):\n${findings.findings}`,
      );
    }
    return { type: "GO", technicalApproach: findings.findings ?? "" };
  }

  if (rec === "GO_WITH_CHANGES") {
    // No status change — PRD stays at Idea for human review
    if (findings.implications) {
      await addCommentToPage(
        parentPrdId,
        `Suggested Revisions (from spike):\n${findings.implications}`,
      );
    }
    return {
      type: "GO_WITH_CHANGES",
      suggestedRevisions: findings.implications ?? "",
    };
  }

  if (rec === "NO_GO") {
    await updateProjectStatus(parentPrdId, "Not Feasible" as ProjectStatus);
    return {
      type: "NO_GO",
      rationale: findings.implications ?? "",
    };
  }

  throw new Error(
    `Unknown spike recommendation "${findings.recommendation}" on plan ${plan.id}`,
  );
}
