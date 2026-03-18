"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plane,
  AlertTriangle,
  Timer,
  GitBranch,
  RotateCcw,
  ParkingCircle,
  Layers,
  Shield,
  Trash2,
} from "lucide-react";
import { QualityRing } from "@/components/quality-ring";
import type { ATCMetrics } from "@/app/api/agents/atc-metrics/route";
import type { ATCEvent } from "@/lib/types";

interface ATCAgentCardProps {
  metrics: ATCMetrics | null;
  isLoading: boolean;
  error: Error | undefined;
}

function formatRelativeTime(ts: string | null): string {
  if (!ts) return "never";
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function EventTypeIcon({ type }: { type: ATCEvent["type"] }) {
  const cls = "shrink-0";
  switch (type) {
    case "auto_dispatch":
      return <Plane size={10} className={`text-status-reviewing ${cls}`} />;
    case "conflict":
      return <AlertTriangle size={10} className={`text-status-executing ${cls}`} />;
    case "timeout":
      return <Timer size={10} className={`text-status-blocked ${cls}`} />;
    case "retry":
      return <RotateCcw size={10} className={`text-status-executing ${cls}`} />;
    case "parked":
      return <ParkingCircle size={10} className={`text-muted-foreground ${cls}`} />;
    case "cleanup":
      return <Trash2 size={10} className={`text-muted-foreground/60 ${cls}`} />;
    case "project_trigger":
      return <Layers size={10} className={`text-primary ${cls}`} />;
    case "escalation_resolved":
      return <Shield size={10} className={`text-status-merged ${cls}`} />;
    default:
      return <GitBranch size={10} className={`text-muted-foreground/60 ${cls}`} />;
  }
}

function MetricPill({ label, value, color }: { label: string; value: number; color?: string }) {
  if (value === 0) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={`font-mono font-medium ${color ?? "text-foreground"}`}>{value}</span>
      <span className="text-muted-foreground/60">{label}</span>
    </div>
  );
}

export function ATCAgentCard({ metrics, isLoading, error }: ATCAgentCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-surface-1 p-4 animate-pulse">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 bg-muted rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 bg-muted rounded" />
            <div className="h-3 w-56 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="rounded-xl border border-border bg-surface-1 p-4">
        <div className="flex items-center gap-3">
          <Plane size={16} className="text-muted-foreground/60" />
          <span className="text-sm font-medium text-foreground">Air Traffic Controller</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-muted text-muted-foreground/60 border-border">
            no data
          </span>
        </div>
        <p className="text-xs text-muted-foreground/60 mt-2">
          Unable to load ATC metrics. The cron may not have run yet.
        </p>
      </div>
    );
  }

  const isHealthy = metrics.lastRunAt !== null;
  const hasActivity = metrics.totalEvents > 0;

  return (
    <div className="rounded-xl border border-border bg-surface-1 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 flex items-center gap-4 hover:bg-accent/50 transition-colors"
      >
        <QualityRing rate={metrics.dispatchSuccessRate} size={48} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <Plane size={14} className="text-status-reviewing" />
            <span className="font-medium text-foreground text-sm">Air Traffic Controller</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                isHealthy
                  ? "bg-status-merged/10 text-status-merged border-status-merged/20"
                  : "bg-muted text-muted-foreground/60 border-border"
              }`}
            >
              {isHealthy ? "active" : "unknown"}
            </span>
          </div>
          <div className="text-xs text-muted-foreground/60">
            {hasActivity ? (
              <span>
                {metrics.totalDispatches} dispatched &middot;{" "}
                {metrics.conflictsDetected} conflicts &middot;{" "}
                {metrics.timeoutsDetected} timeouts &middot;{" "}
                last sweep {formatRelativeTime(metrics.lastRunAt)}
              </span>
            ) : (
              <span>
                No events recorded yet &middot; last sweep {formatRelativeTime(metrics.lastRunAt)}
              </span>
            )}
          </div>
        </div>
        {expanded ? (
          <ChevronDown size={16} className="text-muted-foreground/60" />
        ) : (
          <ChevronRight size={16} className="text-muted-foreground/60" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border">
          {/* Live status */}
          <div className="px-4 py-3 border-b border-border">
            <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2">
              Live Status
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${metrics.activeExecutionCount > 0 ? "bg-status-executing animate-pulse" : "bg-muted-foreground/40"}`} />
                <span className="text-xs text-muted-foreground">
                  {metrics.activeExecutionCount} active
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {metrics.queueDepth} queued
              </div>
            </div>
          </div>

          {/* Performance metrics */}
          <div className="px-4 py-3 border-b border-border">
            <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2">
              Performance (last {metrics.totalEvents} events)
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              <MetricPill label="dispatched" value={metrics.totalDispatches} color="text-status-reviewing" />
              <MetricPill label="conflicts blocked" value={metrics.conflictsDetected} color="text-status-executing" />
              <MetricPill label="timeouts caught" value={metrics.timeoutsDetected} color="text-status-blocked" />
              <MetricPill label="retries triggered" value={metrics.retriesTriggered} color="text-status-executing" />
              <MetricPill label="parked" value={metrics.itemsParked} color="text-muted-foreground" />
              <MetricPill label="auto-cancelled" value={metrics.autoCancellations} color="text-status-blocked" />
              <MetricPill label="projects decomposed" value={metrics.projectsDecomposed} color="text-primary" />
              <MetricPill label="projects failed" value={metrics.projectsFailed} color="text-status-blocked" />
              <MetricPill label="escalations resolved" value={metrics.escalationsResolved} color="text-status-merged" />
              <MetricPill label="escalations timed out" value={metrics.escalationsTimedOut} color="text-status-blocked" />
              <MetricPill label="dep blocks detected" value={metrics.dependencyBlocks} color="text-status-executing" />
              <MetricPill label="branches cleaned" value={metrics.branchesCleanedUp} color="text-muted-foreground/60" />
            </div>
            {metrics.totalDispatches === 0 && metrics.conflictsDetected === 0 && metrics.timeoutsDetected === 0 && (
              <div className="text-xs text-muted-foreground/50 mt-1">No dispatch activity yet.</div>
            )}
          </div>

          {/* Event type breakdown */}
          {Object.keys(metrics.eventBreakdown).length > 0 && (
            <div className="px-4 py-3 border-b border-border">
              <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2">
                Event Breakdown
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(metrics.eventBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => (
                    <span
                      key={type}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-mono"
                    >
                      {type.replace(/_/g, " ")} ({count})
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Recent events */}
          {metrics.recentEvents.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-2">
                Recent Events
              </div>
              <div className="space-y-1">
                {metrics.recentEvents
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div key={event.id} className="flex items-start gap-2 text-xs">
                      <EventTypeIcon type={event.type} />
                      <span className="text-muted-foreground truncate flex-1">{event.details}</span>
                      <span className="text-muted-foreground/50 shrink-0 text-[10px]">
                        {formatRelativeTime(event.timestamp)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
