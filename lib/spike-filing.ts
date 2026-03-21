/**
 * lib/spike-filing.ts
 *
 * Files spike work items into the work-items store.
 * Called when a human approves a spike recommendation (via webhook)
 * or when the PM Agent programmatically files a spike.
 */

import { createWorkItem, updateWorkItem } from "./work-items";
import type { WorkItem } from "./types";
import { persistEvents } from "./atc/events";
import type { ATCEvent } from "./types";

export interface FileSpikeParams {
  parentPrdId: string;
  technicalQuestion: string;
  scope: string;
  recommendedBy: "pm-agent" | "manual";
  targetRepo?: string;
}

export async function fileSpikeWorkItem(
  params: FileSpikeParams
): Promise<WorkItem> {
  const {
    parentPrdId,
    technicalQuestion,
    scope,
    recommendedBy,
    targetRepo = "agent-forge",
  } = params;

  const title = `Spike: ${technicalQuestion.slice(0, 80)}${technicalQuestion.length > 80 ? "..." : ""}`;

  const workItem = await createWorkItem({
    title,
    description: `Technical spike to investigate: ${technicalQuestion}\n\nScope: ${scope}\n\nSource PRD: ${parentPrdId}`,
    type: "spike",
    targetRepo,
    source: {
      type: "pm-agent",
      sourceId: parentPrdId,
    },
    priority: "medium",
    riskLevel: "low",
    complexity: "simple",
    dependencies: [],
    spikeMetadata: {
      parentPrdId,
      technicalQuestion,
      scope,
      recommendedBy,
    },
  });

  // createWorkItem hardcodes status to "filed" — update to "ready"
  const readyItem = await updateWorkItem(workItem.id, { status: "ready" });

  const event: ATCEvent = {
    id: `spike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: "spike_filed",
    workItemId: workItem.id,
    details: `Spike filed for PRD ${parentPrdId}: "${technicalQuestion}" (scope: ${scope}, by: ${recommendedBy})`,
  };
  await persistEvents([event]);

  return readyItem ?? workItem;
}
