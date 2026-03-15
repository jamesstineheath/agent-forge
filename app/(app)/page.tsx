"use client";

import { useState } from "react";
import { QuickStats } from "@/components/quick-stats";
import { ProjectCard } from "@/components/project-card";
import { EscalationCard } from "@/components/escalation-card";
import {
  useWorkItems,
  useRepos,
  useATCState,
  useProjects,
  useEscalations,
} from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

function formatRelativeTime(ts?: string): string {
  if (!ts) return "—";
  const ms = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function SystemHealth({
  atcState,
  repos,
  atcLoading,
}: {
  atcState: ReturnType<typeof useATCState>["data"];
  repos: ReturnType<typeof useRepos>["data"];
  atcLoading: boolean;
}) {
  if (atcLoading) {
    return (
      <p className="text-xs text-muted-foreground">Loading system status...</p>
    );
  }

  const queued = atcState?.queuedItems ?? 0;

  // Find the repo with active executions for concurrency display
  const repoExecCounts: Record<string, number> = {};
  atcState?.activeExecutions?.forEach((exec) => {
    repoExecCounts[exec.targetRepo] = (repoExecCounts[exec.targetRepo] ?? 0) + 1;
  });
  const topRepo = Object.entries(repoExecCounts).sort((a, b) => b[1] - a[1])[0];
  const topRepoConfig = topRepo
    ? repos?.find((r) => r.fullName === topRepo[0] || r.shortName === topRepo[0])
    : undefined;

  const concurrencyStr = topRepo
    ? `Concurrency: ${topRepo[1]}/${topRepoConfig?.concurrencyLimit ?? "?"} on ${topRepo[0]}`
    : `Concurrency: 0 active`;

  return (
    <p className="text-xs text-muted-foreground">
      ATC: {atcState ? "healthy" : "unknown"}, last sweep{" "}
      {formatRelativeTime(atcState?.lastRunAt)} | {concurrencyStr} |{" "}
      {queued} queued across all repos
    </p>
  );
}

export default function DashboardPage() {
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const { data: repos, isLoading: reposLoading } = useRepos();
  const { data: atcState, isLoading: atcLoading } = useATCState();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const {
    data: escalations,
    isLoading: escalationsLoading,
    mutate: mutateEscalations,
  } = useEscalations("pending");

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set()
  );

  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Filter work items by project
  const getProjectWorkItems = (projectId: string): WorkItem[] => {
    return (
      workItems?.filter(
        (wi) =>
          wi.source.type === "project" && wi.source.sourceId === projectId
      ) ?? []
    );
  };

  // Merged today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const mergedToday =
    workItems?.filter(
      (wi) =>
        wi.execution?.outcome === "merged" &&
        wi.execution?.completedAt &&
        new Date(wi.execution.completedAt) >= todayStart
    ) ?? [];

  return (
    <div className="space-y-6">
      {/* Title + System Health */}
      <div>
        <h1 className="text-3xl font-bold">Agent Forge</h1>
        <p className="text-muted-foreground mt-1">
          Dev orchestration platform — coordinate autonomous agent teams across
          repos.
        </p>
        <div className="mt-2">
          <SystemHealth
            atcState={atcState}
            repos={repos}
            atcLoading={atcLoading || reposLoading}
          />
        </div>
      </div>

      {/* Quick Stats */}
      {itemsLoading ? (
        <p className="text-sm text-muted-foreground">Loading stats...</p>
      ) : (
        <QuickStats workItems={workItems ?? []} />
      )}

      {/* Needs Attention (Escalations) */}
      {!escalationsLoading && escalations && escalations.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Needs attention</h2>
          <div className="space-y-3">
            {escalations.map((esc) => {
              const workItem = workItems?.find(
                (wi) => wi.id === esc.workItemId
              );
              return (
                <EscalationCard
                  key={esc.id}
                  escalation={esc}
                  workItemTitle={workItem?.title}
                  onResolve={() => mutateEscalations()}
                  onDismiss={() => mutateEscalations()}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Projects */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Projects</h2>
        {projectsLoading ? (
          <p className="text-sm text-muted-foreground">Loading projects...</p>
        ) : !projects || projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No projects found. Projects are managed in Notion.
          </p>
        ) : (
          <div className="space-y-3">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                workItems={getProjectWorkItems(project.id)}
                expanded={expandedProjects.has(project.id)}
                onToggle={() => toggleProject(project.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Merged Today */}
      {mergedToday.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Merged today</h2>
          <div className="space-y-1.5">
            {mergedToday.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50"
              >
                <span className="text-emerald-500">&#10003;</span>
                <span className="font-medium truncate">{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {item.targetRepo}
                </span>
                <span className="text-xs text-muted-foreground ml-auto">
                  {formatRelativeTime(item.execution?.completedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
