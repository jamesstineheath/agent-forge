"use client";

import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  Play,
  BarChart3,
  Pause,
  XCircle,
  Circle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  GitPullRequest,
  Clock,
} from "lucide-react";
import { ProgressBar } from "@/components/progress-bar";
import type { Project, WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
  "retrying",
];

const statusColor = (s: string) =>
  ({
    merged: "text-status-merged",
    completed: "text-status-merged",
    reviewing: "text-status-reviewing",
    executing: "text-status-executing",
    generating: "text-status-executing",
    retrying: "text-amber-600",
    queued: "text-status-queued",
    ready: "text-status-queued",
    blocked: "text-status-blocked",
    failed: "text-status-blocked",
    verified: "text-status-merged",
    partial: "text-orange-600",
    draft: "text-muted-foreground",
  })[s] || "text-muted-foreground";

const statusBg = (s: string) =>
  ({
    merged: "bg-status-merged/10 text-status-merged border-status-merged/20",
    completed: "bg-status-merged/10 text-status-merged border-status-merged/20",
    Complete: "bg-status-merged/10 text-status-merged border-status-merged/20",
    reviewing: "bg-status-reviewing/10 text-status-reviewing border-status-reviewing/20",
    executing: "bg-status-executing/10 text-status-executing border-status-executing/20",
    Execute: "bg-status-executing/10 text-status-executing border-status-executing/20",
    Executing: "bg-status-executing/10 text-status-executing border-status-executing/20",
    generating: "bg-status-executing/10 text-status-executing border-status-executing/20",
    queued: "bg-status-queued/10 text-status-queued border-status-queued/20",
    ready: "bg-status-queued/10 text-status-queued border-status-queued/20",
    Ready: "bg-status-queued/10 text-status-queued border-status-queued/20",
    blocked: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
    failed: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
    Failed: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
    retrying: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    verified: "bg-status-merged/10 text-status-merged border-status-merged/20",
    partial: "bg-orange-500/10 text-orange-600 border-orange-500/20",
    Draft: "bg-secondary text-muted-foreground border-border",
    draft: "bg-secondary text-muted-foreground border-border",
  })[s] || "bg-secondary text-muted-foreground border-border";

function StatusIcon({ status }: { status: string }) {
  const cls = statusColor(status);
  const size = 14;
  switch (status) {
    case "merged":
    case "completed":
      return <CheckCircle2 size={size} className={cls} />;
    case "reviewing":
      return <BarChart3 size={size} className={cls} />;
    case "executing":
    case "generating":
      return <Play size={size} className={cls} />;
    case "retrying":
      return <Clock size={size} className={cls} />;
    case "blocked":
      return <Pause size={size} className={cls} />;
    case "failed":
      return <XCircle size={size} className={cls} />;
    default:
      return <Circle size={size} className={cls} />;
  }
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const ms = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatMergeTime(completedAt?: string): string {
  if (!completedAt) return "";
  const ms = Date.now() - new Date(completedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function WorkItemMeta({ item }: { item: WorkItem }) {
  if (ACTIVE_STATUSES.includes(item.status)) {
    return (
      <span className="text-xs text-status-executing/70">
        {formatElapsed(item.execution?.startedAt)}
      </span>
    );
  }
  if (item.status === "reviewing" && item.execution?.prNumber) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-mono font-medium text-primary">
        <GitPullRequest className="h-2.5 w-2.5" />
        #{item.execution.prNumber}
      </span>
    );
  }
  if (item.status === "retrying") {
    return (
      <span className="text-xs text-amber-600/70">
        Retrying{item.execution?.retryCount ? ` (${item.execution.retryCount})` : ""}
      </span>
    );
  }
  if (item.status === "blocked" && item.escalation?.reason) {
    return (
      <span className="text-xs text-muted-foreground/60">{item.escalation.reason}</span>
    );
  }
  if (item.status === "failed") {
    return (
      <span className="text-xs text-status-blocked/70">
        {item.execution?.outcome === "reverted" ? "Reverted" : "Failed"}
      </span>
    );
  }
  if (item.status === "merged") {
    return (
      <span className="text-xs text-status-merged/70">
        {formatMergeTime(item.execution?.completedAt)}
      </span>
    );
  }
  return null;
}

interface ProjectCardProps {
  project: Project;
  workItems: WorkItem[];
  expanded: boolean;
  onToggle: () => void;
}

export function ProjectCard({
  project,
  workItems,
  expanded,
  onToggle,
}: ProjectCardProps) {
  const completed = workItems.filter((wi) => wi.status === "merged").length;
  const executing = workItems.filter((wi) =>
    ACTIVE_STATUSES.includes(wi.status)
  ).length;
  const failed = workItems.filter(
    (wi) => wi.status === "failed"
  ).length;
  const blocked = workItems.filter((wi) => wi.status === "blocked").length;
  const hasFailed = failed > 0;

  const itemCost = (wi: WorkItem) => wi.execution?.actualCost ?? wi.handoff?.budget ?? 0;

  const spent = workItems
    .filter((wi) => wi.execution && wi.handoff)
    .reduce((sum, wi) => sum + itemCost(wi), 0);
  const totalBudget = workItems
    .filter((wi) => wi.handoff)
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);

  const costPct = totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : 0;

  return (
    <div
      className={cn(
        "rounded-xl card-elevated overflow-hidden bg-surface-1",
        hasFailed && "ring-1 ring-status-blocked/15"
      )}
    >
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex items-start gap-3 hover:bg-accent/30 transition-colors"
      >
        <div className="mt-0.5">
          {expanded ? (
            <ChevronDown size={16} className="text-muted-foreground" />
          ) : (
            <ChevronRight size={16} className="text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-display font-bold text-foreground text-sm">
              {project.title}
            </span>
            <span
              className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded-full border", statusBg(project.status))}
            >
              {project.status}
            </span>
            {hasFailed && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-status-blocked/10 text-status-blocked border border-status-blocked/20 flex items-center gap-1">
                <AlertTriangle size={10} /> has failures
              </span>
            )}
            {totalBudget > 0 && (
              <span
                className={cn(
                  "text-[10px] font-mono ml-auto px-1.5 py-0.5 rounded-full border",
                  costPct > 90
                    ? "bg-status-blocked/10 text-status-blocked border-status-blocked/20"
                    : costPct > 70
                      ? "bg-status-reviewing/10 text-status-reviewing border-status-reviewing/20"
                      : "bg-secondary text-muted-foreground border-border"
                )}
              >
                ${spent.toFixed(2)} / ${totalBudget.toFixed(0)}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground/60 mb-2">
            {project.targetRepo} &middot; {project.projectId}
          </div>
          <ProgressBar
            total={workItems.length}
            completed={completed}
            executing={executing}
            failed={failed}
            blocked={blocked}
          />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-2">
          {workItems.length > 0 ? (
            <>
              {totalBudget > 0 && (
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 py-2 mb-1 text-xs border-b border-border">
                  <div className="text-muted-foreground">
                    <span className="font-medium text-foreground">Budget:</span>{" "}
                    ${totalBudget.toFixed(2)}
                  </div>
                  <div className="text-status-merged">
                    Actual: ${spent.toFixed(2)}
                    {spent === totalBudget && <span className="text-muted-foreground/40 ml-1">(est.)</span>}
                  </div>
                  <div className="text-muted-foreground">
                    Remaining: ${(totalBudget - spent).toFixed(2)}
                  </div>
                </div>
              )}
              {workItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-2.5 py-1.5 text-sm"
                >
                  <StatusIcon status={item.status} />
                  <span
                    className={cn(
                      "flex-1 truncate",
                      item.status === "blocked" ? "text-muted-foreground" : "text-foreground"
                    )}
                  >
                    {item.title}
                  </span>
                  {item.execution?.actualCost != null ? (
                    <span className="text-[11px] text-foreground/70 font-mono font-medium">
                      ${item.execution.actualCost.toFixed(2)}
                    </span>
                  ) : item.handoff?.budget != null ? (
                    <span className="text-[11px] text-muted-foreground/40 font-mono italic">
                      ~${item.handoff.budget.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/40">&mdash;</span>
                  )}
                  <span className={cn("text-[10px] px-1 py-0.5 rounded font-semibold", statusBg(item.status))}>
                    {item.status}
                  </span>
                  <WorkItemMeta item={item} />
                </div>
              ))}
            </>
          ) : (
            <div className="py-2 text-xs text-muted-foreground/60">
              No work items linked to this project yet. Work items with{" "}
              <code className="text-muted-foreground">source.sourceId: &quot;{project.projectId}&quot;</code>{" "}
              will appear here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
