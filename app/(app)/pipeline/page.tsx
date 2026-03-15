"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PipelineStages } from "@/components/pipeline-stages";
import { BlockedSummary } from "@/components/blocked-summary";
import { ATCEventLog } from "@/components/atc-event-log";
import { useATCState, useATCEvents, useWorkItems, useRepos } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

function formatRelativeTime(ts?: string): string {
  if (!ts) return "-";
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const ACTIVE_STATUSES: WorkItem["status"][] = ["generating", "executing", "reviewing"];

export default function PipelinePage() {
  const { data: atcState, isLoading: atcLoading } = useATCState();
  const { data: events, isLoading: eventsLoading } = useATCEvents(50);
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const { data: repos } = useRepos();

  const activeExecutions = atcState?.activeExecutions ?? [];
  const queueItems = (workItems ?? [])
    .filter((i) => i.status === "ready" || i.status === "queued")
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pd !== 0) return pd;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const activeWorkItems = (workItems ?? []).filter((i) => ACTIVE_STATUSES.includes(i.status));

  const [eventLogOpen, setEventLogOpen] = useState(false);

  // Build concurrency map
  const concurrencyMap = new Map<string, number>();
  for (const exec of activeExecutions) {
    concurrencyMap.set(exec.targetRepo, (concurrencyMap.get(exec.targetRepo) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      {/* Header + system health strip */}
      <div>
        <h1 className="text-lg font-semibold text-zinc-100 mb-1">Pipeline</h1>
        <div className="flex items-center gap-4 text-xs text-zinc-500 px-1 py-2">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>ATC: {atcState ? "healthy" : "unknown"}</span>
            <span className="text-zinc-700">
              &middot; last sweep {formatRelativeTime(atcState?.lastRunAt)}
            </span>
          </div>
          {repos && repos.length > 0 && (
            <div className="border-l border-zinc-800 pl-4 flex items-center gap-1.5">
              {repos.map((repo) => (
                <span key={repo.id}>
                  {concurrencyMap.get(repo.fullName) ?? 0}/{repo.concurrencyLimit} {repo.fullName}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Pipeline Stages */}
      {!itemsLoading && workItems && (
        <div className="space-y-4">
          <div className="text-sm text-zinc-400 mb-2">
            Current pipeline state across all repos
          </div>
          <PipelineStages workItems={workItems} />
        </div>
      )}

      {/* Blocked Summary */}
      {!itemsLoading && workItems && (
        <BlockedSummary workItems={workItems} />
      )}

      {/* Active Executions */}
      {(activeExecutions.length > 0 || activeWorkItems.length > 0) && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Active Executions
          </div>
          <div className="grid grid-cols-2 gap-3">
            {activeExecutions.map((exec) => {
              const workItem = (workItems ?? []).find((i) => i.id === exec.workItemId);
              return (
                <div
                  key={exec.workItemId}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-amber-400/10 text-amber-400 border-amber-400/20">
                      {exec.status}
                    </span>
                  </div>
                  {workItem ? (
                    <Link
                      href={`/work-items/${exec.workItemId}`}
                      className="text-sm font-medium text-zinc-200 hover:text-zinc-100 line-clamp-2"
                    >
                      {workItem.title}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-zinc-200 font-mono">
                      {exec.workItemId.slice(0, 8)}
                    </span>
                  )}
                  <div className="text-xs text-zinc-600 mt-1">{exec.targetRepo}</div>
                  <div className="flex items-center justify-between text-xs text-zinc-500 mt-2">
                    <span>{exec.elapsedMinutes}m elapsed</span>
                    {workItem?.execution?.prUrl && (
                      <a
                        href={workItem.execution.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400/70 hover:text-blue-400"
                      >
                        PR #{workItem.execution.prNumber}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Queue */}
      {queueItems.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Queue ({queueItems.length})
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            {queueItems.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-1.5">
                <Link
                  href={`/work-items/${item.id}`}
                  className="text-sm text-zinc-300 hover:text-zinc-100 truncate"
                >
                  {item.title}
                </Link>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                    item.priority === "high"
                      ? "bg-red-400/10 text-red-400 border-red-400/20"
                      : item.priority === "medium"
                        ? "bg-amber-400/10 text-amber-400 border-amber-400/20"
                        : "bg-zinc-400/10 text-zinc-500 border-zinc-400/20"
                  }`}>
                    {item.priority}
                  </span>
                  <span className="text-xs text-zinc-600">{item.targetRepo}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Event Log */}
      <div className="space-y-2">
        <button
          onClick={() => setEventLogOpen(!eventLogOpen)}
          className="flex items-center gap-2 text-xs font-medium text-zinc-500 uppercase tracking-wider hover:text-zinc-400 transition-colors"
        >
          {eventLogOpen ? (
            <ChevronDown size={14} />
          ) : (
            <ChevronRight size={14} />
          )}
          Event Log ({events?.length ?? 0} events)
        </button>
        {eventLogOpen && (
          eventsLoading ? (
            <div className="text-xs text-zinc-500">Loading...</div>
          ) : (
            <ATCEventLog events={events ?? []} />
          )
        )}
      </div>
    </div>
  );
}
