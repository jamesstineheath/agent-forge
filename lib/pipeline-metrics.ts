/**
 * Pipeline Metrics — computes quality, speed, and cost metrics
 * from work item and criteria data.
 */

import { listWorkItems } from "./work-items";
import { listAllCriteria, getCriteria } from "./intent-criteria";
import type { PipelineMetrics, WorkItemIndexEntry } from "./types";

export async function computePipelineMetrics(
  periodDays = 7,
): Promise<PipelineMetrics> {
  const cutoff = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all work items
  const allItems = await listWorkItems({});

  // Filter to period (use updatedAt from index entries)
  const periodItems = allItems.filter((item) => {
    const ts = (item as unknown as { updatedAt?: string }).updatedAt;
    return !ts || ts >= cutoff;
  });

  // Compute speed metrics
  const mergedItems = periodItems.filter((i) => i.status === "merged");
  const timesToMerge: number[] = [];

  for (const item of mergedItems) {
    const wi = item as unknown as {
      execution?: { startedAt?: string; completedAt?: string };
    };
    if (wi.execution?.startedAt && wi.execution?.completedAt) {
      const start = new Date(wi.execution.startedAt).getTime();
      const end = new Date(wi.execution.completedAt).getTime();
      if (end > start) {
        timesToMerge.push(end - start);
      }
    }
  }

  timesToMerge.sort((a, b) => a - b);
  const avgTimeToMerge = timesToMerge.length > 0
    ? timesToMerge.reduce((a, b) => a + b, 0) / timesToMerge.length
    : 0;
  const p90TimeToMerge = timesToMerge.length > 0
    ? timesToMerge[Math.floor(timesToMerge.length * 0.9)] ?? timesToMerge[timesToMerge.length - 1]
    : 0;

  // Compute quality metrics
  const failedItems = periodItems.filter((i) => i.status === "failed");
  const cancelledItems = periodItems.filter((i) => i.status === "cancelled");
  const totalTerminal = mergedItems.length + failedItems.length + cancelledItems.length;
  const workItemSuccessRate = totalTerminal > 0
    ? mergedItems.length / totalTerminal
    : 0;

  // Retry rate
  const retriedItems = periodItems.filter((item) => {
    const wi = item as unknown as { execution?: { retryCount?: number } };
    return (wi.execution?.retryCount ?? 0) > 0;
  });
  const retryRate = periodItems.length > 0
    ? retriedItems.length / periodItems.length
    : 0;

  const firstAttemptMerged = mergedItems.filter((item) => {
    const wi = item as unknown as { execution?: { retryCount?: number } };
    return (wi.execution?.retryCount ?? 0) === 0;
  });
  const firstAttemptSuccessRate = mergedItems.length > 0
    ? firstAttemptMerged.length / mergedItems.length
    : 0;

  // Compute cost metrics
  let totalCost = 0;
  let costItemCount = 0;
  for (const item of periodItems) {
    const wi = item as unknown as { execution?: { actualCost?: number } };
    if (wi.execution?.actualCost) {
      totalCost += wi.execution.actualCost;
      costItemCount++;
    }
  }

  const avgCostPerWorkItem = costItemCount > 0 ? totalCost / costItemCount : 0;

  // Criteria metrics
  const criteriaIndex = await listAllCriteria();
  let totalCriteria = 0;
  let passedCriteria = 0;
  let totalEstCost = 0;

  for (const entry of criteriaIndex) {
    totalCriteria += entry.criteriaCount;
    passedCriteria += entry.passedCount;
    totalEstCost += entry.totalEstimatedCost;
  }

  const criteriaPassRate = totalCriteria > 0
    ? passedCriteria / totalCriteria
    : 0;

  const avgCostPerCriterion = totalCriteria > 0 && totalCost > 0
    ? totalCost / totalCriteria
    : totalEstCost > 0 ? totalEstCost / totalCriteria : 0;

  const costEfficiency = totalCost > 0
    ? passedCriteria / totalCost
    : 0;

  return {
    avgTimeToMergeMs: Math.round(avgTimeToMerge),
    avgTimeToFirstMergeMs: 0, // TODO: requires project-level tracking
    avgPlanGenerationMs: 0,    // TODO: requires plan timing instrumentation
    p90TimeToMergeMs: Math.round(p90TimeToMerge),

    workItemSuccessRate: Math.round(workItemSuccessRate * 1000) / 1000,
    criteriaPassRate: Math.round(criteriaPassRate * 1000) / 1000,
    retryRate: Math.round(retryRate * 1000) / 1000,
    firstAttemptSuccessRate: Math.round(firstAttemptSuccessRate * 1000) / 1000,

    totalCost: Math.round(totalCost * 100) / 100,
    avgCostPerWorkItem: Math.round(avgCostPerWorkItem * 100) / 100,
    avgCostPerCriterion: Math.round(avgCostPerCriterion * 100) / 100,
    costEfficiency: Math.round(costEfficiency * 1000) / 1000,

    totalWorkItems: periodItems.length,
    totalProjects: criteriaIndex.length,
    totalCriteria,
    periodDays,
  };
}

/**
 * Format duration in ms to human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return "N/A";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}
