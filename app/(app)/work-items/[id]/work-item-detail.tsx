"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DispatchButton } from "@/components/dispatch-button";
import { useWorkItem, useWorkItemEvents } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const LIFECYCLE: WorkItem["status"][] = [
  "filed",
  "ready",
  "generating",
  "executing",
  "reviewing",
  "merged",
];

const STATUS_COLORS: Record<WorkItem["status"], string> = {
  filed: "bg-muted text-muted-foreground",
  ready: "bg-status-reviewing/15 text-status-reviewing",
  queued: "bg-status-queued/15 text-status-queued",
  generating: "bg-status-executing/15 text-status-executing",
  executing: "bg-status-executing/15 text-status-executing",
  reviewing: "bg-status-reviewing/15 text-status-reviewing",
  merged: "bg-status-merged/15 text-status-merged",
  failed: "bg-status-blocked/15 text-status-blocked",
  retrying: "bg-amber-500/15 text-amber-600",
  parked: "bg-muted text-muted-foreground",
  blocked: "bg-status-blocked/15 text-status-blocked",
  cancelled: "bg-muted text-muted-foreground/60",
  escalated: "bg-status-reviewing/15 text-status-reviewing",
  superseded: "bg-muted text-muted-foreground/60",
  verified: "bg-status-merged/15 text-status-merged",
  partial: "bg-orange-500/15 text-orange-600",
};

function formatDate(ts?: string | null): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function getTriagePriorityDisplay(priority: string | undefined | null): {
  label: string;
  className: string;
} {
  switch (priority) {
    case "P0":
      return { label: "P0", className: "bg-red-100 text-red-800 border-red-300" };
    case "P2":
      return { label: "P2", className: "bg-gray-100 text-gray-700 border-gray-300" };
    case "P1":
      return { label: "P1", className: "bg-yellow-100 text-yellow-800 border-yellow-300" };
    default:
      return { label: "P1 (default)", className: "bg-yellow-100 text-yellow-800 border-yellow-300" };
  }
}

function getRankDisplay(rank: number | undefined | null): string {
  return rank !== undefined && rank !== null ? String(rank) : "999 (default)";
}

export function WorkItemDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data: item, isLoading, error, mutate } = useWorkItem(id);
  const { data: itemEvents } = useWorkItemEvents(id);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/work-items/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Delete failed");
      }
      router.push("/work-items");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <p className="text-[12px] text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="space-y-6">
        <h1 className="text-lg font-display font-bold text-foreground">Work Item</h1>
        <p className="text-[12px] text-status-blocked">
          {error ? "Failed to load work item." : "Work item not found."}
        </p>
        <Link href="/work-items" className={buttonVariants({ variant: "outline" })}>
          Back to Work Items
        </Link>
      </div>
    );
  }

  const lifecycleIndex = LIFECYCLE.indexOf(item.status);
  const isTerminalFailure = item.status === "failed" || item.status === "parked";
  const isCancelled = item.status === "cancelled" || item.status === "superseded";

  // For failed/parked items, figure out which lifecycle stage they failed at
  // by looking at execution state (has PR? has workflow run? etc.)
  const failedAtIndex = isTerminalFailure
    ? item.execution?.prNumber
      ? 4 // reviewing (had a PR)
      : item.execution?.workflowRunId || item.execution?.startedAt
      ? 3 // executing (had a workflow run)
      : item.handoff
      ? 2 // generating (had a handoff)
      : 1 // ready
    : -1;

  async function handleResetToReady() {
    setResetting(true);
    setResetError(null);
    try {
      const res = await fetch(`/api/work-items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Reset failed");
      }
      mutate();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      {/* Sticky glass header */}
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-3 min-w-0">
            <Badge className={STATUS_COLORS[item.status]}>{item.status}</Badge>
            <h1 className="text-lg font-display font-bold text-foreground truncate">{item.title}</h1>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <DispatchButton workItem={item} onSuccess={() => mutate()} />
            <Link href="/work-items" className={buttonVariants({ variant: "outline" })}>
              Back
            </Link>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-4xl space-y-4">

          {/* Failure/parked banner */}
          {isTerminalFailure && (
            <div className="rounded-xl card-elevated bg-status-blocked/10 border border-status-blocked/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-[12px] font-semibold text-status-blocked">
                    {item.status === "parked"
                      ? "Parked after exhausting retries"
                      : "Execution failed"}
                  </div>
                  <div className="text-[11px] text-status-blocked/70 space-y-0.5">
                    {item.execution?.retryCount != null && item.execution.retryCount > 0 && (
                      <div>Retried {item.execution.retryCount} time{item.execution.retryCount > 1 ? "s" : ""}</div>
                    )}
                    {item.execution?.completedAt && (
                      <div>Failed at {formatDate(item.execution.completedAt)}</div>
                    )}
                    {item.execution?.outcome && item.execution.outcome !== item.status && (
                      <div>Last outcome: {item.execution.outcome}</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleResetToReady}
                    disabled={resetting}
                    className="border-status-blocked/30 text-status-blocked hover:bg-status-blocked/10 hover:text-status-blocked"
                  >
                    {resetting ? "Resetting..." : "Reset to Ready"}
                  </Button>
                  {resetError && (
                    <span className="text-[11px] text-status-blocked">{resetError}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Cancelled/superseded banner */}
          {isCancelled && (
            <div className="rounded-xl card-elevated bg-surface-1 border border-border p-4">
              <div className="text-[12px] text-muted-foreground">
                This work item was {item.status}.
                {item.status === "cancelled" && " The work may have been completed under a different item."}
              </div>
            </div>
          )}

          {/* Status timeline */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4">
            <div className="flex items-center gap-1">
              {LIFECYCLE.map((s, i) => {
                const isPast = isTerminalFailure
                  ? i < failedAtIndex
                  : lifecycleIndex > i;
                const isCurrent = isTerminalFailure
                  ? i === failedAtIndex
                  : lifecycleIndex === i;
                const isFailPoint = isTerminalFailure && i === failedAtIndex;
                return (
                  <div key={s} className="flex items-center flex-1 last:flex-none">
                    <div
                      className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
                        isFailPoint
                          ? "bg-status-blocked ring-2 ring-status-blocked/30"
                          : isCurrent
                          ? "bg-status-executing ring-2 ring-status-executing/30"
                          : isPast
                          ? "bg-status-merged"
                          : "bg-border"
                      }`}
                    />
                    <span
                      className={`mx-1 text-[11px] hidden sm:block ${
                        isFailPoint
                          ? "font-medium text-status-blocked"
                          : isCurrent
                          ? "font-medium text-status-executing"
                          : isPast
                          ? "text-status-merged"
                          : "text-muted-foreground/60"
                      }`}
                    >
                      {isFailPoint ? `${s} (failed)` : s}
                    </span>
                    {i < LIFECYCLE.length - 1 && (
                      <div
                        className={`flex-1 h-px ${
                          isFailPoint
                            ? "bg-status-blocked/40"
                            : isPast
                            ? "bg-status-merged/40"
                            : "bg-border"
                        }`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Metadata */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Metadata
            </h2>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 text-[12px]">
              <div>
                <dt className="text-muted-foreground">Target Repo</dt>
                <dd className="font-medium text-foreground">{item.targetRepo}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Priority</dt>
                <dd className="font-medium text-foreground">{item.priority}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Triage Priority</dt>
                <dd className="font-medium text-foreground">
                  {(() => {
                    const { label, className } = getTriagePriorityDisplay(item.triagePriority);
                    return (
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`}>
                        {label}
                      </span>
                    );
                  })()}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Rank</dt>
                <dd className="font-medium text-foreground">{getRankDisplay(item.rank)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Risk Level</dt>
                <dd className="font-medium text-foreground">{item.riskLevel}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Complexity</dt>
                <dd className="font-medium text-foreground">{item.complexity}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Source</dt>
                <dd className="font-medium text-foreground">{item.source?.type ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd className="font-medium text-foreground">{formatDate(item.createdAt)}</dd>
              </div>
            </dl>
          </div>

          {/* Description */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Description
            </h2>
            <p className="text-[12px] text-foreground whitespace-pre-wrap">{item.description}</p>
          </div>

          {/* Handoff */}
          {item.handoff && (
            <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Handoff
              </h2>
              <div className="flex gap-4 text-[12px]">
                <span>
                  <span className="text-muted-foreground">Branch: </span>
                  <code className="font-mono text-foreground">{item.handoff.branch}</code>
                </span>
                <span>
                  <span className="text-muted-foreground">Budget: </span>
                  <span className="text-foreground">${item.handoff.budget}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Generated: </span>
                  <span className="text-foreground">{formatDate(item.handoff.generatedAt)}</span>
                </span>
              </div>
              <Separator />
              <pre className="text-[11px] bg-muted rounded-md p-4 overflow-x-auto whitespace-pre-wrap text-foreground">
                {item.handoff.content}
              </pre>
            </div>
          )}

          {/* Execution */}
          {item.execution && (
            <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Execution
              </h2>
              <dl className="grid grid-cols-2 gap-3 text-[12px]">
                {item.execution.prUrl && (
                  <div>
                    <dt className="text-muted-foreground">Pull Request</dt>
                    <dd>
                      <a
                        href={item.execution.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        #{item.execution.prNumber}
                      </a>
                    </dd>
                  </div>
                )}
                {item.execution.workflowRunId && (
                  <div>
                    <dt className="text-muted-foreground">Workflow Run</dt>
                    <dd className="font-mono text-foreground">{item.execution.workflowRunId}</dd>
                  </div>
                )}
                {item.execution.outcome && (
                  <div>
                    <dt className="text-muted-foreground">Outcome</dt>
                    <dd className="font-medium text-foreground">{item.execution.outcome}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd className="text-foreground">{formatDate(item.execution.startedAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd className="text-foreground">{formatDate(item.execution.completedAt)}</dd>
                </div>
              </dl>
            </div>
          )}

          {/* History */}
          {itemEvents && itemEvents.length > 0 && (
            <div className="rounded-xl card-elevated bg-surface-1 p-4 space-y-3">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                History
              </h2>
              <div className="space-y-3">
                {itemEvents
                  .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
                  .map((evt) => (
                    <div key={evt.id} className="flex items-start gap-3 text-[12px]">
                      <div className="min-w-[140px] text-muted-foreground font-mono text-[11px]">
                        {new Date(evt.timestamp).toLocaleString()}
                      </div>
                      <div className="flex items-center gap-2">
                        {evt.previousStatus && evt.newStatus && (
                          <span className="inline-flex items-center gap-1">
                            <span className="px-1.5 py-0.5 rounded bg-muted text-[11px] text-foreground">{evt.previousStatus}</span>
                            <span className="text-muted-foreground">&rarr;</span>
                            <span className="px-1.5 py-0.5 rounded bg-muted text-[11px] text-foreground">{evt.newStatus}</span>
                          </span>
                        )}
                        <span className="text-muted-foreground">{evt.details}</span>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4">
            <div className="flex items-center gap-3">
              {!confirmDelete ? (
                <Button
                  variant="destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              ) : (
                <>
                  <span className="text-[12px] text-status-blocked">
                    Are you sure?
                  </span>
                  <Button
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deleting}
                  >
                    {deleting ? "Deleting..." : "Yes, Delete"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </>
              )}
              {deleteError && (
                <p className="text-[12px] text-status-blocked">{deleteError}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
