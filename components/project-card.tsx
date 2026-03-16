"use client";

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
} from "lucide-react";
import { ProgressBar } from "@/components/progress-bar";
import type { Project, WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
];

const statusColor = (s: string) =>
  ({
    merged: "text-emerald-400",
    completed: "text-emerald-400",
    reviewing: "text-blue-400",
    executing: "text-amber-400",
    generating: "text-amber-400",
    queued: "text-zinc-400",
    ready: "text-zinc-400",
    blocked: "text-orange-400",
    failed: "text-red-400",
    draft: "text-zinc-500",
  })[s] || "text-zinc-400";

const statusBg = (s: string) =>
  ({
    merged: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",
    completed: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",
    Complete: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20",
    reviewing: "bg-blue-400/10 text-blue-400 border-blue-400/20",
    executing: "bg-amber-400/10 text-amber-400 border-amber-400/20",
    Execute: "bg-amber-400/10 text-amber-400 border-amber-400/20",
    Executing: "bg-amber-400/10 text-amber-400 border-amber-400/20",
    generating: "bg-amber-400/10 text-amber-400 border-amber-400/20",
    queued: "bg-zinc-400/10 text-zinc-400 border-zinc-400/20",
    ready: "bg-zinc-400/10 text-zinc-400 border-zinc-400/20",
    Ready: "bg-zinc-400/10 text-zinc-400 border-zinc-400/20",
    blocked: "bg-orange-400/10 text-orange-400 border-orange-400/20",
    failed: "bg-red-400/10 text-red-400 border-red-400/20",
    Failed: "bg-red-400/10 text-red-400 border-red-400/20",
    Draft: "bg-zinc-400/10 text-zinc-500 border-zinc-500/20",
    draft: "bg-zinc-400/10 text-zinc-500 border-zinc-500/20",
  })[s] || "bg-zinc-400/10 text-zinc-500 border-zinc-500/20";

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
      <span className="text-xs text-amber-400/70">
        {formatElapsed(item.execution?.startedAt)}
      </span>
    );
  }
  if (item.status === "reviewing" && item.execution?.prNumber) {
    return (
      <span className="text-xs text-blue-400/70">
        PR #{item.execution.prNumber}
      </span>
    );
  }
  if (item.status === "blocked" && item.escalation?.reason) {
    return (
      <span className="text-xs text-zinc-500">{item.escalation.reason}</span>
    );
  }
  if (item.status === "failed") {
    return (
      <span className="text-xs text-red-400/70">
        {item.execution?.outcome === "reverted" ? "Reverted" : "Failed"}
      </span>
    );
  }
  if (item.status === "merged") {
    return (
      <span className="text-xs text-emerald-400/70">
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

  const spent = workItems
    .filter((wi) => wi.execution && wi.handoff)
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);
  const totalBudget = workItems
    .filter((wi) => wi.handoff)
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);

  const spentRatio = totalBudget > 0 ? spent / totalBudget : 0;
  const costPct = Math.round(spentRatio * 100);

  return (
    <div
      className={`rounded-xl border ${hasFailed ? "border-red-500/30 bg-red-500/5" : "border-zinc-800 bg-zinc-900"} overflow-hidden`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left p-4 flex items-start gap-3 hover:bg-zinc-800/50 transition-colors"
      >
        <div className="mt-0.5">
          {expanded ? (
            <ChevronDown size={16} className="text-zinc-400" />
          ) : (
            <ChevronRight size={16} className="text-zinc-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-zinc-100 text-sm">
              {project.title}
            </span>
            <span
              className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${statusBg(project.status)}`}
            >
              {project.status}
            </span>
            {hasFailed && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20 flex items-center gap-1">
                <AlertTriangle size={10} /> has failures
              </span>
            )}
            {totalBudget > 0 && (
              <span
                className={`text-[10px] ml-auto px-1.5 py-0.5 rounded-full border ${
                  costPct > 90
                    ? "bg-red-400/10 text-red-400 border-red-400/20"
                    : costPct > 70
                      ? "bg-amber-400/10 text-amber-400 border-amber-400/20"
                      : "bg-zinc-400/10 text-zinc-400 border-zinc-400/20"
                }`}
              >
                ${spent.toFixed(2)} / ${totalBudget.toFixed(0)}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 mb-2">
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
        <div className="border-t border-zinc-800 px-4 py-2">
          {workItems.length > 0 ? (
            workItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2.5 py-1.5 text-sm"
              >
                <StatusIcon status={item.status} />
                <span
                  className={`flex-1 truncate ${item.status === "blocked" ? "text-zinc-500" : "text-zinc-300"}`}
                >
                  {item.title}
                </span>
                {item.handoff?.budget != null && item.execution && (
                  <span className="text-[11px] text-zinc-500">
                    ${item.handoff.budget.toFixed(2)}
                  </span>
                )}
                <WorkItemMeta item={item} />
              </div>
            ))
          ) : (
            <div className="py-2 text-xs text-zinc-500">
              No work items linked to this project yet. Work items with{" "}
              <code className="text-zinc-400">source.sourceId: &quot;{project.projectId}&quot;</code>{" "}
              will appear here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
