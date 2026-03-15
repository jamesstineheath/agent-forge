"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import type { WorkItem } from "@/lib/types";

interface StageConfig {
  key: string;
  label: string;
  color: string;
  barColor: string;
  filter: (item: WorkItem) => boolean;
}

const STAGES: StageConfig[] = [
  {
    key: "queued",
    label: "Queued",
    color: "text-sky-700",
    barColor: "bg-sky-500",
    filter: (i) => i.status === "ready" || i.status === "queued",
  },
  {
    key: "executing",
    label: "Executing",
    color: "text-amber-700",
    barColor: "bg-amber-500",
    filter: (i) => i.status === "generating" || i.status === "executing",
  },
  {
    key: "reviewing",
    label: "Reviewing",
    color: "text-purple-700",
    barColor: "bg-purple-500",
    filter: (i) => i.status === "reviewing",
  },
  {
    key: "blocked",
    label: "Blocked",
    color: "text-red-700",
    barColor: "bg-red-500",
    filter: (i) => i.status === "blocked",
  },
  {
    key: "merged",
    label: "Merged Today",
    color: "text-green-700",
    barColor: "bg-green-500",
    filter: (i) => {
      if (i.status !== "merged" && i.execution?.outcome !== "merged") return false;
      const completedAt = i.execution?.completedAt;
      if (!completedAt) return false;
      const completed = new Date(completedAt);
      const now = new Date();
      return (
        completed.getUTCFullYear() === now.getUTCFullYear() &&
        completed.getUTCMonth() === now.getUTCMonth() &&
        completed.getUTCDate() === now.getUTCDate()
      );
    },
  },
  {
    key: "failed",
    label: "Failed",
    color: "text-red-700",
    barColor: "bg-red-400",
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

  const total = stageCounts.reduce((sum, s) => sum + s.count, 0);

  return (
    <Card>
      <CardContent className="pt-6">
        {/* Stage columns */}
        <div className="grid grid-cols-3 gap-4 sm:grid-cols-6">
          {stageCounts.map((stage) => (
            <button
              key={stage.key}
              onClick={() =>
                setExpandedStage(expandedStage === stage.key ? null : stage.key)
              }
              className="text-center hover:bg-muted/50 rounded-lg p-2 transition-colors"
            >
              <p className={`text-2xl font-bold ${stage.color}`}>{stage.count}</p>
              <p className="text-xs text-muted-foreground">{stage.label}</p>
            </button>
          ))}
        </div>

        {/* Color bar */}
        {total > 0 && (
          <div className="flex h-2 rounded-full overflow-hidden mt-4">
            {stageCounts
              .filter((s) => s.count > 0)
              .map((stage) => (
                <div
                  key={stage.key}
                  className={`${stage.barColor} transition-all`}
                  style={{ width: `${(stage.count / total) * 100}%` }}
                />
              ))}
          </div>
        )}

        {/* Expanded detail panel */}
        {expandedStage && (() => {
          const stage = stageCounts.find((s) => s.key === expandedStage);
          if (!stage || stage.items.length === 0) return null;
          return (
            <div className="mt-4 pt-4 border-t">
              <p className="text-sm font-medium mb-2">{stage.label} ({stage.count})</p>
              <ul className="space-y-1">
                {stage.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/work-items/${item.id}`}
                      className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}
