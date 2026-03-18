import { randomUUID } from "crypto";
import { loadJson, saveJson } from "../storage";
import type { ATCEvent } from "../types";
import { CycleTimeoutError, HEARTBEAT_BLOB_PREFIX } from "./types";
import type { AgentHeartbeat } from "./types";

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

/**
 * Write a heartbeat record for a named agent.
 * Failures are swallowed so they never crash the caller.
 */
export async function writeAgentHeartbeat(heartbeat: AgentHeartbeat): Promise<void> {
  const key = `${HEARTBEAT_BLOB_PREFIX}/${heartbeat.agentName}/latest`;
  await saveJson(key, heartbeat);
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
