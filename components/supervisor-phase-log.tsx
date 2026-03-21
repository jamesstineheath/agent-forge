"use client";

import useSWR from "swr";
import type { PhaseExecutionLog, PhaseResult } from "@/lib/atc/supervisor-manifest";

const fetcher = (url: string) =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error("Request failed");
    return res.json();
  });

const tierColors: Record<string, string> = {
  critical: "text-red-800 bg-red-100 border-red-200",
  standard: "text-blue-800 bg-blue-100 border-blue-200",
  housekeeping: "text-gray-700 bg-gray-100 border-gray-200",
};

const statusColors: Record<string, string> = {
  success: "text-status-merged bg-status-merged/10",
  failure: "text-status-blocked bg-status-blocked/10",
  timeout: "text-status-blocked bg-status-blocked/10",
  skipped: "text-muted-foreground bg-muted",
  deferred: "text-yellow-800 bg-yellow-100",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SupervisorPhaseLog() {
  const { data, error, isLoading } = useSWR<{
    latest: PhaseExecutionLog | null;
    history: PhaseExecutionLog[];
  }>("/api/agents/supervisor-phases", fetcher, { refreshInterval: 30_000 });

  const latest = data?.latest ?? null;

  return (
    <div className="rounded-xl card-elevated bg-surface-1">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">
            Supervisor Phase Log
          </span>
          {latest && (
            <span className="text-[10px] text-muted-foreground">
              {new Date(latest.startedAt).toLocaleString()} &middot;{" "}
              {formatDuration(latest.totalDurationMs)}
            </span>
          )}
        </div>
      </div>
      <div className="p-4">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}
        {error && (
          <p className="text-sm text-status-blocked">
            Failed to load phase log.
          </p>
        )}
        {!isLoading && !error && !latest && (
          <p className="text-sm text-muted-foreground">
            No supervisor trace data yet. Will populate after next cycle.
          </p>
        )}
        {latest && (
          <div className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] text-muted-foreground/60 border-b border-border">
                    <th className="text-left py-1 pr-3 font-semibold uppercase tracking-wider">
                      Phase
                    </th>
                    <th className="text-left py-1 pr-3 font-semibold uppercase tracking-wider">
                      Tier
                    </th>
                    <th className="text-left py-1 pr-3 font-semibold uppercase tracking-wider">
                      Duration
                    </th>
                    <th className="text-left py-1 font-semibold uppercase tracking-wider">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {latest.phases.map((phase: PhaseResult) => (
                    <tr
                      key={phase.name}
                      className="border-b border-border last:border-0"
                    >
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {phase.name}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${tierColors[phase.tier] ?? tierColors.housekeeping}`}
                        >
                          {phase.tier}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-xs text-muted-foreground">
                        {formatDuration(phase.durationMs)}
                      </td>
                      <td className="py-1.5">
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusColors[phase.status] ?? ""}`}
                        >
                          {phase.status}
                        </span>
                        {phase.errors && phase.errors.length > 0 && (
                          <span
                            className="ml-1 text-[10px] text-status-blocked truncate max-w-32"
                            title={phase.errors[0]}
                          >
                            {phase.errors[0].slice(0, 40)}
                            {phase.errors[0].length > 40 ? "\u2026" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {latest.deferredPhases.length > 0 && (
              <div className="mt-3 p-2 bg-yellow-50 dark:bg-yellow-950/20 rounded text-xs">
                <span className="font-medium text-yellow-800 dark:text-yellow-200">
                  Deferred:{" "}
                </span>
                <span className="text-yellow-700 dark:text-yellow-300">
                  {latest.deferredPhases.join(", ")}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
