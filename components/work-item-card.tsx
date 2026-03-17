"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { WorkItem } from "@/lib/types";

const STATUS_COLORS: Record<WorkItem["status"], string> = {
  filed: "bg-gray-100 text-gray-700",
  ready: "bg-blue-100 text-blue-700",
  queued: "bg-blue-50 text-blue-600",
  generating: "bg-yellow-100 text-yellow-700",
  executing: "bg-amber-100 text-amber-700",
  reviewing: "bg-purple-100 text-purple-700",
  merged: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  parked: "bg-slate-100 text-slate-600",
  blocked: "bg-red-200 text-red-800",
  cancelled: "bg-gray-200 text-gray-500",
  escalated: "bg-orange-100 text-orange-700",
  superseded: "bg-gray-200 text-gray-500",
};

const PRIORITY_COLORS: Record<WorkItem["priority"], string> = {
  high: "bg-red-100 text-red-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-gray-100 text-gray-600",
};

const COMPLEXITY_COLORS: Record<WorkItem["complexity"], string> = {
  simple: "bg-green-50 text-green-700",
  moderate: "bg-blue-50 text-blue-700",
  complex: "bg-orange-50 text-orange-700",
};

const SOURCE_COLORS: Record<string, string> = {
  project: "bg-blue-100 text-blue-800",
  manual: "bg-gray-100 text-gray-700",
  direct: "bg-green-100 text-green-800",
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
      <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
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
