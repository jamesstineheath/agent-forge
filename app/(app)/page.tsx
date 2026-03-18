"use client";

import { useState } from "react";
import { CheckCircle2, ArrowRight, AlertTriangle } from "lucide-react";
import { QuickStats } from "@/components/quick-stats";
import { ProjectCard } from "@/components/project-card";
import { EscalationCard } from "@/components/escalation-card";
import { ATCMetricsPanel } from "@/components/atc-metrics-panel";
import { ActivityFeed } from "@/components/activity-feed";
import { WebhookEventFeed } from "@/components/webhook-event-feed";
import { QADashboard } from "@/components/qa-dashboard";
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
  const [hideCompleteProjects, setHideCompleteProjects] = useState(true);
  const [projectSearch, setProjectSearch] = useState("");

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

  const getProjectWorkItems = (project: { projectId: string; targetRepo: string | null }): WorkItem[] => {
    return (
      workItems?.filter(
        (wi) =>
          (wi.source?.type === "project" && wi.source?.sourceId === project.projectId) ||
          (project.targetRepo && wi.targetRepo === `jamesstineheath/${project.targetRepo}`)
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

  const now = new Date();
  const mergedToday =
    workItems?.filter((wi) => {
      if (wi.status !== "merged") return false;
      const ts = wi.execution?.completedAt ?? wi.updatedAt;
      const completed = new Date(ts);
      return (
        completed.getUTCFullYear() === now.getUTCFullYear() &&
        completed.getUTCMonth() === now.getUTCMonth() &&
        completed.getUTCDate() === now.getUTCDate()
      );
    }) ?? [];

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
          {itemsLoading ? (
            <div className="text-sm text-muted-foreground">Loading stats...</div>
          ) : (
            <QuickStats workItems={workItems ?? []} />
          )}

          {/* ATC Performance Metrics */}
          <ATCMetricsPanel />

          {/* Needs Attention (Escalations) */}
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
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  Projects
                </h2>
                <button
                  onClick={() => setHideCompleteProjects(!hideCompleteProjects)}
                  className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  {hideCompleteProjects ? "Show complete" : "Hide complete"}
                </button>
              </div>
              <button className="text-xs text-primary hover:text-primary/80 transition-colors flex items-center gap-1 font-medium">
                New work item <ArrowRight size={12} />
              </button>
            </div>
            <input
              type="text"
              placeholder="Search projects..."
              value={projectSearch}
              onChange={(e) => setProjectSearch(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {projectsLoading ? (
              <div className="text-sm text-muted-foreground">Loading projects...</div>
            ) : !projects || projects.length === 0 ? (
              <div className="rounded-xl card-elevated bg-surface-1 p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  No projects found. Projects are managed in Notion.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {projects.filter((p) => {
                  if (hideCompleteProjects && p.status === "Complete") return false;
                  if (projectSearch) {
                    const q = projectSearch.toLowerCase();
                    return p.title.toLowerCase().includes(q) || p.projectId.toLowerCase().includes(q) || (p.targetRepo?.toLowerCase().includes(q) ?? false);
                  }
                  return true;
                }).map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    workItems={getProjectWorkItems(project)}
                    expanded={expandedProjects.has(project.id)}
                    onToggle={() => toggleProject(project.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* QA Agent */}
          <QADashboard />

          {/* Webhook Event Feed */}
          <WebhookEventFeed />

          {/* Activity Feed */}
          <ActivityFeed />

          {/* Merged Today */}
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
        </div>
      </div>
    </>
  );
}
