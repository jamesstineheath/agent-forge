"use client";

import { cn } from "@/lib/utils";
import {
  Plane,
  AlertTriangle,
  Timer,
  GitBranch,
  RotateCcw,
  ParkingCircle,
  Layers,
  Shield,
  Trash2,
  Activity,
  Radio,
  Clock,
} from "lucide-react";
import type { ATCEvent, ATCState } from "@/lib/types";
import { useATCStatePanel } from "@/lib/hooks";

type ATCStateWithEvents = ATCState & { recentEvents: ATCEvent[] };

function formatRelativeTime(ts?: string): string {
  if (!ts) return "\u2014";
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isHealthy(state: ATCStateWithEvents): boolean {
  if (!state.lastRunAt) return false;
  const ms = Date.now() - new Date(state.lastRunAt).getTime();
  return ms < 10 * 60 * 1000;
}

function EventTypeIcon({ type }: { type: ATCEvent["type"] }) {
  const cls = "shrink-0";
  switch (type) {
    case "auto_dispatch":
      return <Plane size={12} className={`text-status-executing ${cls}`} />;
    case "conflict":
    case "concurrency_block":
      return <AlertTriangle size={12} className={`text-status-reviewing ${cls}`} />;
    case "timeout":
      return <Timer size={12} className={`text-status-blocked ${cls}`} />;
    case "retry":
      return <RotateCcw size={12} className={`text-status-reviewing ${cls}`} />;
    case "parked":
      return <ParkingCircle size={12} className={`text-muted-foreground ${cls}`} />;
    case "cleanup":
      return <Trash2 size={12} className={`text-muted-foreground/60 ${cls}`} />;
    case "project_trigger":
    case "project_completion":
      return <Layers size={12} className={`text-primary ${cls}`} />;
    case "escalation_resolved":
      return <Shield size={12} className={`text-status-merged ${cls}`} />;
    case "escalation":
    case "escalation_timeout":
      return <AlertTriangle size={12} className={`text-status-blocked ${cls}`} />;
    default:
      return <GitBranch size={12} className={`text-muted-foreground/60 ${cls}`} />;
  }
}

export function ATCMetricsPanel() {
  const { data, isLoading, error } = useATCStatePanel();

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4 animate-pulse">
        <div className="h-4 w-48 bg-muted rounded mb-3" />
        <div className="h-3 w-32 bg-muted rounded mb-4" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-3 w-full bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity size={14} className="text-muted-foreground/60" />
          <span>ATC Metrics</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-secondary text-muted-foreground border-border">
            unavailable
          </span>
        </div>
        <p className="text-xs text-muted-foreground/60 mt-2">
          Unable to load ATC state. The cron may not have run yet.
        </p>
      </div>
    );
  }

  const healthy = isHealthy(data);
  const activeCount = data.activeExecutions?.length ?? 0;
  const queuedCount = data.queuedItems ?? 0;
  const events = (data.recentEvents ?? []).slice(-10);

  return (
    <div className="rounded-xl card-elevated overflow-hidden bg-surface-1">
      {/* Health Indicator + Last Run */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-2 sm:gap-3 border-b border-border">
        <div
          className={cn(
            "h-2.5 w-2.5 rounded-full shrink-0",
            healthy ? "bg-status-merged animate-status-pulse" : "bg-status-blocked"
          )}
        />
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-foreground" />
          <span className="text-sm font-display font-bold text-foreground">
            ATC Performance
          </span>
        </div>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full border font-semibold",
            healthy
              ? "bg-status-merged/10 text-status-merged border-status-merged/20"
              : "bg-status-blocked/10 text-status-blocked border-status-blocked/20"
          )}
        >
          {healthy ? "healthy" : "stale"}
        </span>
        <span className="text-xs text-muted-foreground sm:ml-auto flex items-center gap-1">
          <Clock size={10} />
          Last sweep {formatRelativeTime(data.lastRunAt)}
        </span>
      </div>

      {/* Queue Depth + Active Executions */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-4 sm:gap-6 border-b border-border">
        <div className="flex items-center gap-2">
          <Radio
            size={12}
            className={cn(activeCount > 0 ? "text-status-executing animate-status-pulse" : "text-muted-foreground/40")}
          />
          <span className="text-xs text-muted-foreground">
            <span className="font-mono font-bold text-foreground">
              {activeCount}
            </span>{" "}
            active execution{activeCount !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Layers size={12} className="text-muted-foreground/60" />
          <span className="text-xs text-muted-foreground">
            <span className="font-mono font-bold text-foreground">
              {queuedCount}
            </span>{" "}
            queued
          </span>
        </div>
      </div>

      {/* Active Execution Details */}
      {activeCount > 0 && (
        <div className="px-4 py-2 border-b border-border">
          <div className="space-y-1">
            {data.activeExecutions.map((exec) => (
              <div
                key={exec.workItemId}
                className="flex items-center gap-2 text-xs"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-status-executing animate-status-pulse" />
                <span className="text-foreground font-mono">
                  {exec.workItemId.slice(0, 8)}
                </span>
                <span className="text-muted-foreground">{exec.targetRepo}</span>
                <span className="text-muted-foreground/60 ml-auto">
                  {exec.elapsedMinutes}m elapsed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Events Timeline */}
      {events.length > 0 ? (
        <div className="px-4 py-3">
          <div className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-2">
            Recent Events
          </div>
          <div className="space-y-1.5">
            {events
              .slice()
              .reverse()
              .map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-2 text-xs"
                >
                  <EventTypeIcon type={event.type} />
                  <span className="text-muted-foreground truncate flex-1">
                    {event.details}
                  </span>
                  <span className="text-muted-foreground/50 shrink-0 text-[10px]">
                    {formatRelativeTime(event.timestamp)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      ) : (
        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground/60">No recent events recorded.</p>
        </div>
      )}
    </div>
  );
}
