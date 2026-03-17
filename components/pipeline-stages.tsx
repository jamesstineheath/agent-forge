"use client";

import { useState } from "react";
import Link from "next/link";
import type { WorkItem } from "@/lib/types";

interface StageConfig {
  key: string;
  label: string;
  countColor: string;
  barColor: string;
  filter: (item: WorkItem) => boolean;
}

const STAGES: StageConfig[] = [
  {
    key: "queued",
    label: "Queued",
    countColor: "text-zinc-200",
    barColor: "bg-zinc-600",
    filter: (i) => i.status === "ready" || i.status === "queued",
  },
  {
    key: "executing",
    label: "Executing",
    countColor: "text-zinc-200",
    barColor: "bg-amber-500",
    filter: (i) => i.status === "generating" || i.status === "executing",
  },
  {
    key: "reviewing",
    label: "Reviewing",
    countColor: "text-zinc-200",
    barColor: "bg-blue-500",
    filter: (i) => i.status === "reviewing",
  },
  {
    key: "blocked",
    label: "Blocked",
    countColor: "text-orange-400",
    barColor: "bg-orange-500/60",
    filter: (i) => i.status === "blocked",
  },
  {
    key: "merged",
    label: "Merged",
    countColor: "text-zinc-200",
    barColor: "bg-emerald-500",
    filter: (i) =>
      i.status === "merged" || i.execution?.outcome === "merged",
  },
  {
    key: "failed",
    label: "Failed",
    countColor: "text-red-400",
    barColor: "bg-red-500",
    filter: (i) => i.status === "failed",
  },
];

interface PipelineStagesProps {
  workItems: WorkItem[];
}

export function PipelineStages({ workItems }: PipelineStagesProps) {
  const [expandedStage, setExpandedStage] = useState<string | null>(null);

  const stageCounts = STAGES.map((stage) => {
    const items = workItems.filter(stage.filter);
    return { ...stage, count: items.length, items };
  });

  return (
    <div>
      {/* Stage columns */}
      <div className="grid grid-cols-6 gap-2">
        {stageCounts.map((stage) => (
          <button
            key={stage.key}
            onClick={() =>
              setExpandedStage(expandedStage === stage.key ? null : stage.key)
            }
            className="text-center"
          >
            <div className={`text-2xl font-bold ${stage.countColor}`}>
              {stage.count}
            </div>
            <div className="text-[11px] text-zinc-500 mb-2">{stage.label}</div>
            <div className={`h-1.5 rounded-full ${stage.barColor}`} />
          </button>
        ))}
      </div>

      {/* Expanded detail panels */}
      {expandedStage && (() => {
        const stage = stageCounts.find((s) => s.key === expandedStage);
        if (!stage || stage.items.length === 0) return null;
        return (
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
              <div className="text-xs font-medium text-zinc-400 mb-2">
                {stage.label} ({stage.count})
              </div>
              {stage.items.map((item) => (
                <div key={item.id} className="text-xs text-zinc-500 py-0.5">
                  <Link
                    href={`/work-items/${item.id}`}
                    className="hover:text-zinc-300 transition-colors"
                  >
                    {item.title}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
