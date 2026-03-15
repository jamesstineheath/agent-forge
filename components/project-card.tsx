"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ProgressBar } from "@/components/progress-bar";
import type { Project, WorkItem } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  Draft: "bg-gray-100 text-gray-700",
  Ready: "bg-blue-100 text-blue-700",
  Execute: "bg-amber-100 text-amber-700",
  Executing: "bg-yellow-100 text-yellow-700",
  Complete: "bg-green-100 text-green-700",
  Failed: "bg-red-100 text-red-700",
};

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
];

function StatusIcon({ status }: { status: WorkItem["status"] }) {
  switch (status) {
    case "merged":
      return <span className="text-emerald-500">&#10003;</span>;
    case "executing":
    case "generating":
    case "reviewing":
      return <span className="text-amber-500">&#9654;</span>;
    case "failed":
      return <span className="text-red-500">&#10007;</span>;
    case "blocked":
      return <span className="text-orange-500">&#9632;</span>;
    default:
      return <span className="text-gray-400">&#9679;</span>;
  }
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const ms = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m elapsed`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m elapsed`;
}

function formatMergeTime(completedAt?: string): string {
  if (!completedAt) return "";
  const ms = Date.now() - new Date(completedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `merged ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `merged ${hours}h ago`;
  return `merged ${Math.floor(hours / 24)}d ago`;
}

function WorkItemMeta({ item }: { item: WorkItem }) {
  if (ACTIVE_STATUSES.includes(item.status)) {
    return (
      <span className="text-xs text-muted-foreground">
        {formatElapsed(item.execution?.startedAt)}
      </span>
    );
  }
  if (item.status === "reviewing" && item.execution?.prNumber) {
    return (
      <span className="text-xs text-muted-foreground">
        PR #{item.execution.prNumber}
      </span>
    );
  }
  if (item.status === "blocked" && item.escalation?.reason) {
    return (
      <span className="text-xs text-orange-600">{item.escalation.reason}</span>
    );
  }
  if (item.status === "failed") {
    return (
      <span className="text-xs text-red-600">
        {item.execution?.outcome === "reverted" ? "Reverted" : "Failed"}
      </span>
    );
  }
  if (item.status === "merged") {
    return (
      <span className="text-xs text-muted-foreground">
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

  // Compute cost from work items with handoff data and execution data
  const spent = workItems
    .filter((wi) => wi.execution && wi.handoff)
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);
  const totalBudget = workItems
    .filter((wi) => wi.handoff)
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);

  const spentRatio = totalBudget > 0 ? spent / totalBudget : 0;
  const costColor =
    spentRatio > 0.9
      ? "text-red-600"
      : spentRatio > 0.7
        ? "text-amber-600"
        : "text-muted-foreground";

  const statusColor =
    STATUS_COLORS[project.status] ?? "bg-gray-100 text-gray-700";

  return (
    <Card
      className={`transition-colors ${hasFailed ? "border-red-300 bg-red-50/30" : ""}`}
    >
      <CardHeader
        className="cursor-pointer pb-3"
        onClick={onToggle}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium">{expanded ? "▼" : "▶"}</span>
            <span className="font-semibold truncate">{project.title}</span>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}
            >
              {project.status}
            </span>
            {project.targetRepo && (
              <span className="text-xs text-muted-foreground">
                {project.targetRepo}
              </span>
            )}
          </div>
          {totalBudget > 0 && (
            <span className={`text-xs font-medium ${costColor}`}>
              ${spent.toFixed(2)} / ${totalBudget.toFixed(2)}
            </span>
          )}
        </div>
        <div className="mt-2">
          <ProgressBar
            total={workItems.length}
            completed={completed}
            executing={executing}
            failed={failed}
            blocked={blocked}
          />
        </div>
      </CardHeader>
      {expanded && workItems.length > 0 && (
        <CardContent className="pt-0">
          <div className="space-y-1.5 border-t pt-3">
            {workItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-muted/50"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusIcon status={item.status} />
                  <span className="truncate">{item.title}</span>
                </div>
                <WorkItemMeta item={item} />
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
