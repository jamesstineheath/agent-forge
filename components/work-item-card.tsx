"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { WorkItem } from "@/lib/types";

const STATUS_COLORS: Record<WorkItem["status"], string> = {
  filed: "bg-muted text-muted-foreground",
  ready: "bg-status-queued/10 text-status-queued",
  queued: "bg-status-queued/10 text-status-queued",
  generating: "bg-status-executing/10 text-status-executing",
  executing: "bg-status-executing/10 text-status-executing",
  reviewing: "bg-status-reviewing/10 text-status-reviewing",
  merged: "bg-status-merged/10 text-status-merged",
  failed: "bg-status-blocked/10 text-status-blocked",
  parked: "bg-muted text-muted-foreground",
  blocked: "bg-status-blocked/15 text-status-blocked",
  cancelled: "bg-muted text-muted-foreground",
  escalated: "bg-status-reviewing/10 text-status-reviewing",
  superseded: "bg-muted text-muted-foreground",
};

const PRIORITY_COLORS: Record<WorkItem["priority"], string> = {
  high: "bg-status-blocked/10 text-status-blocked",
  medium: "bg-status-executing/10 text-status-executing",
  low: "bg-muted text-muted-foreground",
};

const COMPLEXITY_COLORS: Record<WorkItem["complexity"], string> = {
  simple: "bg-status-merged/10 text-status-merged",
  moderate: "bg-status-queued/10 text-status-queued",
  complex: "bg-status-reviewing/10 text-status-reviewing",
};

const SOURCE_COLORS: Record<string, string> = {
  project: "bg-primary/10 text-primary",
  manual: "bg-muted text-muted-foreground",
  direct: "bg-status-merged/10 text-status-merged",
};

const SOURCE_LABELS: Record<string, string> = {
  project: "Project",
  manual: "Manual",
  direct: "Fast Lane",
};

interface WorkItemCardProps {
  item: WorkItem;
}

export function WorkItemCard({ item }: WorkItemCardProps) {
  return (
    <Link href={`/work-items/${item.id}`}>
      <Card className="card-elevated bg-surface-1 hover:shadow-md transition-shadow cursor-pointer h-full">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold line-clamp-2">
            {item.title}
          </CardTitle>
          {item.triggeredBy && (
            <p className="text-xs text-muted-foreground mt-0.5">
              via {item.triggeredBy}
            </p>
          )}
          <p className="text-sm text-muted-foreground">{item.targetRepo}</p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            <Badge className={STATUS_COLORS[item.status]}>{item.status}</Badge>
            <Badge className={`hidden md:inline-flex ${PRIORITY_COLORS[item.priority]}`}>
              {item.priority}
            </Badge>
            <Badge className={`hidden md:inline-flex ${COMPLEXITY_COLORS[item.complexity]}`}>
              {item.complexity}
            </Badge>
            {item.source?.type && SOURCE_COLORS[item.source.type] && (
              <Badge className={SOURCE_COLORS[item.source.type]}>
                {SOURCE_LABELS[item.source.type] ?? item.source.type}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
