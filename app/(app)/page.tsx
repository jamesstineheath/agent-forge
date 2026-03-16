"use client";

import { useState } from "react";
import { CheckCircle2, ArrowRight } from "lucide-react";
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
  if (!ts) return "\u2014";
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
      <div className="text-xs text-zinc-400">Loading system status...</div>
    );
  }

  const queued = atcState?.queuedItems ?? 0;

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
    <div className="flex items-center gap-4 text-xs text-zinc-400 px-1 py-2">
      <div className="flex items-center gap-1.5">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span>ATC: {atcState ? "healthy" : "unknown"}</span>
        <span className="text-zinc-600">
          &middot; last sweep {formatRelativeTime(atcState?.lastRunAt)}
        </span>
      </div>
      <div className="border-l border-zinc-800 pl-4 flex items-center gap-1.5">
        <span>{concurrencyStr}</span>
      </div>
      <div className="border-l border-zinc-800 pl-4 flex items-center gap-1.5">
        <span>{queued} queued across all repos</span>
      </div>
    </div>
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

  const getProjectWorkItems = (projectId: string): WorkItem[] => {
    return (
      workItems?.filter(
        (wi) =>
          wi.source?.type === "project" && wi.source?.sourceId === projectId
      ) ?? []
    );
  };

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
        <h1 className="text-lg font-semibold text-zinc-100">Dashboard</h1>
        <SystemHealth
          atcState={atcState}
          repos={repos}
          atcLoading={atcLoading || reposLoading}
        />
      </div>

      {/* Quick Stats */}
      {itemsLoading ? (
        <div className="text-sm text-zinc-400">Loading stats...</div>
      ) : (
        <QuickStats workItems={workItems ?? []} />
      )}

      {/* Needs Attention (Escalations) */}
      {!escalationsLoading && escalations && escalations.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Needs attention
          </div>
          <div className="space-y-2">
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
                  onDismiss={() => handleDismiss(esc.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Projects */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Projects
          </div>
          <button className="text-xs text-amber-400 hover:text-amber-300 transition-colors flex items-center gap-1">
            New work item <ArrowRight size={12} />
          </button>
        </div>
        {projectsLoading ? (
          <div className="text-sm text-zinc-400">Loading projects...</div>
        ) : !projects || projects.length === 0 ? (
          <div className="text-sm text-zinc-400">
            No projects found. Projects are managed in Notion.
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                workItems={getProjectWorkItems(project.projectId)}
                expanded={expandedProjects.has(project.id)}
                onToggle={() => toggleProject(project.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Merged Today */}
      {mergedToday.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-zinc-400 uppercase tracking-wider">
            Merged today
          </div>
          {mergedToday.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 text-sm text-zinc-300 py-1"
            >
              <CheckCircle2 size={14} className="text-emerald-400" />
              <span>{item.title}</span>
              <span className="text-xs text-zinc-500 ml-auto">
                {item.targetRepo} &middot;{" "}
                {formatRelativeTime(item.execution?.completedAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
