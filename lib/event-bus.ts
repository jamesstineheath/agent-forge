import { loadJson, saveJson } from "./storage";
import type { WebhookEvent, EventQueryOptions } from "./event-bus-types";

const EVENTS_PREFIX = "events";
const MAX_EVENTS_PER_PARTITION = 500;
const RETENTION_HOURS = 30 * 24; // 30 days

/**
 * Get the partition key for a given timestamp (hourly buckets).
 * Format: events/YYYY-MM-DD-HH
 */
function partitionKey(timestamp: string): string {
  const d = new Date(timestamp);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${EVENTS_PREFIX}/${yyyy}-${mm}-${dd}-${hh}`;
}

/**
 * Generate partition keys covering a time range.
 */
function partitionKeysInRange(since: Date, until: Date): string[] {
  const keys: string[] = [];
  const current = new Date(since);
  current.setUTCMinutes(0, 0, 0);

  while (current <= until) {
    keys.push(partitionKey(current.toISOString()));
    current.setUTCHours(current.getUTCHours() + 1);
  }
  return keys;
}

/**
 * Append events to the hourly-partitioned event log.
 */
export async function appendEvents(events: WebhookEvent[]): Promise<void> {
  // Group events by partition
  const byPartition = new Map<string, WebhookEvent[]>();
  for (const event of events) {
    const key = partitionKey(event.timestamp);
    const existing = byPartition.get(key) ?? [];
    existing.push(event);
    byPartition.set(key, existing);
  }

  // Append to each partition
  for (const [key, newEvents] of byPartition) {
    const existing = (await loadJson<WebhookEvent[]>(key)) ?? [];
    const combined = [...existing, ...newEvents];
    // Cap per-partition to avoid unbounded growth
    const trimmed =
      combined.length > MAX_EVENTS_PER_PARTITION
        ? combined.slice(combined.length - MAX_EVENTS_PER_PARTITION)
        : combined;
    await saveJson(key, trimmed);
  }
}

/**
 * Query events across partitions with optional filters.
 */
export async function queryEvents(opts: EventQueryOptions): Promise<WebhookEvent[]> {
  const limit = opts.limit ?? 100;
  const since = opts.since ? new Date(opts.since) : new Date(Date.now() - 60 * 60 * 1000);
  const until = new Date();

  const keys = partitionKeysInRange(since, until);

  let allEvents: WebhookEvent[] = [];

  // Read partitions in reverse (newest first) for efficiency
  for (let i = keys.length - 1; i >= 0; i--) {
    const partition = (await loadJson<WebhookEvent[]>(keys[i])) ?? [];
    allEvents = [...partition, ...allEvents];
  }

  // Sort by timestamp descending (newest first)
  allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Apply filters
  let filtered = allEvents;

  if (opts.types && opts.types.length > 0) {
    const typeSet = new Set(opts.types);
    filtered = filtered.filter((e) => typeSet.has(e.type));
  }

  if (opts.repo) {
    filtered = filtered.filter((e) => e.repo === opts.repo);
  }

  if (opts.since) {
    const sinceMs = new Date(opts.since).getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceMs);
  }

  return filtered.slice(0, limit);
}

/**
 * Convenience wrapper to get recent events.
 */
export async function getRecentEvents(minutes: number): Promise<WebhookEvent[]> {
  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  return queryEvents({ since, limit: 200 });
}

/**
 * Clean up partitions older than 30 days.
 */
export async function cleanupOldPartitions(): Promise<number> {
  const { deleteJson } = await import("./storage");
  const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000);
  let deleted = 0;

  // Generate keys for the 24 hours before the cutoff (clean one day at a time)
  const cleanStart = new Date(cutoff);
  cleanStart.setUTCDate(cleanStart.getUTCDate() - 1);
  cleanStart.setUTCHours(0, 0, 0, 0);

  const keys = partitionKeysInRange(cleanStart, cutoff);

  for (const key of keys) {
    try {
      await deleteJson(key);
      deleted++;
    } catch {
      // Partition may not exist, that's fine
    }
  }

  return deleted;
}
