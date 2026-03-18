"use client";

import { cn } from "@/lib/utils";
import { Activity, DollarSign, Zap, AlertTriangle, type LucideIcon } from "lucide-react";
import type { WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = [
  "generating",
  "executing",
  "reviewing",
];

interface QuickStatsProps {
  workItems: WorkItem[];
}

export function QuickStats({ workItems }: QuickStatsProps) {
  const merged = workItems.filter(
    (wi) => wi.status === "merged"
  ).length;
  const failedOrReverted = workItems.filter(
    (wi) =>
      wi.execution?.outcome === "failed" ||
      wi.execution?.outcome === "reverted"
  ).length;
  const qualityDenom = merged + failedOrReverted;
  const qualityRate = qualityDenom > 0 ? Math.round((merged / qualityDenom) * 100) : 100;

  const itemCost = (wi: WorkItem) => wi.execution?.actualCost ?? wi.handoff?.budget ?? 0;
  const hasActual = (wi: WorkItem) => wi.execution?.actualCost != null;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayExecuted = workItems.filter(
    (wi) =>
      wi.execution?.startedAt &&
      new Date(wi.execution.startedAt) >= todayStart &&
      wi.handoff
  );
  const todaySpend = todayExecuted.reduce((sum, wi) => sum + itemCost(wi), 0);
  const todayHasActuals = todayExecuted.some(hasActual);

  const active = workItems.filter((wi) =>
    ACTIVE_STATUSES.includes(wi.status)
  ).length;

  const totalSpent = workItems
    .filter((wi) => wi.execution && wi.handoff)
    .reduce((sum, wi) => sum + itemCost(wi), 0);
  const wasteSpent = workItems
    .filter(
      (wi) =>
        wi.handoff &&
        (wi.execution?.outcome === "failed" ||
          wi.execution?.outcome === "reverted")
    )
    .reduce((sum, wi) => sum + itemCost(wi), 0);
  const wastePct = totalSpent > 0 ? Math.round((wasteSpent / totalSpent) * 100) : 0;

  const stats: { label: string; value: string; icon: LucideIcon; color: string }[] = [
    {
      label: "TLM quality rate",
      value: `${qualityRate}%`,
      icon: Zap,
      color: "text-status-merged",
    },
    {
      label: todayHasActuals ? "Spent today" : "Spent today (est.)",
      value: `$${todaySpend.toFixed(0)}`,
      icon: DollarSign,
      color: "text-foreground",
    },
    {
      label: "Active executions",
      value: String(active),
      icon: Activity,
      color: active > 0 ? "text-status-executing" : "text-foreground",
    },
    {
      label: "Wasted on failures",
      value: `${wastePct}%`,
      icon: AlertTriangle,
      color: wastePct > 0 ? "text-status-blocked" : "text-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div
            key={stat.label}
            className="rounded-xl card-elevated bg-surface-1 p-3.5"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Icon className={cn("h-3.5 w-3.5", stat.color)} />
              <span className={cn("text-lg font-display font-bold tabular-nums", stat.color)}>
                {stat.value}
              </span>
            </div>
            <div className="text-[11px] font-medium text-muted-foreground">{stat.label}</div>
          </div>
        );
      })}
    </div>
  );
}
