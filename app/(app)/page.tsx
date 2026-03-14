"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { PipelineStatus } from "@/components/pipeline-status";
import { useWorkItems, useRepos, useATCState } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

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

export default function DashboardPage() {
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const { data: repos, isLoading: reposLoading } = useRepos();
  const { data: atcState, isLoading: atcLoading } = useATCState();

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
