"use client";

import { cn } from "@/lib/utils";
import { useAgentDashboard, useAgentHeartbeats } from "@/lib/hooks";
import type { AgentHeartbeat } from "@/lib/atc/types";
import {
  Activity,
  Clock,
  GitBranch,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { AgentHealthInfo, HealthStatus } from "@/lib/agent-dashboard";

const healthColor: Record<HealthStatus, string> = {
  healthy: "text-status-merged bg-status-merged/10 border-status-merged/30",
  stale: "text-status-reviewing bg-status-reviewing/10 border-status-reviewing/30",
  error: "text-status-blocked bg-status-blocked/10 border-status-blocked/30",
};

const healthDot: Record<HealthStatus, string> = {
  healthy: "bg-status-merged",
  stale: "bg-status-reviewing",
  error: "bg-status-blocked",
};

const healthLabel: Record<HealthStatus, string> = {
  healthy: "Healthy",
  stale: "Stale",
  error: "Error",
};

function HealthBadge({ status }: { status: HealthStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold",
        healthColor[status]
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", healthDot[status])} />
      {healthLabel[status]}
    </span>
  );
}

function RunHistoryDots({ history }: { history: AgentHealthInfo["runHistory"] }) {
  if (history.length === 0) {
    return <span className="text-[10px] text-muted-foreground/40">no runs</span>;
  }
  return (
    <div className="flex items-center gap-0.5">
      {history.map((run, i) => (
        <div
          key={i}
          title={`${run.startedAt} — ${run.status}${run.durationMs ? ` (${(run.durationMs / 1000).toFixed(1)}s)` : ""}`}
          className={cn(
            "h-2.5 w-2.5 rounded-sm",
            run.status === "success" ? "bg-status-merged/70" : "bg-status-blocked/70"
          )}
        />
      ))}
    </div>
  );
}

function timeAgo(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatHeartbeatSummary(agent: AgentHealthInfo, heartbeat: AgentHeartbeat | undefined): string {
  if (heartbeat?.notes && heartbeat.lastRunAt) {
    return heartbeat.notes;
  }
  // Fallback to trace-based metrics
  return `${agent.metrics.successCount}/${agent.metrics.totalRuns} runs succeeded`;
}

function AgentRow({ agent, heartbeat }: { agent: AgentHealthInfo; heartbeat?: AgentHeartbeat }) {
  const lastRunAt = heartbeat?.lastRunAt || agent.lastRunAt;
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {agent.displayName}
          </span>
          <HealthBadge status={agent.health} />
          <span className="text-[10px] text-muted-foreground/50">
            {agent.cadence}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[11px] text-muted-foreground">
            {lastRunAt ? `Last run ${timeAgo(lastRunAt)}` : "Never run"}
          </span>
          <span className="text-[10px] text-muted-foreground/40">|</span>
          <span className="text-[11px] text-muted-foreground">
            {formatHeartbeatSummary(agent, heartbeat)}
          </span>
          {agent.metrics.avgDurationMs > 0 && (
            <>
              <span className="text-[10px] text-muted-foreground/40">|</span>
              <span className="text-[11px] text-muted-foreground">
                avg {(agent.metrics.avgDurationMs / 1000).toFixed(1)}s
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">
        <RunHistoryDots history={agent.runHistory} />
      </div>
    </div>
  );
}

export function AgentDashboard() {
  const { data, isLoading, error } = useAgentDashboard();
  const { heartbeats } = useAgentHeartbeats();
  const getHeartbeat = (name: string) => heartbeats.find((h) => h.agentName === name);

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-6 animate-pulse">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-4 w-4 bg-muted rounded" />
          <div className="h-5 w-40 bg-muted rounded" />
        </div>
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <p className="text-sm text-muted-foreground/60">
          Unable to load agent dashboard data. The API may be unavailable.
        </p>
      </div>
    );
  }

  const healthyCount = data.agents.filter((a) => a.health === "healthy").length;
  const staleCount = data.agents.filter((a) => a.health === "stale").length;
  const errorCount = data.agents.filter((a) => a.health === "error").length;

  return (
    <div className="space-y-3">
      {/* Summary stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg bg-surface-1 border border-border px-3 py-2">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Activity className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Agent Health
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {healthyCount > 0 && (
              <span className="flex items-center gap-1 text-status-merged">
                <CheckCircle2 className="h-3 w-3" />
                {healthyCount}
              </span>
            )}
            {staleCount > 0 && (
              <span className="flex items-center gap-1 text-status-reviewing">
                <AlertTriangle className="h-3 w-3" />
                {staleCount}
              </span>
            )}
            {errorCount > 0 && (
              <span className="flex items-center gap-1 text-status-blocked">
                <XCircle className="h-3 w-3" />
                {errorCount}
              </span>
            )}
            {healthyCount === 0 && staleCount === 0 && errorCount === 0 && (
              <span className="text-muted-foreground/40">no data</span>
            )}
          </div>
        </div>

        <div className="rounded-lg bg-surface-1 border border-border px-3 py-2">
          <div className="flex items-center gap-1.5 mb-0.5">
            <Clock className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Events
            </span>
          </div>
          <div className="text-xs text-foreground">
            <span className="font-medium">{data.eventBusStats.eventsLastHour}</span>
            <span className="text-muted-foreground"> last hr</span>
            <span className="text-muted-foreground/40 mx-1">·</span>
            <span className="font-medium">{data.eventBusStats.eventsLast24h}</span>
            <span className="text-muted-foreground"> 24h</span>
          </div>
        </div>

        <div className="rounded-lg bg-surface-1 border border-border px-3 py-2">
          <div className="flex items-center gap-1.5 mb-0.5">
            <CheckCircle2 className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Throughput
            </span>
          </div>
          <div className="text-xs text-foreground">
            <span className="font-medium">{data.pipelineThroughput.completedToday}</span>
            <span className="text-muted-foreground"> today</span>
            <span className="text-muted-foreground/40 mx-1">·</span>
            <span className="font-medium">{data.pipelineThroughput.completedThisWeek}</span>
            <span className="text-muted-foreground"> this week</span>
          </div>
        </div>

        <div className="rounded-lg bg-surface-1 border border-border px-3 py-2">
          <div className="flex items-center gap-1.5 mb-0.5">
            <GitBranch className="h-3 w-3 text-muted-foreground/60" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Active
            </span>
          </div>
          {data.activeExecutions.length > 0 ? (
            <div className="text-xs">
              <span className="font-medium text-foreground">
                {data.activeExecutions.length}
              </span>
              <span className="text-muted-foreground"> execution{data.activeExecutions.length !== 1 ? "s" : ""}</span>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground/50 flex items-center gap-1">
              <Loader2 className="h-3 w-3" />
              idle
            </div>
          )}
        </div>
      </div>

      {/* Active executions detail */}
      {data.activeExecutions.length > 0 && (
        <div className="rounded-lg bg-surface-1 border border-border px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            Active Branches
          </span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {data.activeExecutions.map((exec) => (
              <span
                key={exec.workItemId}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-2 text-[10px] font-mono text-muted-foreground ring-1 ring-border"
              >
                <GitBranch className="h-2.5 w-2.5" />
                {exec.branch}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Agent list */}
      <div className="rounded-xl card-elevated bg-surface-1 divide-y divide-border">
        {data.agents.map((agent) => (
          <AgentRow key={agent.name} agent={agent} heartbeat={getHeartbeat(agent.name)} />
        ))}
      </div>
    </div>
  );
}
