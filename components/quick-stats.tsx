"use client";

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
    (wi) => wi.execution?.outcome === "merged"
  ).length;
  const failedOrReverted = workItems.filter(
    (wi) =>
      wi.execution?.outcome === "failed" ||
      wi.execution?.outcome === "reverted"
  ).length;
  const qualityDenom = merged + failedOrReverted;
  const qualityRate = qualityDenom > 0 ? Math.round((merged / qualityDenom) * 100) : 100;

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

  const active = workItems.filter((wi) =>
    ACTIVE_STATUSES.includes(wi.status)
  ).length;

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
      label: "TLM quality rate",
      value: `${qualityRate}%`,
      color: "text-zinc-100",
    },
    {
      label: "Spent today",
      value: `$${todaySpend.toFixed(0)}`,
      color: "text-zinc-100",
    },
    {
      label: "Active executions",
      value: String(active),
      color: active > 0 ? "text-amber-400" : "text-zinc-100",
    },
    {
      label: "Wasted on failures",
      value: `${wastePct}%`,
      color: wastePct > 0 ? "text-red-400" : "text-zinc-100",
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-center"
        >
          <div className={`text-lg font-bold ${stat.color}`}>{stat.value}</div>
          <div className="text-[11px] text-zinc-400">{stat.label}</div>
        </div>
      ))}
    </div>
  );
}
