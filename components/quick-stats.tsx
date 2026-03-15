"use client";

import { Card, CardContent } from "@/components/ui/card";
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
  // TLM quality rate: merged / (merged + failed + reverted)
  const merged = workItems.filter(
    (wi) => wi.execution?.outcome === "merged"
  ).length;
  const failedOrReverted = workItems.filter(
    (wi) =>
      wi.execution?.outcome === "failed" ||
      wi.execution?.outcome === "reverted"
  ).length;
  const qualityDenom = merged + failedOrReverted;
  const qualityRate = qualityDenom > 0 ? Math.round((merged / qualityDenom) * 100) : 100;

  // Today's spend: sum handoff.budget for items that started today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todaySpend = workItems
    .filter(
      (wi) =>
        wi.execution?.startedAt &&
        new Date(wi.execution.startedAt) >= todayStart &&
        wi.handoff
    )
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);

  // Active executions
  const active = workItems.filter((wi) =>
    ACTIVE_STATUSES.includes(wi.status)
  ).length;

  // Waste %: budget spent on failed items / total budget spent
  const totalSpent = workItems
    .filter((wi) => wi.execution && wi.handoff)
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);
  const wasteSpent = workItems
    .filter(
      (wi) =>
        wi.handoff &&
        (wi.execution?.outcome === "failed" ||
          wi.execution?.outcome === "reverted")
    )
    .reduce((sum, wi) => sum + (wi.handoff?.budget ?? 0), 0);
  const wastePct = totalSpent > 0 ? Math.round((wasteSpent / totalSpent) * 100) : 0;

  const stats = [
    {
      label: "TLM Quality",
      value: `${qualityRate}%`,
      color: qualityRate >= 80 ? "text-emerald-600" : qualityRate >= 60 ? "text-amber-600" : "text-red-600",
    },
    {
      label: "Today's Spend",
      value: `$${todaySpend.toFixed(2)}`,
      color: "text-foreground",
    },
    {
      label: "Active",
      value: String(active),
      color: active > 0 ? "text-amber-600" : "text-muted-foreground",
    },
    {
      label: "Waste",
      value: `${wastePct}%`,
      color: wastePct > 20 ? "text-red-600" : wastePct > 10 ? "text-amber-600" : "text-emerald-600",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label}>
          <CardContent className="py-3 px-4">
            <p className="text-xs font-medium text-muted-foreground">
              {stat.label}
            </p>
            <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
