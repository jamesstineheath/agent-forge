"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PipelineStatus } from "@/components/pipeline-status";
import { useWorkItems, useRepos, useATCState, useProjects, useEscalations } from "@/lib/hooks";
import type { WorkItem, Project } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
];

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

const STATUS_COLORS: Record<string, string> = {
  Draft: "bg-gray-100 text-gray-700",
  Ready: "bg-blue-100 text-blue-700",
  Execute: "bg-amber-100 text-amber-700",
  Executing: "bg-yellow-100 text-yellow-700",
  Complete: "bg-green-100 text-green-700",
  Failed: "bg-red-100 text-red-700",
};

function ProjectStatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {status}
    </span>
  );
}

export default function DashboardPage() {
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const { data: repos, isLoading: reposLoading } = useRepos();
  const { data: atcState, isLoading: atcLoading } = useATCState();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: escalations, isLoading: escalationsLoading } = useEscalations("pending");

  const totalItems = workItems?.length ?? 0;
  const readyItems = workItems?.filter((i) => i.status === "ready").length ?? 0;
  const activeItems =
    workItems?.filter((i) => ACTIVE_STATUSES.includes(i.status)).length ?? 0;
  const totalRepos = repos?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Agent Forge</h1>
        <p className="text-muted-foreground mt-1">
          Dev orchestration platform — coordinate autonomous agent teams across
          repos.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Work Items
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {itemsLoading ? "—" : totalItems}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Ready to Dispatch
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-blue-600">
              {itemsLoading ? "—" : readyItems}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Active Executions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-amber-600">
              {itemsLoading ? "—" : activeItems}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Registered Repos
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {reposLoading ? "—" : totalRepos}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Blocked
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-red-600">
              {itemsLoading ? "\u2014" : (workItems?.filter((wi) => wi.status === "blocked").length ?? 0)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              ATC Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium">
              {atcLoading ? "—" : `Last run: ${formatRelativeTime(atcState?.lastRunAt)}`}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Projects from Notion */}
      <Card>
        <CardHeader>
          <CardTitle>Projects</CardTitle>
        </CardHeader>
        <CardContent>
          {projectsLoading ? (
            <p className="text-muted-foreground text-sm">Loading projects...</p>
          ) : !projects || projects.length === 0 ? (
            <p className="text-muted-foreground text-sm">No projects found. Projects are managed in Notion.</p>
          ) : (
            <div className="space-y-2">
              {projects.map((project: Project) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{project.title}</span>
                      <span className="text-xs text-muted-foreground">{project.projectId}</span>
                    </div>
                    <div className="flex gap-3 text-xs text-muted-foreground mt-1">
                      {project.targetRepo && <span>{project.targetRepo}</span>}
                      {project.priority && <span>{project.priority}</span>}
                      {project.complexity && <span>{project.complexity}</span>}
                    </div>
                  </div>
                  <ProjectStatusBadge status={project.status} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pending Escalations */}
      {!escalationsLoading && escalations && escalations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending Escalations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {escalations.map((esc) => {
                const workItem = workItems?.find((wi) => wi.id === esc.workItemId);
                const timeElapsed = Math.floor(
                  (Date.now() - new Date(esc.createdAt).getTime()) / 1000 / 60
                );
                const timeString =
                  timeElapsed < 60
                    ? `${timeElapsed}m ago`
                    : timeElapsed < 1440
                      ? `${Math.floor(timeElapsed / 60)}h ago`
                      : `${Math.floor(timeElapsed / 1440)}d ago`;

                return (
                  <div
                    key={esc.id}
                    className="border rounded-lg p-3 bg-red-50 border-red-200"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <p className="font-semibold text-sm">{workItem?.title ?? esc.workItemId}</p>
                        <p className="text-xs text-gray-600 mt-1">{esc.reason}</p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                          <span>Confidence: {Math.round(esc.confidenceScore * 100)}%</span>
                          <span>{"\u2022"}</span>
                          <span>{timeString}</span>
                        </div>
                      </div>
                      <a
                        href={`/api/escalations/${esc.id}/resolve`}
                        className="text-blue-600 hover:underline text-xs font-medium whitespace-nowrap ml-2"
                        title="Manual resolution via API (Handoff 12: Gmail integration coming)"
                      >
                        Resolve
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <PipelineStatus />

      <div className="flex gap-3">
        <Link href="/work-items/new" className={buttonVariants()}>
          New Work Item
        </Link>
        <Link href="/pipeline" className={buttonVariants({ variant: "outline" })}>
          View Pipeline
        </Link>
        <Link href="/repos" className={buttonVariants({ variant: "outline" })}>
          Manage Repos
        </Link>
      </div>
    </div>
  );
}
