"use client";

import type { Bug } from "@/lib/types";
import { AlertCircle, AlertTriangle, Bug as BugIcon, CheckCircle2 } from "lucide-react";

interface BugSummaryProps {
  bugs: Bug[];
}

const CLOSED_STATUSES = ["Fixed", "Won't Fix", "Wont Fix"];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function severityBadgeClass(severity: string): string {
  switch (severity?.toLowerCase()) {
    case "critical": return "bg-red-500/20 text-red-400 border border-red-500/30";
    case "high":     return "bg-amber-500/20 text-amber-400 border border-amber-500/30";
    case "medium":   return "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
    case "low":      return "bg-blue-500/20 text-blue-400 border border-blue-500/30";
    default:         return "bg-surface-2 text-muted-foreground border border-border";
  }
}

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function BugSummary({ bugs }: BugSummaryProps) {
  const openBugs = bugs.filter(b => !CLOSED_STATUSES.includes(b.status));
  const criticalCount = openBugs.filter(b => b.severity?.toLowerCase() === "critical").length;
  const highCount = openBugs.filter(b => b.severity?.toLowerCase() === "high").length;
  const fixedLast7d = bugs.filter(b => {
    const isFixed = b.status === "Fixed";
    const isRecent = Date.now() - new Date(b.created_time).getTime() < SEVEN_DAYS_MS;
    return isFixed && isRecent;
  }).length;

  const recentOpen = openBugs.slice(0, 10);

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* Critical */}
        <div className="rounded-xl card-elevated bg-surface-1 p-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={14} className="text-red-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Critical</span>
          </div>
          <span className="text-2xl font-bold tabular-nums text-red-400">{criticalCount}</span>
        </div>

        {/* High */}
        <div className="rounded-xl card-elevated bg-surface-1 p-4">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={14} className="text-amber-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">High</span>
          </div>
          <span className="text-2xl font-bold tabular-nums text-amber-400">{highCount}</span>
        </div>

        {/* Open total */}
        <div className="rounded-xl card-elevated bg-surface-1 p-4">
          <div className="flex items-center gap-2 mb-1">
            <BugIcon size={14} className="text-muted-foreground" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Open</span>
          </div>
          <span className="text-2xl font-bold tabular-nums text-foreground">{openBugs.length}</span>
        </div>

        {/* Fixed last 7d */}
        <div className="rounded-xl card-elevated bg-surface-1 p-4">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 size={14} className="text-green-500" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Fixed 7d</span>
          </div>
          <span className="text-2xl font-bold tabular-nums text-green-400">{fixedLast7d}</span>
        </div>
      </div>

      {/* Recent open bugs list */}
      {recentOpen.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60 py-2 text-center">No open bugs</p>
      ) : (
        <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-1">
          {recentOpen.map(bug => (
            <div
              key={bug.bug_id}
              className="flex items-center gap-2.5 text-sm py-1.5 min-w-0"
            >
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${severityBadgeClass(bug.severity)}`}>
                {bug.severity ?? "?"}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0 hidden sm:block font-mono">
                {bug.bug_id.slice(0, 8)}
              </span>
              <span className="truncate text-foreground flex-1">{bug.title}</span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0 font-mono">
                {relativeTime(bug.created_time)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
