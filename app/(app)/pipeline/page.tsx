"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConcurrencyGauge } from "@/components/concurrency-gauge";
import { ATCEventLog } from "@/components/atc-event-log";
import { useATCState, useATCEvents, useWorkItems, useRepos } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  generating: "bg-yellow-100 text-yellow-700",
  executing: "bg-amber-100 text-amber-700",
  reviewing: "bg-purple-100 text-purple-700",
  merged: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  parked: "bg-slate-100 text-slate-600",
  ready: "bg-blue-100 text-blue-700",
  queued: "bg-sky-100 text-sky-700",
};

const PRIORITY_COLORS: Record<WorkItem["priority"], string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-slate-100 text-slate-600",
};

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "-";
  const ms = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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

  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeExecutions = atcState?.activeExecutions ?? [];
  const queueItems = (workItems ?? [])
    .filter((i) => i.status === "ready" || i.status === "queued")
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pd !== 0) return pd;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  // Build concurrency map from ATC state
  const concurrencyMap = new Map<string, number>();
  for (const exec of activeExecutions) {
    concurrencyMap.set(exec.targetRepo, (concurrencyMap.get(exec.targetRepo) ?? 0) + 1);
  }

  // Also count active work items not tracked in ATC state yet
  const activeWorkItems = (workItems ?? []).filter((i) => ACTIVE_STATUSES.includes(i.status));

  const isLoading = atcLoading || itemsLoading;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? "Loading..."
            : `${activeExecutions.length} active · ${queueItems.length} queued · ATC last run ${formatRelativeTime(atcState?.lastRunAt)}`}
        </p>
      </div>

      {/* Section 1: Active Executions + Concurrency */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Active Executions</h2>

        {/* Concurrency gauges */}
        {repos && repos.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Concurrency by Repo
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {repos.map((repo) => (
                  <ConcurrencyGauge
                    key={repo.id}
                    repoName={repo.fullName}
                    active={concurrencyMap.get(repo.fullName) ?? 0}
                    limit={repo.concurrencyLimit}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Active execution cards */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : activeExecutions.length === 0 && activeWorkItems.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No active executions.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeExecutions.map((exec) => {
              const workItem = (workItems ?? []).find((i) => i.id === exec.workItemId);
              const isExpanded = expandedItems.has(exec.workItemId);
              return (
                <Card key={exec.workItemId} className="hover:shadow-md transition-shadow">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                      <Badge className={STATUS_COLORS[exec.status] ?? ""}>
                        {exec.status}
                      </Badge>
                    </div>
                    {workItem ? (
                      <Link href={`/work-items/${exec.workItemId}`}>
                        <CardTitle className="text-sm font-semibold line-clamp-2 mt-1 hover:underline">
                          {workItem.title}
                        </CardTitle>
                      </Link>
                    ) : (
                      <CardTitle className="text-sm font-semibold line-clamp-2 mt-1 font-mono">
                        {exec.workItemId.slice(0, 8)}
                      </CardTitle>
                    )}
                    <p className="text-xs text-muted-foreground">{exec.targetRepo}</p>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Elapsed: {exec.elapsedMinutes}m</span>
                      {workItem?.execution?.prUrl && (
                        <a
                          href={workItem.execution.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          PR #{workItem.execution.prNumber}
                        </a>
                      )}
                    </div>
                    {exec.filesBeingModified.length > 0 && (
                      <div>
                        <button
                          onClick={() => toggleExpanded(exec.workItemId)}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          {isExpanded ? "▾" : "▸"} {exec.filesBeingModified.length} file
                          {exec.filesBeingModified.length !== 1 ? "s" : ""}
                        </button>
                        {isExpanded && (
                          <ul className="mt-1 space-y-0.5 pl-3">
                            {exec.filesBeingModified.map((f) => (
                              <li key={f} className="text-xs font-mono text-muted-foreground truncate">
                                {f}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 2: Queue */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Queue</h2>
        {itemsLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : queueItems.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">Queue is empty.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {queueItems.map((item) => (
                  <Link
                    key={item.id}
                    href={`/work-items/${item.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{item.title}</p>
                      <p className="text-xs text-muted-foreground">{item.targetRepo}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-4">
                      <Badge className={PRIORITY_COLORS[item.priority]}>
                        {item.priority}
                      </Badge>
                      <Badge className={STATUS_COLORS[item.status] ?? ""}>
                        {item.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Section 3: Event Timeline */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Event Timeline</h2>
        {eventsLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <ATCEventLog events={events ?? []} />
        )}
      </div>
    </div>
  );
}
