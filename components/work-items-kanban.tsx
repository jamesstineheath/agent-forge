"use client";

import Link from "next/link";
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
  retrying: "bg-amber-500/10 text-amber-600",
  parked: "bg-muted text-muted-foreground",
  blocked: "bg-status-blocked/15 text-status-blocked",
  cancelled: "bg-muted text-muted-foreground",
  escalated: "bg-status-reviewing/10 text-status-reviewing",
  superseded: "bg-muted text-muted-foreground",
  verified: "bg-status-merged/10 text-status-merged",
  partial: "bg-orange-500/10 text-orange-600",
};

const PRIORITY_COLORS: Record<WorkItem["priority"], string> = {
  high: "bg-status-blocked/10 text-status-blocked",
  medium: "bg-status-executing/10 text-status-executing",
  low: "bg-muted text-muted-foreground",
};

const COLUMN_HEADER_COLORS: Record<string, string> = {
  Backlog: "text-muted-foreground",
  "In Progress": "text-status-executing",
  Review: "text-status-reviewing",
  Done: "text-status-merged",
  Terminal: "text-status-blocked",
};

interface ColumnDef {
  group: string;
  statuses: WorkItem["status"][];
}

const COLUMNS: ColumnDef[] = [
  { group: "Backlog", statuses: ["filed", "ready", "queued"] },
  { group: "In Progress", statuses: ["generating", "executing", "retrying"] },
  { group: "Review", statuses: ["reviewing", "escalated"] },
  { group: "Done", statuses: ["merged"] },
  { group: "Terminal", statuses: ["failed", "parked", "blocked", "cancelled", "superseded"] },
];

export function WorkItemsKanban({ items }: { items: WorkItem[] }) {
  const columnData = COLUMNS.map((col) => ({
    ...col,
    items: items.filter((item) => col.statuses.includes(item.status)),
  }));

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 -mx-4 px-4 md:-mx-6 md:px-6">
      {columnData.map((col) => (
        <div
          key={col.group}
          className="flex-shrink-0 w-[260px] flex flex-col"
        >
          {/* Column header */}
          <div className="flex items-center justify-between px-2 py-2 mb-2">
            <h3
              className={`text-[11px] font-semibold uppercase tracking-wider ${
                COLUMN_HEADER_COLORS[col.group] ?? "text-muted-foreground"
              }`}
            >
              {col.group}
            </h3>
            <span className="text-[10px] font-medium text-muted-foreground/60 bg-muted rounded-full px-1.5 py-0.5">
              {col.items.length}
            </span>
          </div>

          {/* Column body */}
          <div className="flex-1 space-y-2 min-h-[200px]">
            {col.items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <p className="text-[11px] text-muted-foreground/40">No items</p>
              </div>
            ) : (
              col.items.map((item) => (
                <Link
                  key={item.id}
                  href={`/work-items/${item.id}`}
                  className="block rounded-lg card-elevated bg-surface-1 p-3 hover:shadow-md transition-shadow cursor-pointer"
                >
                  <p className="text-[12px] font-medium text-foreground line-clamp-2 mb-2">
                    {item.title}
                  </p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge className={`text-[9px] px-1.5 py-0 ${STATUS_COLORS[item.status]}`}>
                      {item.status}
                    </Badge>
                    <Badge className={`text-[9px] px-1.5 py-0 ${PRIORITY_COLORS[item.priority]}`}>
                      {item.priority}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 mt-1.5 font-mono">
                    {item.targetRepo.split("/").pop()}
                  </p>
                </Link>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
