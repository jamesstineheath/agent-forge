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
    countColor: "text-foreground",
    barColor: "bg-status-queued",
    filter: (i) => i.status === "ready" || i.status === "queued",
  },
  {
    key: "executing",
    label: "Executing",
    countColor: "text-foreground",
    barColor: "bg-status-executing",
    filter: (i) => i.status === "generating" || i.status === "executing",
  },
  {
    key: "reviewing",
    label: "Reviewing",
    countColor: "text-foreground",
    barColor: "bg-status-reviewing",
    filter: (i) => i.status === "reviewing",
  },
  {
    key: "blocked",
    label: "Blocked",
    countColor: "text-status-reviewing",
    barColor: "bg-status-reviewing",
    filter: (i) => i.status === "blocked",
  },
  {
    key: "merged",
    label: "Merged",
    countColor: "text-foreground",
    barColor: "bg-status-merged",
    filter: (i) => i.status === "merged",
  },
  {
    key: "verified",
    label: "Verified",
    countColor: "text-emerald-600",
    barColor: "bg-emerald-500",
    filter: (i) => i.status === "verified",
  },
  {
    key: "partial",
    label: "Partial",
    countColor: "text-amber-600",
    barColor: "bg-amber-500",
    filter: (i) => i.status === "partial",
  },
  {
    key: "failed",
    label: "Failed",
    countColor: "text-status-blocked",
    barColor: "bg-status-blocked",
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
      <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
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
            <div className="text-[11px] text-muted-foreground/60 mb-2">{stage.label}</div>
            <div className={`h-1.5 rounded-full ${stage.barColor}`} />
          </button>
        ))}
      </div>

      {/* Expanded detail panels */}
      {expandedStage && (() => {
        const stage = stageCounts.find((s) => s.key === expandedStage);
        if (!stage || stage.items.length === 0) return null;
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
            <div className="rounded-lg border border-border bg-surface-1 p-3">
              <div className="text-xs font-medium text-muted-foreground mb-2">
                {stage.label} ({stage.count})
              </div>
              {stage.items.map((item) => (
                <div key={item.id} className="text-xs text-muted-foreground/60 py-0.5">
                  <Link
                    href={`/work-items/${item.id}`}
                    className="hover:text-foreground transition-colors"
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
