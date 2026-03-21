"use client";

import { CheckCircle2, AlertTriangle, Play, Clock, XCircle, Inbox } from "lucide-react";
import { QuickStats } from "@/components/quick-stats";
import { EscalationCard } from "@/components/escalation-card";
import { ErrorBoundary } from "@/components/error-boundary";

import { ActivityFeed } from "@/components/activity-feed";
import { WebhookEventFeed } from "@/components/webhook-event-feed";
import { QADashboard } from "@/components/qa-dashboard";
import { ForceOpusToggle } from "@/app/components/force-opus-toggle";
import {
  useWorkItems,
  useEscalations,
} from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";
import { dispatchSortComparator } from "@/lib/atc/sort";

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

export default function DashboardPage() {
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const {
    data: escalations,
    isLoading: escalationsLoading,
    mutate: mutateEscalations,
  } = useEscalations("pending");

  const handleDismiss = async (escalationId: string) => {
    try {
      await fetch(`/api/escalations/${escalationId}/dismiss`, {
        method: "POST",
      });
      mutateEscalations();
    } catch {
      // Silently fail; user can retry
    }
  };

  const QUEUE_STATUSES = new Set<WorkItem["status"]>(["filed", "ready", "queued", "generating", "executing", "reviewing", "retrying"]);
  const queueItems = (workItems ?? [])
    .filter((wi) => QUEUE_STATUSES.has(wi.status))
    .slice()
    .sort(dispatchSortComparator);

  // Work item summary counts
  const allItems = workItems ?? [];
  const activeCount = allItems.filter((wi) =>
    wi.status === "executing" || wi.status === "reviewing"
  ).length;
  const queuedCount = allItems.filter((wi) =>
    wi.status === "ready" || wi.status === "filed"
  ).length;
  const failedCount = allItems.filter((wi) => wi.status === "failed").length;

  const now = new Date();
  const mergedToday =
    allItems.filter((wi) => {
      if (wi.status !== "merged") return false;
      const ts = wi.execution?.completedAt ?? wi.updatedAt;
      const completed = new Date(ts);
      return (
        completed.getUTCFullYear() === now.getUTCFullYear() &&
        completed.getUTCMonth() === now.getUTCMonth() &&
        completed.getUTCDate() === now.getUTCDate()
      );
    });

  const mergedLast24h = allItems.filter((wi) => {
    if (wi.status !== "merged") return false;
    const ts = wi.execution?.completedAt ?? wi.updatedAt;
    return Date.now() - new Date(ts).getTime() < 24 * 60 * 60 * 1000;
  }).length;

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Dashboard</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              System overview and active work
            </p>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {/* Quick Stats */}
          <ErrorBoundary section="Quick Stats">
          {itemsLoading ? (
            <div className="text-sm text-muted-foreground">Loading stats...</div>
          ) : (
            <QuickStats workItems={allItems} />
          )}
          </ErrorBoundary>

          {/* Work Item Summary */}
          <ErrorBoundary section="Work Items Summary">
          {!itemsLoading && (
            <div className="space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Work Items
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-xl card-elevated bg-surface-1 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Play size={14} className="text-blue-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Active</span>
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-foreground">{activeCount}</span>
                  <p className="text-[10px] text-muted-foreground/60">executing + reviewing</p>
                </div>
                <div className="rounded-xl card-elevated bg-surface-1 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Inbox size={14} className="text-amber-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Queued</span>
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-foreground">{queuedCount}</span>
                  <p className="text-[10px] text-muted-foreground/60">ready + filed</p>
                </div>
                <div className="rounded-xl card-elevated bg-surface-1 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle2 size={14} className="text-green-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Merged</span>
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-foreground">{mergedLast24h}</span>
                  <p className="text-[10px] text-muted-foreground/60">last 24h</p>
                </div>
                <div className="rounded-xl card-elevated bg-surface-1 p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <XCircle size={14} className="text-red-500" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">Failed</span>
                  </div>
                  <span className="text-2xl font-bold tabular-nums text-foreground">{failedCount}</span>
                  <p className="text-[10px] text-muted-foreground/60">needs attention</p>
                </div>
              </div>
            </div>
          )}
          </ErrorBoundary>

          {/* Queue */}
          <ErrorBoundary section="Queue">
          {!itemsLoading && queueItems.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  Queue
                </h2>
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold tabular-nums text-primary">
                  {queueItems.length}
                </span>
              </div>
              <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-1">
                {queueItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2.5 text-sm py-1.5 min-w-0"
                  >
                    {(() => {
                      const p = item.triagePriority;
                      if (p === "P0") return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">P0</span>;
                      if (p === "P1") return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-yellow-100 text-yellow-700">P1</span>;
                      if (p === "P2") return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-600">P2</span>;
                      return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-500">P?</span>;
                    })()}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {item.rank != null ? `#${item.rank}` : "\u2014"}
                    </span>
                    <a href={`/work-items/${item.id}`} className="truncate text-foreground hover:underline">
                      {item.title}
                    </a>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0 font-mono">
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          </ErrorBoundary>

          {/* Needs Attention (Escalations) */}
          <ErrorBoundary section="Escalations">
          {!escalationsLoading && escalations && escalations.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <div className="relative flex h-6 w-6 items-center justify-center rounded-lg bg-status-blocked/15">
                  <AlertTriangle className="h-3.5 w-3.5 text-status-blocked" />
                </div>
                <h2 className="text-sm font-display font-bold text-foreground">
                  Needs Attention
                </h2>
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-status-blocked text-[10px] font-bold tabular-nums text-white">
                  {escalations.length}
                </span>
              </div>
              <div className="space-y-2">
                {escalations.map((esc) => {
                  const workItem = allItems.find(
                    (wi) => wi.id === esc.workItemId
                  );
                  return (
                    <EscalationCard
                      key={esc.id}
                      escalation={esc}
                      workItemTitle={workItem?.title}
                      onResolve={() => mutateEscalations()}
                      onDismiss={() => handleDismiss(esc.id)}
                    />
                  );
                })}
              </div>
            </div>
          )}
          </ErrorBoundary>

          {/* Config / Kill Switches */}
          <ErrorBoundary section="Config">
          <ForceOpusToggle />
          </ErrorBoundary>

          {/* QA Agent */}
          <ErrorBoundary section="QA Dashboard">
          <QADashboard />
          </ErrorBoundary>

          {/* Webhook Event Feed */}
          <ErrorBoundary section="Webhook Events">
          <WebhookEventFeed />
          </ErrorBoundary>

          {/* Activity Feed */}
          <ErrorBoundary section="Activity Feed">
          <ActivityFeed />
          </ErrorBoundary>

          {/* Merged Today */}
          <ErrorBoundary section="Merged Today">
          {mergedToday.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Merged today
              </h2>
              <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-1">
                {mergedToday.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2.5 text-sm py-1.5 min-w-0"
                  >
                    <CheckCircle2 size={14} className="text-status-merged shrink-0" />
                    <span className="truncate text-foreground">{item.title}</span>
                    <span className="text-[10px] text-muted-foreground/60 ml-auto shrink-0 font-mono">
                      {item.targetRepo} &middot;{" "}
                      {formatRelativeTime(item.execution?.completedAt ?? item.updatedAt)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          </ErrorBoundary>
        </div>
      </div>
    </>
  );
}
