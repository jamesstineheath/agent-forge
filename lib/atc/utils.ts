import { randomUUID } from "crypto";
import { loadJson, saveJson } from "../storage";
import type { ATCEvent } from "../types";

/**
 * Shared context passed to each agent's run function.
 * Agents append to `events` during their cycle.
 */
export interface CycleContext {
  now: Date;
  events: ATCEvent[];
}

export function makeEvent(
  type: ATCEvent["type"],
  workItemId: string,
  previousStatus: string | undefined,
  newStatus: string | undefined,
  details: string,
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

// --- Agent health tracking ---

const AGENT_HEALTH_PREFIX = "atc/agent-health";

interface AgentRunRecord {
  lastRunAt: string;
  durationMs?: number;
}

/**
 * Record that an agent completed a run.
 * Called at the end of each agent's cycle.
 */
export async function recordAgentRun(
  name: string,
  durationMs?: number,
): Promise<void> {
  const key = `${AGENT_HEALTH_PREFIX}/${name}`;
  await saveJson<AgentRunRecord>(key, {
    lastRunAt: new Date().toISOString(),
    durationMs,
  });
}

/**
 * Get the last run timestamp for an agent.
 * Returns null if the agent has never run.
 */
export async function getAgentLastRun(
  name: string,
): Promise<AgentRunRecord | null> {
  const key = `${AGENT_HEALTH_PREFIX}/${name}`;
  return loadJson<AgentRunRecord>(key);
}

/**
 * Get last-run records for all known agents.
 */
export async function getAllAgentHealth(): Promise<
  Record<string, AgentRunRecord | null>
> {
  const agents = ["dispatcher", "health-monitor", "project-manager", "supervisor"];
  const results: Record<string, AgentRunRecord | null> = {};
  for (const agent of agents) {
    results[agent] = await getAgentLastRun(agent);
  }
  return results;
}
