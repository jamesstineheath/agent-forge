"use client";

import { useATCEvents } from "@/lib/hooks";
import type { ATCEvent } from "@/lib/types";

const EVENT_LABELS: Record<string, string> = {
  auto_dispatch: "Dispatched",
  status_change: "Status changed",
  conflict: "Conflict detected",
  timeout: "Timed out",
  retry: "Retried",
  parked: "Parked",
  error: "Error",
  cleanup: "Cleanup",
  auto_cancel: "Auto-cancelled",
  escalation: "Escalated",
  escalation_resolved: "Escalation resolved",
  project_completion: "Project completed",
  dependency_block: "Blocked by dependency",
  concurrency_block: "Concurrency limited",
  work_item_reconciled: "Reconciled",
  project_trigger: "Project triggered",
  project_retry: "Project retried",
  dep_resolved: "Dependency resolved",
};

function formatEventNarrative(event: ATCEvent): string {
  const label = EVENT_LABELS[event.type] ?? event.type;
  const details = event.details.replace(/^[\w-]{36}:\s*/, "");

  if (event.type === "auto_dispatch") {
    return `\u{1F4E4} ${details}`;
  }
  if (event.type === "status_change" && event.newStatus === "merged") {
    return `\u2705 Merged \u2014 ${details}`;
  }
  if (event.type === "status_change" && event.newStatus === "failed") {
    return `\u274C Failed \u2014 ${details}`;
  }
  if (event.type === "status_change") {
    return `\u{1F504} ${event.previousStatus} \u2192 ${event.newStatus} \u2014 ${details}`;
  }
  if (event.type === "error") {
    return `\u26A0\uFE0F ${details}`;
  }
  if (event.type === "conflict") {
    return `\u{1F6AB} ${details}`;
  }
  if (event.type === "escalation") {
    return `\u{1F6A8} ${details}`;
  }
  return `${label}: ${details}`;
}

function groupByHour(events: ATCEvent[]): Map<string, ATCEvent[]> {
  const groups = new Map<string, ATCEvent[]>();
  for (const event of events) {
    const date = new Date(event.timestamp);
    const hourKey = `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${date.toLocaleTimeString("en-US", { hour: "numeric", hour12: true })}`;
    const existing = groups.get(hourKey) ?? [];
    existing.push(event);
    groups.set(hourKey, existing);
  }
  return groups;
}

export function ActivityFeed() {
  const { data: events, isLoading } = useATCEvents(200);

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h2 className="text-sm font-display font-bold text-foreground mb-4">Activity</h2>
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const sortedEvents = [...(events ?? [])]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .filter(e => e.workItemId !== "system");

  if (sortedEvents.length === 0) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6">
        <h2 className="text-sm font-display font-bold text-foreground mb-4">Activity</h2>
        <p className="text-sm text-muted-foreground">No recent activity.</p>
      </div>
    );
  }

  const grouped = groupByHour(sortedEvents);

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-5">
      <h2 className="text-sm font-display font-bold text-foreground mb-4">Activity</h2>
      <div className="space-y-4 max-h-[500px] overflow-y-auto">
        {Array.from(grouped.entries()).map(([hour, hourEvents]) => (
          <div key={hour}>
            <h3 className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-widest mb-2">
              {hour}
            </h3>
            <div className="space-y-1.5">
              {hourEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-2 text-sm py-1"
                >
                  <span className="min-w-[50px] text-[10px] text-muted-foreground/60 font-mono tabular-nums">
                    {new Date(event.timestamp).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </span>
                  <span className="text-foreground text-[12px]">
                    {formatEventNarrative(event)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
