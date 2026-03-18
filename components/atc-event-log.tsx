"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { ATCEvent } from "@/lib/types";

const EVENT_COLORS: Record<ATCEvent["type"], string> = {
  status_change: "bg-status-queued/10 text-status-queued",
  timeout: "bg-status-blocked/10 text-status-blocked",
  concurrency_block: "bg-status-executing/10 text-status-executing",
  auto_dispatch: "bg-status-merged/10 text-status-merged",
  conflict: "bg-status-reviewing/10 text-status-reviewing",
  retry: "bg-status-executing/10 text-status-executing",
  parked: "bg-muted text-muted-foreground",
  error: "bg-status-blocked/10 text-status-blocked",
  cleanup: "bg-muted text-muted-foreground",
  project_trigger: "bg-primary/10 text-primary",
  project_completion: "bg-status-merged/10 text-status-merged",
  work_item_reconciled: "bg-status-queued/10 text-status-queued",
  escalation: "bg-status-blocked/10 text-status-blocked",
  escalation_timeout: "bg-status-blocked/15 text-status-blocked",
  escalation_resolved: "bg-status-merged/10 text-status-merged",
  dependency_block: "bg-status-reviewing/10 text-status-reviewing",
  auto_cancel: "bg-status-blocked/10 text-status-blocked",
  project_retry: "bg-status-executing/15 text-status-executing",
  dep_resolved: "bg-status-merged/15 text-status-merged",
};

const ALL_TYPES = Object.keys(EVENT_COLORS) as ATCEvent["type"][];

function formatRelativeTime(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface ATCEventLogProps {
  events: ATCEvent[];
}

export function ATCEventLog({ events }: ATCEventLogProps) {
  const [activeFilters, setActiveFilters] = useState<Set<ATCEvent["type"]>>(new Set());

  function toggleFilter(type: ATCEvent["type"]) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }

  const filtered =
    activeFilters.size === 0
      ? events
      : events.filter((e) => activeFilters.has(e.type));

  // Newest first
  const sorted = [...filtered].reverse();

  return (
    <div className="space-y-3">
      {/* Type filter badges */}
      <div className="flex flex-wrap gap-1.5">
        {ALL_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => toggleFilter(type)}
            className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-opacity ${
              EVENT_COLORS[type]
            } ${
              activeFilters.size > 0 && !activeFilters.has(type)
                ? "opacity-40"
                : "opacity-100"
            }`}
          >
            {type.replace("_", " ")}
          </button>
        ))}
        {activeFilters.size > 0 && (
          <button
            onClick={() => setActiveFilters(new Set())}
            className="px-2 py-0.5 rounded-full text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-accent"
          >
            clear
          </button>
        )}
      </div>

      {/* Event list */}
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          No events to display.
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((event) => (
            <div
              key={event.id}
              className="flex gap-3 p-3 rounded-lg border bg-card text-sm"
            >
              <div className="flex-shrink-0 pt-0.5">
                <Badge className={`${EVENT_COLORS[event.type]} text-xs`}>
                  {event.type.replace("_", " ")}
                </Badge>
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-muted-foreground">
                    {event.workItemId.slice(0, 8)}
                  </span>
                  {event.previousStatus && event.newStatus && (
                    <span className="text-xs text-muted-foreground">
                      {event.previousStatus} → {event.newStatus}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {formatRelativeTime(event.timestamp)}
                  </span>
                </div>
                <p className="text-xs text-foreground/80 break-words">
                  {event.details}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
