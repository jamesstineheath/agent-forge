import { randomUUID } from "crypto";
import { loadJson, saveJson } from "../storage";
import type { ATCEvent } from "../types";
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

export function hasFileOverlap(
  filesA: string[] | undefined,
  filesB: string[] | undefined
): boolean {
  if (!filesA || filesA.length === 0) return false;
  if (!filesB || filesB.length === 0) return false;
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
  details: string,
  extra?: Pick<ATCEvent, "priority" | "rank" | "prioritySkipped">
): ATCEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    workItemId,
    details,
    previousStatus,
    newStatus,
    ...extra,
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
// Dispatch sort constants and comparator (re-exported from client-safe module)
// ---------------------------------------------------------------------------
export { DEFAULT_PRIORITY, DEFAULT_RANK, PRIORITY_ORDER, dispatchSortComparator } from "./sort";
