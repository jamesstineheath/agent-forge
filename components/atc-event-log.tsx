"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { ATCEvent } from "@/lib/types";

const EVENT_COLORS: Record<ATCEvent["type"], string> = {
  status_change: "bg-blue-100 text-blue-700",
  timeout: "bg-red-100 text-red-700",
  concurrency_block: "bg-yellow-100 text-yellow-700",
  auto_dispatch: "bg-green-100 text-green-700",
  conflict: "bg-orange-100 text-orange-700",
  retry: "bg-amber-100 text-amber-700",
  parked: "bg-slate-100 text-slate-600",
  error: "bg-red-100 text-red-700",
  cleanup: "bg-teal-100 text-teal-700",
  project_trigger: "bg-indigo-100 text-indigo-700",
  escalation: "bg-red-100 text-red-700",
  escalation_timeout: "bg-red-200 text-red-800",
  escalation_resolved: "bg-green-100 text-green-700",
  dependency_block: "bg-purple-100 text-purple-700",
  auto_cancel: "bg-rose-100 text-rose-700",
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
            className="px-2 py-0.5 rounded-full text-xs font-medium border bg-gray-100 text-gray-600 hover:bg-gray-200"
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
