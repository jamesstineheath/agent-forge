"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { BarChart3 } from "lucide-react";
import type { CostAnalytics } from "@/lib/types";

interface CostTrendChartProps {
  dailySpend: CostAnalytics["dailySpend"];
}

const REPO_COLORS: Record<string, string> = {
  "jamesstineheath/agent-forge": "bg-primary",
  "jamesstineheath/personal-assistant": "bg-status-merged",
  "jamesstineheath/rez-sniper": "bg-status-executing",
};

function getRepoColor(repo: string): string {
  return REPO_COLORS[repo] ?? "bg-status-queued";
}

function getRepoShortName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

export function CostTrendChart({ dailySpend }: CostTrendChartProps) {
  const [hoveredDay, setHoveredDay] = useState<string | null>(null);

  const maxSpend = Math.max(...dailySpend.map((d) => d.total), 1);
  const allRepos = Array.from(
    new Set(dailySpend.flatMap((d) => Object.keys(d.byRepo)))
  ).sort();

  const nonZeroDays = dailySpend.filter((d) => d.total > 0);

  if (nonZeroDays.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-1 p-4">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 size={14} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Spend over time</span>
        </div>
        <div className="text-sm text-muted-foreground/60 py-8 text-center">
          No spend data for this period
        </div>
      </div>
    );
  }

  const hoveredData = hoveredDay ? dailySpend.find((d) => d.date === hoveredDay) : null;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart3 size={14} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Spend over time</span>
        </div>
        {/* Legend */}
        <div className="flex items-center gap-3">
          {allRepos.map((repo) => (
            <div key={repo} className="flex items-center gap-1.5">
              <div className={cn("w-2 h-2 rounded-sm", getRepoColor(repo))} />
              <span className="text-[10px] text-muted-foreground/60">{getRepoShortName(repo)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Hover tooltip */}
      <div className="h-5 mb-1">
        {hoveredData && (
          <div className="text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">{hoveredData.date}</span>
            {" — "}
            <span className="font-mono">${hoveredData.total.toFixed(2)}</span>
            {" · "}
            {hoveredData.itemCount} item{hoveredData.itemCount !== 1 ? "s" : ""}
          </div>
        )}
      </div>

      {/* Chart area */}
      <div className="relative">
        {/* Max reference line */}
        <div className="absolute top-0 left-0 right-0 border-t border-dashed border-border">
          <span className="text-[9px] text-muted-foreground/40 font-mono absolute -top-3 right-0">
            ${maxSpend.toFixed(0)}
          </span>
        </div>

        {/* Bars */}
        <div className="flex items-end gap-px h-[180px] pt-3">
          {dailySpend.map((day) => {
            const heightPct = maxSpend > 0 ? (day.total / maxSpend) * 100 : 0;
            const repos = Object.entries(day.byRepo).sort(([a], [b]) => a.localeCompare(b));

            return (
              <div
                key={day.date}
                className="flex-1 flex flex-col justify-end h-full cursor-pointer group"
                onMouseEnter={() => setHoveredDay(day.date)}
                onMouseLeave={() => setHoveredDay(null)}
              >
                <div
                  className={cn(
                    "w-full rounded-t-sm transition-opacity",
                    hoveredDay && hoveredDay !== day.date ? "opacity-40" : "opacity-100"
                  )}
                  style={{ height: `${Math.max(heightPct, day.total > 0 ? 2 : 0)}%` }}
                >
                  {repos.length > 0 ? (
                    <div className="flex flex-col-reverse h-full rounded-t-sm overflow-hidden">
                      {repos.map(([repo, cost]) => {
                        const segPct = day.total > 0 ? (cost / day.total) * 100 : 0;
                        return (
                          <div
                            key={repo}
                            className={cn("w-full", getRepoColor(repo))}
                            style={{ height: `${segPct}%` }}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div className="h-full bg-muted rounded-t-sm" />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Date labels (sparse) */}
        <div className="flex justify-between mt-1.5">
          <span className="text-[9px] text-muted-foreground/40 font-mono">
            {dailySpend[0]?.date.slice(5)}
          </span>
          {dailySpend.length > 14 && (
            <span className="text-[9px] text-muted-foreground/40 font-mono">
              {dailySpend[Math.floor(dailySpend.length / 2)]?.date.slice(5)}
            </span>
          )}
          <span className="text-[9px] text-muted-foreground/40 font-mono">
            {dailySpend[dailySpend.length - 1]?.date.slice(5)}
          </span>
        </div>
      </div>
    </div>
  );
}
