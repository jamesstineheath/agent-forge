"use client";

import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  TrendingUp,
} from "lucide-react";
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
  subtitle?: string;
}

function OutcomeIcon({ outcome }: { outcome: string }) {
  switch (outcome) {
    case "correct":
      return <CheckCircle2 size={12} className="text-emerald-400" />;
    case "caused_issues":
      return <XCircle size={12} className="text-red-400" />;
    default:
      return <Clock size={12} className="text-zinc-600" />;
  }
}

export function TLMAgentCard({
  name,
  stats,
  hotPatterns,
  recentOutcomes,
  successRate,
  lastRun,
  status,
  subtitle,
}: TLMAgentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isDeployed = status !== "in-pipeline";

  return (
    <div
      className={`rounded-xl border ${!isDeployed ? "border-zinc-800/50 bg-zinc-900/30" : "border-zinc-800 bg-zinc-900"} overflow-hidden`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 flex items-center gap-4 hover:bg-zinc-800/50 transition-colors"
      >
        <QualityRing rate={successRate} size={48} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-medium text-zinc-100 text-sm">{name}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                isDeployed
                  ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                  : "bg-zinc-400/10 text-zinc-500 border-zinc-500/20"
              }`}
            >
              {isDeployed ? "active" : "in pipeline"}
            </span>
            {status === "active" && (
              <TrendingUp size={12} className="text-emerald-400" />
            )}
          </div>
          <div className="text-xs text-zinc-500">
            {isDeployed && stats ? (
              <span>
                {stats.totalAssessed} assessed &middot; {stats.correct} correct
                &middot; {stats.causedIssues} issues
                {lastRun && <> &middot; last run {lastRun}</>}
              </span>
            ) : isDeployed ? (
              <span>{subtitle ?? "Awaiting first run"}</span>
            ) : (
              <span>Handoff filed, awaiting deployment</span>
            )}
          </div>
        </div>
        {expanded ? (
          <ChevronDown size={16} className="text-zinc-500" />
        ) : (
          <ChevronRight size={16} className="text-zinc-500" />
        )}
      </button>

      {expanded && isDeployed && (
        <div className="border-t border-zinc-800">
          {hotPatterns.length > 0 && (
            <div className="px-4 py-3 border-b border-zinc-800/50">
              <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
                Hot patterns (influencing reviews)
              </div>
              {hotPatterns.map((p, i) => (
                <div
                  key={i}
                  className="text-xs text-zinc-400 py-0.5 flex items-start gap-1.5"
                >
                  <AlertTriangle
                    size={10}
                    className="text-amber-400 mt-0.5 shrink-0"
                  />
                  <span>
                    {typeof p === "string"
                      ? p
                      : p.pattern.length > 120
                        ? p.pattern.slice(0, 120) + "..."
                        : p.pattern}
                  </span>
                </div>
              ))}
            </div>
          )}

          {recentOutcomes.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
                Recent actions
              </div>
              {recentOutcomes.slice(0, 10).map((o, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 py-1 text-xs"
                >
                  <OutcomeIcon outcome={o.outcome} />
                  <span className="text-zinc-400">{o.outcome}</span>
                  <span className="text-zinc-500 truncate">{o.entity}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
