"use client";

import { useState } from "react";
import { QualityRing } from "@/components/quality-ring";
import type { TLMMemoryStats, TLMHotPattern, TLMOutcome } from "@/lib/types";

interface TLMAgentCardProps {
  name: string;
  stats: TLMMemoryStats | null;
  hotPatterns: TLMHotPattern[];
  recentOutcomes: TLMOutcome[];
  successRate: number | null;
  lastRun: string | null;
  status: "active" | "in-pipeline" | "idle";
}

function outcomeIcon(outcome: string) {
  switch (outcome) {
    case "correct":
      return <span className="text-green-500" title="Correct">&#10003;</span>;
    case "caused_issues":
      return <span className="text-red-500" title="Caused Issues">&#10007;</span>;
    case "premature":
      return <span className="text-muted-foreground" title="Premature">&#9711;</span>;
    default:
      return <span className="text-muted-foreground">&#8212;</span>;
  }
}

function statusBadge(status: TLMAgentCardProps["status"]) {
  const styles = {
    active: "bg-green-500/10 text-green-500",
    "in-pipeline": "bg-amber-500/10 text-amber-500",
    idle: "bg-muted text-muted-foreground",
  };
  const labels = {
    active: "Active",
    "in-pipeline": "In Pipeline",
    idle: "Idle",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

export function TLMAgentCard({
  name,
  stats,
  hotPatterns,
  recentOutcomes,
  successRate,
  lastRun,
  status,
}: TLMAgentCardProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border bg-card p-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-4 text-left"
      >
        <QualityRing rate={successRate} size={64} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{name}</h3>
            {statusBadge(status)}
          </div>
          {stats && (
            <p className="text-sm text-muted-foreground mt-1">
              {stats.totalAssessed} assessed &middot; {stats.correct} correct &middot;{" "}
              {stats.causedIssues} issues
            </p>
          )}
          {lastRun && (
            <p className="text-xs text-muted-foreground">Last: {lastRun}</p>
          )}
        </div>
        <span className="text-muted-foreground">{expanded ? "\u25B2" : "\u25BC"}</span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4 border-t pt-4">
          {hotPatterns.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">Hot Patterns</h4>
              <ul className="space-y-1">
                {hotPatterns.map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="text-amber-500 mt-0.5">&#9888;</span>
                    <span>
                      <span className="text-muted-foreground">[{p.date}]</span>{" "}
                      {p.pattern.length > 120 ? p.pattern.slice(0, 120) + "..." : p.pattern}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {recentOutcomes.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">Recent Outcomes</h4>
              <ul className="space-y-1">
                {recentOutcomes.slice(0, 10).map((o, i) => (
                  <li key={i} className="flex items-center gap-2 text-sm">
                    {outcomeIcon(o.outcome)}
                    <span className="text-muted-foreground">{o.date}</span>
                    <span className="truncate">{o.entity}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
