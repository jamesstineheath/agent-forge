import { randomUUID } from "crypto";
import { loadJson, saveJson } from "../storage";
import type { ATCEvent, Priority, WorkItem } from "../types";
import { CycleTimeoutError } from "./types";

const AGENT_RUN_PREFIX = "atc/agent-last-run";

/**
 * Record the last-run timestamp for a named agent.
 * Called by each agent at the end of its cycle.
 */
export async function recordAgentRun(agentName: string): Promise<void> {
  await saveJson(`${AGENT_RUN_PREFIX}/${agentName}`, {
    lastRunAt: new Date().toISOString(),
  });
}

/**
 * Get the last-run timestamp for a named agent.
 * Returns the ISO string or null if never recorded.
 */
export async function getAgentLastRun(agentName: string): Promise<string | null> {
  const data = await loadJson<{ lastRunAt: string }>(`${AGENT_RUN_PREFIX}/${agentName}`);
  return data?.lastRunAt ?? null;
}

/**
 * Parse "Estimated files:" from handoff markdown content.
 * Returns an array of file paths listed after the metadata field.
 */
export function parseEstimatedFiles(content: string): string[] {
  const match = content.match(/\*\*Estimated files?:\*\*\s*(.+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

export function hasFileOverlap(filesA: string[], filesB: string[]): boolean {
  const setB = new Set(filesB);
  return filesA.some((f) => setB.has(f));
}

// High-churn files that should serialize all work items touching them.
export const HIGH_CHURN_FILES = new Set(["lib/atc.ts"]);

export function makeEvent(
  type: ATCEvent["type"],
  workItemId: string,
  previousStatus: string | undefined,
  newStatus: string | undefined,
  details: string
): ATCEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    workItemId,
    details,
    previousStatus,
    newStatus,
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CycleTimeoutError(ms)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Dispatch sort constants and comparator
// ---------------------------------------------------------------------------

// Legacy work items that predate the triagePriority/rank fields default to P1 / 999,
// placing them in the middle of the queue behind any explicitly filed P0 items.
export const DEFAULT_PRIORITY: Priority = 'P1';
export const DEFAULT_RANK = 999;

/** Maps Priority labels to numeric sort keys (lower = higher urgency). */
export const PRIORITY_ORDER: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/**
 * Comparator for sorting WorkItems before dispatch.
 *
 * Sort order (ascending):
 *   1. Priority:  P0 → P1 → P2  (undefined treated as DEFAULT_PRIORITY = 'P1')
 *   2. Rank:      lower rank first (undefined treated as DEFAULT_RANK = 999)
 *   3. createdAt: earliest first (FIFO tiebreaker)
 *
 * Usage: workItems.sort(dispatchSortComparator)
 */
export function dispatchSortComparator(a: WorkItem, b: WorkItem): number {
  // 1. Priority comparison — legacy items without triagePriority default to P1
  const aPriority = PRIORITY_ORDER[a.triagePriority ?? DEFAULT_PRIORITY];
  const bPriority = PRIORITY_ORDER[b.triagePriority ?? DEFAULT_PRIORITY];
  if (aPriority !== bPriority) return aPriority - bPriority;

  // 2. Rank comparison — legacy items without rank default to 999
  const aRank = a.rank ?? DEFAULT_RANK;
  const bRank = b.rank ?? DEFAULT_RANK;
  if (aRank !== bRank) return aRank - bRank;

  // 3. createdAt tiebreaker — earliest submitted wins (FIFO)
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
