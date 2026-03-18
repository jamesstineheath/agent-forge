"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, GitPullRequest, Clock, Radio, Layers } from "lucide-react";
import { PipelineStages } from "@/components/pipeline-stages";
import { BlockedSummary } from "@/components/blocked-summary";
import { ATCEventLog } from "@/components/atc-event-log";
import { DebateStatsCard } from "@/components/debate-stats-card";
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

  const concurrencyMap = new Map<string, number>();
  for (const exec of activeExecutions) {
    concurrencyMap.set(exec.targetRepo, (concurrencyMap.get(exec.targetRepo) ?? 0) + 1);
  }

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Pipeline</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Work item flow &amp; ATC status
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              <Radio className={cn("h-3 w-3", activeExecutions.length > 0 ? "text-status-executing animate-status-pulse" : "text-muted-foreground/40")} />
              {activeExecutions.length} active
            </span>
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              <Layers className="h-3 w-3" />
              {queueItems.length} queued
            </span>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {/* ATC health strip */}
          <div className="flex flex-wrap items-center gap-2 md:gap-4 text-xs text-muted-foreground px-1">
            <div className="flex items-center gap-1.5">
              <div className={cn("w-2 h-2 rounded-full", atcState ? "bg-status-merged animate-status-pulse" : "bg-status-blocked")} />
              <span>ATC: {atcState ? "healthy" : "unknown"}</span>
              <span className="text-muted-foreground/40">
                &middot; last sweep {formatRelativeTime(atcState?.lastRunAt)}
              </span>
            </div>
            {repos && repos.length > 0 && (
              <div className="border-l border-border pl-4 flex items-center gap-1.5">
                {repos.map((repo) => (
                  <span key={repo.id} className="font-mono">
                    {concurrencyMap.get(repo.fullName) ?? 0}/{repo.concurrencyLimit} {repo.fullName}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Pipeline Stages */}
          {!itemsLoading && workItems && (
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Pipeline State
              </p>
              <PipelineStages workItems={workItems} />
            </div>
          )}

          {/* Blocked Summary */}
          {!itemsLoading && workItems && (
            <BlockedSummary workItems={workItems} />
          )}

          {/* Debate Reviews */}
          <DebateStatsCard />

          {/* Active Executions */}
          {(activeExecutions.length > 0 || activeWorkItems.length > 0) && (
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Active Executions
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeExecutions.map((exec) => {
                  const workItem = (workItems ?? []).find((i) => i.id === exec.workItemId);
                  return (
                    <div
                      key={exec.workItemId}
                      className="rounded-xl card-elevated bg-surface-1 p-3.5 ring-1 ring-status-executing/10"
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="h-2 w-2 rounded-full bg-status-executing animate-status-pulse flex-shrink-0" />
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-status-executing/10 text-status-executing border-status-executing/20 flex-shrink-0">
                          {exec.status}
                        </span>
                      </div>
                      {workItem ? (
                        <Link
                          href={`/work-items/${exec.workItemId}`}
                          className="text-[12px] font-medium text-foreground hover:text-primary line-clamp-2 transition-colors"
                        >
                          {workItem.title}
                        </Link>
                      ) : (
                        <span className="text-[12px] font-medium text-foreground font-mono">
                          {exec.workItemId.slice(0, 8)}
                        </span>
                      )}
                      <div className="text-[10px] text-muted-foreground/60 mt-1 truncate font-mono">{exec.targetRepo}</div>
                      <div className="flex flex-wrap items-center justify-between text-[10px] text-muted-foreground mt-2 gap-1">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {exec.elapsedMinutes}m elapsed
                        </span>
                        {workItem?.execution?.prUrl && (
                          <a
                            href={workItem.execution.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 font-mono"
                          >
                            <GitPullRequest className="h-2.5 w-2.5" />
                            #{workItem.execution.prNumber}
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
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Queue ({queueItems.length})
              </p>
              <div className="rounded-xl card-elevated bg-surface-1 p-3.5 divide-y divide-border">
                {queueItems.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between py-2 gap-1">
                    <Link
                      href={`/work-items/${item.id}`}
                      className="text-[12px] font-medium text-foreground hover:text-primary truncate transition-colors"
                    >
                      {item.title}
                    </Link>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      <span className={cn(
                        "text-[10px] font-bold px-1.5 py-0.5 rounded-full border",
                        item.priority === "high"
                          ? "bg-status-blocked/10 text-status-blocked border-status-blocked/20"
                          : item.priority === "medium"
                            ? "bg-status-executing/10 text-status-executing border-status-executing/20"
                            : "bg-secondary text-muted-foreground border-border"
                      )}>
                        {item.priority}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 font-mono">{item.targetRepo}</span>
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
              className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground transition-colors"
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
                <div className="text-xs text-muted-foreground/60">Loading...</div>
              ) : (
                <ATCEventLog events={events ?? []} />
              )
            )}
          </div>
        </div>
      </div>
    </>
  );
}
