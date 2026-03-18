"use client";

import { useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { GitPullRequest, Clock, Radio, Layers } from "lucide-react";
import { PipelineStages } from "@/components/pipeline-stages";
import { BlockedSummary } from "@/components/blocked-summary";
import { DebateStatsCard } from "@/components/debate-stats-card";
import { useWorkItems, useRepos } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = ["generating", "executing", "reviewing"];

export default function PipelinePage() {
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const { data: repos } = useRepos();

  const queueItems = (workItems ?? [])
    .filter((i) => i.status === "ready" || i.status === "queued")
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pd !== 0) return pd;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const activeWorkItems = (workItems ?? []).filter((i) => ACTIVE_STATUSES.includes(i.status));

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Pipeline</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Work item flow &amp; execution status
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              <Radio className={cn("h-3 w-3", activeWorkItems.length > 0 ? "text-status-executing animate-status-pulse" : "text-muted-foreground/40")} />
              {activeWorkItems.length} active
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
          {activeWorkItems.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Active Executions
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeWorkItems.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl card-elevated bg-surface-1 p-3.5 ring-1 ring-status-executing/10"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="h-2 w-2 rounded-full bg-status-executing animate-status-pulse flex-shrink-0" />
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-status-executing/10 text-status-executing border-status-executing/20 flex-shrink-0">
                        {item.status}
                      </span>
                    </div>
                    <Link
                      href={`/work-items/${item.id}`}
                      className="text-[12px] font-medium text-foreground hover:text-primary line-clamp-2 transition-colors"
                    >
                      {item.title}
                    </Link>
                    <div className="text-[10px] text-muted-foreground/60 mt-1 truncate font-mono">{item.targetRepo}</div>
                    <div className="flex flex-wrap items-center justify-between text-[10px] text-muted-foreground mt-2 gap-1">
                      {item.execution?.startedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          started {new Date(item.execution.startedAt).toLocaleString()}
                        </span>
                      )}
                      {item.execution?.prUrl && (
                        <a
                          href={item.execution.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 font-mono"
                        >
                          <GitPullRequest className="h-2.5 w-2.5" />
                          #{item.execution.prNumber}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
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
        </div>
      </div>
    </>
  );
}
