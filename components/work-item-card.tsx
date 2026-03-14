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
          <p className="text-sm text-muted-foreground">{item.targetRepo}</p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            <Badge className={STATUS_COLORS[item.status]}>{item.status}</Badge>
            <Badge className={PRIORITY_COLORS[item.priority]}>
              {item.priority}
            </Badge>
            <Badge className={COMPLEXITY_COLORS[item.complexity]}>
              {item.complexity}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
