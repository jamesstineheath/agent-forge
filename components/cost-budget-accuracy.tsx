"use client";

import { cn } from "@/lib/utils";
import { Scale } from "lucide-react";
import type { CostAnalytics } from "@/lib/types";

interface CostBudgetAccuracyProps {
  budgetAccuracy: CostAnalytics["budgetAccuracy"];
}

export function CostBudgetAccuracy({ budgetAccuracy }: CostBudgetAccuracyProps) {
  const { items, avgOverrunPct, overBudgetCount, underBudgetCount } = budgetAccuracy;

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-1 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Scale size={14} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Budget vs Actual</span>
        </div>
        <div className="text-sm text-muted-foreground/60 py-8 text-center">
          Actual cost data will appear here as executions complete.
          <br />
          <span className="text-[11px]">Items need both a budget estimate and a reported actual cost.</span>
        </div>
      </div>
    );
  }

  const maxCost = Math.max(...items.flatMap((i) => [i.budget, i.actual]), 1);
  const onBudgetCount = items.length - overBudgetCount - underBudgetCount;

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Scale size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Budget vs Actual</span>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className={cn(
            "text-lg font-bold tabular-nums",
            avgOverrunPct > 10 ? "text-status-blocked" :
              avgOverrunPct < -10 ? "text-status-merged" : "text-foreground"
          )}>
            {avgOverrunPct > 0 ? "+" : ""}{avgOverrunPct}%
          </div>
          <div className="text-[11px] text-muted-foreground/60">Avg overrun</div>
        </div>
        <div>
          <div className="text-lg font-bold tabular-nums text-status-blocked">
            {overBudgetCount}
          </div>
          <div className="text-[11px] text-muted-foreground/60">Over budget (&gt;10%)</div>
        </div>
        <div>
          <div className="text-lg font-bold tabular-nums text-status-merged">
            {underBudgetCount}
          </div>
          <div className="text-[11px] text-muted-foreground/60">Under budget (&gt;10%)</div>
        </div>
      </div>

      {/* Item comparison bars */}
      <div className="space-y-2">
        {items.slice(0, 15).map((item) => {
          const budgetPct = (item.budget / maxCost) * 100;
          const actualPct = (item.actual / maxCost) * 100;
          const isOver = item.deltaPct > 10;
          const isUnder = item.deltaPct < -10;

          return (
            <div key={item.id} className="group">
              <div className="flex items-center justify-between text-[11px] mb-0.5">
                <span className="text-muted-foreground truncate max-w-[60%]">{item.title}</span>
                <span className={cn(
                  "font-mono",
                  isOver ? "text-status-blocked" :
                    isUnder ? "text-status-merged" : "text-muted-foreground/60"
                )}>
                  {item.deltaPct > 0 ? "+" : ""}{item.deltaPct}%
                </span>
              </div>
              <div className="relative h-3 bg-muted rounded-full overflow-hidden">
                {/* Budget bar (gray background) */}
                <div
                  className="absolute inset-y-0 left-0 bg-muted-foreground/15 rounded-full"
                  style={{ width: `${budgetPct}%` }}
                />
                {/* Actual bar (colored overlay) */}
                <div
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-full transition-all",
                    isOver ? "bg-status-blocked/60" :
                      isUnder ? "bg-status-merged/60" : "bg-primary/50"
                  )}
                  style={{ width: `${actualPct}%` }}
                />
              </div>
              <div className="flex justify-between text-[9px] text-muted-foreground/40 font-mono mt-0.5">
                <span>Budget: ${item.budget.toFixed(2)}</span>
                <span>Actual: ${item.actual.toFixed(2)}</span>
              </div>
            </div>
          );
        })}
      </div>

      {items.length > 15 && (
        <div className="text-[11px] text-muted-foreground/40 text-center mt-2">
          Showing 15 of {items.length} items
        </div>
      )}
    </div>
  );
}
