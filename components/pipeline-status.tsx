"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { usePipelineStatus } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
];

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
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PipelineStatus() {
  const { data, isLoading, error } = usePipelineStatus();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-600">Failed to load pipeline status.</p>
        </CardContent>
      </Card>
    );
  }

  const dispatches = data?.dispatches ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {dispatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent activity.</p>
        ) : (
          <div className="space-y-0">
            {dispatches.map((item, i) => {
              const isActive = ACTIVE_STATUSES.includes(item.status);
              return (
                <div key={item.id}>
                  {i > 0 && <Separator className="my-2" />}
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2 min-w-0">
                      {isActive && (
                        <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">
                          {item.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {item.targetRepo}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                      <Badge className="text-xs">{item.status}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {isActive
                          ? formatElapsed(item.execution?.startedAt)
                          : formatTime(item.updatedAt)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
