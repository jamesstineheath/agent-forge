import { loadJson, saveJson } from "../storage";
import type { ATCEvent, ATCState } from "../types";
import type { ModelCallEvent, ModelEscalationEvent, ModelEvent, TaskType } from "./types";
import { ATC_STATE_KEY, ATC_EVENTS_KEY, MAX_EVENTS, MODEL_EVENTS_KEY } from "./types";

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

// -- Routing threshold event helper -------------------------------------------

export async function emitRoutingThresholdEvent(payload: {
  signalKey: string;
  forceModel: 'opus' | 'sonnet';
  triggeringFailureRate: number;
  sampleSize: number;
}): Promise<void> {
  const event: ATCEvent = {
    id: `rte-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: "routing_threshold_tightened",
    workItemId: "system",
    details: `Override ${payload.signalKey} → ${payload.forceModel} (failure rate: ${(payload.triggeringFailureRate * 100).toFixed(1)}%, n=${payload.sampleSize})`,
  };
  await persistEvents([event]);
}

// -- Model event emit helpers -------------------------------------------------

async function appendModelEvent(event: ModelEvent): Promise<void> {
  const existing = (await loadJson<ModelEvent[]>(MODEL_EVENTS_KEY)) ?? [];
  const updated = [...existing, event].slice(-MAX_EVENTS);
  await saveJson(MODEL_EVENTS_KEY, updated);
}

export async function emitModelCallEvent(
  event: Omit<ModelCallEvent, 'eventType' | 'timestamp'>
): Promise<void> {
  const fullEvent: ModelCallEvent = {
    ...event,
    eventType: 'model_call',
    timestamp: new Date().toISOString(),
  };
  await appendModelEvent(fullEvent);
}

export async function emitModelEscalationEvent(
  event: Omit<ModelEscalationEvent, 'eventType' | 'timestamp'>
): Promise<void> {
  const fullEvent: ModelEscalationEvent = {
    ...event,
    eventType: 'model_escalation',
    timestamp: new Date().toISOString(),
  };
  await appendModelEvent(fullEvent);
}

// -- Model event query helpers ------------------------------------------------

async function getModelEvents(): Promise<ModelEvent[]> {
  return (await loadJson<ModelEvent[]>(MODEL_EVENTS_KEY)) ?? [];
}

export async function queryModelCallEvents(filter: {
  startDate?: string;
  endDate?: string;
  taskType?: TaskType;
  model?: string;
}): Promise<ModelCallEvent[]> {
  const allEvents = await getModelEvents();
  return allEvents.filter((e): e is ModelCallEvent => {
    if (e.eventType !== 'model_call') return false;
    if (filter.startDate && e.timestamp < filter.startDate) return false;
    if (filter.endDate && e.timestamp > filter.endDate) return false;
    if (filter.taskType && e.taskType !== filter.taskType) return false;
    if (filter.model && e.model !== filter.model) return false;
    return true;
  });
}

export async function queryModelEscalationEvents(filter: {
  startDate?: string;
  endDate?: string;
  taskType?: TaskType;
}): Promise<ModelEscalationEvent[]> {
  const allEvents = await getModelEvents();
  return allEvents.filter((e): e is ModelEscalationEvent => {
    if (e.eventType !== 'model_escalation') return false;
    if (filter.startDate && e.timestamp < filter.startDate) return false;
    if (filter.endDate && e.timestamp > filter.endDate) return false;
    if (filter.taskType && e.taskType !== filter.taskType) return false;
    return true;
  });
}
