import type { WorkItem } from "./types";
import type { ProjectStatus } from "./types";
import { readFileContent } from "./github";
import { parseSpikeFindings } from "./spike-template";
import type { SpikeFindingsParsed } from "./spike-template";
import { addCommentToPage } from "./notion";
import { updateProjectStatus } from "./notion";
import { buildSpikeCompletionSummaryPrompt } from "./pm-prompts";
import { routedAnthropicCall } from "./model-router";

export type SpikeCompletionAction =
  | { type: "GO"; technicalApproach: string }
  | { type: "GO_WITH_CHANGES"; suggestedRevisions: string }
  | { type: "NO_GO"; rationale: string };

/**
 * Handles post-execution actions for a completed spike work item.
 * Reads findings from the target repo, posts a Notion comment on the parent PRD,
 * and transitions the PRD status based on the spike recommendation.
 */
export async function handleSpikeCompletion(
  workItem: WorkItem,
): Promise<SpikeCompletionAction> {
  // 1. Determine target repo coordinates
  const [owner, repo] = workItem.targetRepo.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Cannot determine repo for work item ${workItem.id}: targetRepo="${workItem.targetRepo}"`,
    );
  }

  // 2. Read spike findings markdown from target repo
  const spikePath = `spikes/${workItem.id}.md`;
  const rawFindings = await readFileContent(owner, repo, spikePath);

  // 3. Parse findings
  const findings: SpikeFindingsParsed = parseSpikeFindings(rawFindings);

  // 4. Determine the parent PRD Notion page ID from spike metadata
  const parentPrdId = workItem.spikeMetadata?.parentPrdId;
  if (!parentPrdId) {
    throw new Error(
      `No spikeMetadata.parentPrdId on work item ${workItem.id} — cannot post PRD update`,
    );
  }

  // 5. Generate summary comment via Claude
  const prompt = buildSpikeCompletionSummaryPrompt(workItem, findings);
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
    // No status change — PRD stays at Idea
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
    `Unknown spike recommendation "${findings.recommendation}" on work item ${workItem.id}`,
  );
}
