"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { usePipelineStatus } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
];

const COMPLETED_STATUSES: WorkItem["status"][] = [
  "merged",
  "failed",
  "parked",
];

const STATUS_COLORS: Record<string, string> = {
  generating: "bg-yellow-100 text-yellow-700",
  executing: "bg-amber-100 text-amber-700",
  reviewing: "bg-purple-100 text-purple-700",
  merged: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  parked: "bg-slate-100 text-slate-600",
};

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "-";
  const ms = Date.now() - new Date(startedAt).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTime(ts?: string): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PipelinePage() {
  const { data, isLoading, error } = usePipelineStatus();

  const dispatches = data?.dispatches ?? [];
  const active = dispatches.filter((d) => ACTIVE_STATUSES.includes(d.status));
  const recent = dispatches
    .filter((d) => COMPLETED_STATUSES.includes(d.status))
    .slice(0, 20);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Pipeline</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isLoading
            ? "Loading..."
            : `${active.length} active execution${active.length !== 1 ? "s" : ""}`}
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-600">Failed to load pipeline data.</p>
      )}

      {/* Active Executions */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Active Executions</h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : active.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No active executions.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((item) => (
              <Link key={item.id} href={`/work-items/${item.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                      <Badge className={STATUS_COLORS[item.status] ?? ""}>
                        {item.status}
                      </Badge>
                    </div>
                    <CardTitle className="text-sm font-semibold line-clamp-2 mt-1">
                      {item.title}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {item.targetRepo}
                    </p>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Elapsed: {formatElapsed(item.execution?.startedAt)}</span>
                      {item.execution?.prUrl && (
                        <a
                          href={item.execution.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          PR #{item.execution.prNumber}
                        </a>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Recent Completions */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Recent Completions</h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : recent.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No completed executions yet.</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {recent.map((item) => (
                  <Link
                    key={item.id}
                    href={`/work-items/${item.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {item.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {item.targetRepo}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                      <Badge className={STATUS_COLORS[item.status] ?? ""}>
                        {item.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatTime(item.execution?.completedAt ?? item.updatedAt)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
