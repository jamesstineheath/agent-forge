"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
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

type SortKey = "title" | "status" | "priority" | "complexity" | "targetRepo" | "createdAt";
type SortDir = "asc" | "desc";

function formatDate(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function WorkItemsTable({ items }: { items: WorkItem[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    const av = a[sortKey] ?? "";
    const bv = b[sortKey] ?? "";
    if (sortKey === "createdAt") {
      cmp = new Date(av).getTime() - new Date(bv).getTime();
    } else {
      cmp = String(av).localeCompare(String(bv));
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const SortHeader = ({ label, sortKeyName }: { label: string; sortKeyName: SortKey }) => (
    <button
      className="flex items-center gap-1 hover:text-foreground transition-colors"
      onClick={() => toggleSort(sortKeyName)}
    >
      {label}
      <ArrowUpDown className="h-3 w-3 opacity-50" />
    </button>
  );

  return (
    <div className="rounded-xl card-elevated bg-surface-1 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="border-border">
            <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/60">
              <SortHeader label="Title" sortKeyName="title" />
            </TableHead>
            <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/60">
              <SortHeader label="Status" sortKeyName="status" />
            </TableHead>
            <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/60 hidden md:table-cell">
              <SortHeader label="Priority" sortKeyName="priority" />
            </TableHead>
            <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/60 hidden lg:table-cell">
              <SortHeader label="Complexity" sortKeyName="complexity" />
            </TableHead>
            <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/60 hidden md:table-cell">
              <SortHeader label="Repo" sortKeyName="targetRepo" />
            </TableHead>
            <TableHead className="text-[11px] uppercase tracking-wider text-muted-foreground/60 hidden lg:table-cell">
              <SortHeader label="Created" sortKeyName="createdAt" />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((item) => (
            <TableRow key={item.id} className="border-border">
              <TableCell className="max-w-[300px]">
                <Link
                  href={`/work-items/${item.id}`}
                  className="text-[12px] font-medium text-foreground hover:text-primary transition-colors line-clamp-1"
                >
                  {item.title}
                </Link>
              </TableCell>
              <TableCell>
                <Badge className={`text-[10px] ${STATUS_COLORS[item.status]}`}>
                  {item.status}
                </Badge>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <Badge className={`text-[10px] ${PRIORITY_COLORS[item.priority]}`}>
                  {item.priority}
                </Badge>
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <span className="text-[11px] text-muted-foreground">{item.complexity}</span>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="text-[11px] text-muted-foreground font-mono">
                  {item.targetRepo.split("/").pop()}
                </span>
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <span className="text-[11px] text-muted-foreground">
                  {formatDate(item.createdAt)}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
