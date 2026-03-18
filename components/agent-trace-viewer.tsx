"use client";

import React, { useState, useMemo } from "react";
import { useAgentTraces, AgentTraceRecord } from "@/lib/hooks";
import { AgentTraceDetail } from "./agent-trace-detail";

const AGENT_FILTERS = ["All", "dispatcher", "health-monitor", "project-manager", "supervisor"];

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  dispatcher: "Dispatcher",
  "health-monitor": "Health Monitor",
  "project-manager": "Project Manager",
  supervisor: "Supervisor",
};

function formatDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function AgentTraceViewer() {
  const { traces, isLoading, error } = useAgentTraces();
  const [filterAgent, setFilterAgent] = useState<string>("All");
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedTraceIdx, setSelectedTraceIdx] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const result =
      filterAgent === "All"
        ? traces
        : traces.filter((t) => t.agent === filterAgent);
    return [...result].sort((a, b) => {
      const diff =
        new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      return sortDesc ? -diff : diff;
    });
  }, [traces, filterAgent, sortDesc]);

  if (error) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <p className="text-sm text-muted-foreground/60">
          Failed to load agent traces. Will retry automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Agent Traces
          </p>
          <span className="text-[10px] text-muted-foreground/40">
            (auto-refreshes every 30s)
          </span>
        </div>
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-1.5">
        {AGENT_FILTERS.map((name) => (
          <button
            key={name}
            onClick={() => {
              setFilterAgent(name);
              setSelectedTraceIdx(null);
            }}
            className={`rounded-full px-3 py-1 text-[10px] font-semibold transition-colors ${
              filterAgent === name
                ? "bg-foreground text-background"
                : "bg-surface-2 text-muted-foreground ring-1 ring-border hover:bg-surface-2/80"
            }`}
          >
            {name === "All" ? "All" : (AGENT_DISPLAY_NAMES[name] ?? name)}
          </button>
        ))}
        <button
          onClick={() => setSortDesc((d) => !d)}
          className="ml-auto rounded-full px-3 py-1 text-[10px] font-semibold bg-surface-2 text-muted-foreground ring-1 ring-border hover:bg-surface-2/80"
        >
          {sortDesc ? "↓ Newest first" : "↑ Oldest first"}
        </button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="rounded-xl card-elevated bg-surface-1 p-6 animate-pulse">
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 bg-muted rounded" />
            ))}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl card-elevated bg-surface-1 p-6 text-center">
          <p className="text-sm text-muted-foreground/60">
            No traces recorded yet
            {filterAgent !== "All"
              ? ` for ${AGENT_DISPLAY_NAMES[filterAgent] ?? filterAgent}`
              : ""}
            .
          </p>
        </div>
      ) : (
        <div className="rounded-xl card-elevated bg-surface-1 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  <th className="px-4 py-2.5">Timestamp</th>
                  <th className="px-4 py-2.5">Agent</th>
                  <th className="px-4 py-2.5">Duration</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Decisions</th>
                  <th className="px-4 py-2.5">Phases</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((trace, idx) => (
                  <React.Fragment key={`${trace.agent}-${trace.startedAt}`}>
                    <tr
                      onClick={() =>
                        setSelectedTraceIdx(
                          selectedTraceIdx === idx ? null : idx
                        )
                      }
                      className={`cursor-pointer border-b border-border transition-colors hover:bg-surface-2/50 ${
                        selectedTraceIdx === idx ? "bg-surface-2/30" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                        {formatTimestamp(trace.startedAt)}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-foreground">
                        {AGENT_DISPLAY_NAMES[trace.agent] ?? trace.agent}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                        {formatDuration(trace.durationMs)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                            trace.status === "success"
                              ? "text-status-merged bg-status-merged/10 border-status-merged/30"
                              : trace.status === "error"
                                ? "text-status-blocked bg-status-blocked/10 border-status-blocked/30"
                                : "text-muted-foreground bg-muted border-border"
                          }`}
                        >
                          {trace.status ?? "unknown"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                        {trace.decisions.length}
                      </td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">
                        {trace.phases.length}
                      </td>
                    </tr>
                    {selectedTraceIdx === idx && (
                      <tr>
                        <td colSpan={6} className="bg-surface-2/20 px-4 py-3">
                          <AgentTraceDetail trace={trace} />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
