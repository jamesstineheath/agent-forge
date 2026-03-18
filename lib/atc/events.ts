import { loadJson, saveJson } from "../storage";
import type { ATCEvent, ATCState } from "../types";
import { ATC_STATE_KEY, ATC_EVENTS_KEY, MAX_EVENTS } from "./types";

export async function getATCState(): Promise<ATCState> {
  const state = await loadJson<ATCState>(ATC_STATE_KEY);
  if (!state) {
    return {
      lastRunAt: new Date(0).toISOString(),
      activeExecutions: [],
      queuedItems: 0,
      recentEvents: [],
    };
  }
  return state;
}

export async function getATCEvents(limit = 20): Promise<ATCEvent[]> {
  const events = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
  return events.slice(-limit);
}

export async function getWorkItemEvents(
  workItemId: string
): Promise<ATCEvent[]> {
  const key = `work-items/${workItemId}/events`;
  return (await loadJson<ATCEvent[]>(key)) ?? [];
}

/**
 * Persist cycle events to both the global rolling log and per-work-item logs.
 */
export async function persistEvents(events: ATCEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Global rolling log (keep last MAX_EVENTS)
  const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
  const updated = [...existing, ...events].slice(-MAX_EVENTS);
  await saveJson(ATC_EVENTS_KEY, updated);

  // Per-work-item logs (full history, no cap)
  const itemEventMap = new Map<string, ATCEvent[]>();
  for (const evt of events) {
    if (evt.workItemId === "system") continue;
    const arr = itemEventMap.get(evt.workItemId) ?? [];
    arr.push(evt);
    itemEventMap.set(evt.workItemId, arr);
  }
  for (const [itemId, itemEvents] of itemEventMap) {
    try {
      const key = `work-items/${itemId}/events`;
      const existingItemEvents = (await loadJson<ATCEvent[]>(key)) ?? [];
      await saveJson(key, [...existingItemEvents, ...itemEvents]);
    } catch (err) {
      console.warn(
        `[events] Failed to persist events for work item ${itemId}:`,
        err
      );
    }
  }
}
