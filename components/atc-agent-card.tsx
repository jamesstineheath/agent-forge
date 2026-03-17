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
      return <Plane size={10} className={`text-blue-400 ${cls}`} />;
    case "conflict":
      return <AlertTriangle size={10} className={`text-amber-400 ${cls}`} />;
    case "timeout":
      return <Timer size={10} className={`text-red-400 ${cls}`} />;
    case "retry":
      return <RotateCcw size={10} className={`text-amber-400 ${cls}`} />;
    case "parked":
      return <ParkingCircle size={10} className={`text-zinc-400 ${cls}`} />;
    case "cleanup":
      return <Trash2 size={10} className={`text-zinc-500 ${cls}`} />;
    case "project_trigger":
      return <Layers size={10} className={`text-purple-400 ${cls}`} />;
    case "escalation_resolved":
      return <Shield size={10} className={`text-emerald-400 ${cls}`} />;
    default:
      return <GitBranch size={10} className={`text-zinc-500 ${cls}`} />;
  }
}

function MetricPill({ label, value, color }: { label: string; value: number; color?: string }) {
  if (value === 0) return null;
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={`font-mono font-medium ${color ?? "text-zinc-300"}`}>{value}</span>
      <span className="text-zinc-500">{label}</span>
    </div>
  );
}

export function ATCAgentCard({ metrics, isLoading, error }: ATCAgentCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 bg-zinc-800 rounded-full" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 bg-zinc-800 rounded" />
            <div className="h-3 w-56 bg-zinc-800 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <div className="flex items-center gap-3">
          <Plane size={16} className="text-zinc-500" />
          <span className="text-sm font-medium text-zinc-300">Air Traffic Controller</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-zinc-400/10 text-zinc-500 border-zinc-500/20">
            no data
          </span>
        </div>
        <p className="text-xs text-zinc-500 mt-2">
          Unable to load ATC metrics. The cron may not have run yet.
        </p>
      </div>
    );
  }

  const isHealthy = metrics.lastRunAt !== null;
  const hasActivity = metrics.totalEvents > 0;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 flex items-center gap-4 hover:bg-zinc-800/50 transition-colors"
      >
        <QualityRing rate={metrics.dispatchSuccessRate} size={48} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <Plane size={14} className="text-blue-400" />
            <span className="font-medium text-zinc-100 text-sm">Air Traffic Controller</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                isHealthy
                  ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                  : "bg-zinc-400/10 text-zinc-500 border-zinc-500/20"
              }`}
            >
              {isHealthy ? "active" : "unknown"}
            </span>
          </div>
          <div className="text-xs text-zinc-500">
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
          <ChevronDown size={16} className="text-zinc-500" />
        ) : (
          <ChevronRight size={16} className="text-zinc-500" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-zinc-800">
          {/* Live status */}
          <div className="px-4 py-3 border-b border-zinc-800/50">
            <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
              Live Status
            </div>
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${metrics.activeExecutionCount > 0 ? "bg-amber-400 animate-pulse" : "bg-zinc-600"}`} />
                <span className="text-xs text-zinc-400">
                  {metrics.activeExecutionCount} active
                </span>
              </div>
              <div className="text-xs text-zinc-400">
                {metrics.queueDepth} queued
              </div>
            </div>
          </div>

          {/* Performance metrics */}
          <div className="px-4 py-3 border-b border-zinc-800/50">
            <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
              Performance (last {metrics.totalEvents} events)
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              <MetricPill label="dispatched" value={metrics.totalDispatches} color="text-blue-400" />
              <MetricPill label="conflicts blocked" value={metrics.conflictsDetected} color="text-amber-400" />
              <MetricPill label="timeouts caught" value={metrics.timeoutsDetected} color="text-red-400" />
              <MetricPill label="retries triggered" value={metrics.retriesTriggered} color="text-amber-400" />
              <MetricPill label="parked" value={metrics.itemsParked} color="text-zinc-400" />
              <MetricPill label="auto-cancelled" value={metrics.autoCancellations} color="text-red-400" />
              <MetricPill label="projects decomposed" value={metrics.projectsDecomposed} color="text-purple-400" />
              <MetricPill label="projects failed" value={metrics.projectsFailed} color="text-red-400" />
              <MetricPill label="escalations resolved" value={metrics.escalationsResolved} color="text-emerald-400" />
              <MetricPill label="escalations timed out" value={metrics.escalationsTimedOut} color="text-red-400" />
              <MetricPill label="dep blocks detected" value={metrics.dependencyBlocks} color="text-amber-400" />
              <MetricPill label="branches cleaned" value={metrics.branchesCleanedUp} color="text-zinc-500" />
            </div>
            {metrics.totalDispatches === 0 && metrics.conflictsDetected === 0 && metrics.timeoutsDetected === 0 && (
              <div className="text-xs text-zinc-600 mt-1">No dispatch activity yet.</div>
            )}
          </div>

          {/* Event type breakdown */}
          {Object.keys(metrics.eventBreakdown).length > 0 && (
            <div className="px-4 py-3 border-b border-zinc-800/50">
              <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
                Event Breakdown
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(metrics.eventBreakdown)
                  .sort(([, a], [, b]) => b - a)
                  .map(([type, count]) => (
                    <span
                      key={type}
                      className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 font-mono"
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
              <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-2">
                Recent Events
              </div>
              <div className="space-y-1">
                {metrics.recentEvents
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div key={event.id} className="flex items-start gap-2 text-xs">
                      <EventTypeIcon type={event.type} />
                      <span className="text-zinc-400 truncate flex-1">{event.details}</span>
                      <span className="text-zinc-600 shrink-0 text-[10px]">
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
