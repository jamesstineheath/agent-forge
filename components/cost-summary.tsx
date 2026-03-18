"use client";

import { DollarSign, RefreshCw } from "lucide-react";
import type { WorkItem } from "@/lib/types";

interface CostSummaryProps {
  workItems: WorkItem[];
}

function isToday(dateStr: string): boolean {
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function isWithinDays(dateStr: string, days: number): boolean {
  const d = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}

/** Actual cost if recorded, otherwise fall back to budget estimate */
function itemCost(item: WorkItem): number {
  return item.execution?.actualCost ?? item.handoff?.budget ?? 0;
}

export function CostSummary({ workItems }: CostSummaryProps) {
  const executedItems = workItems.filter(
    (item) => item.handoff && item.execution?.startedAt
  );

  const todayItems = executedItems.filter((item) =>
    isToday(item.execution!.startedAt!)
  );
  const todaySpend = todayItems.reduce(
    (sum, item) => sum + itemCost(item),
    0
  );

  const weekItems = executedItems.filter((item) =>
    isWithinDays(item.execution!.startedAt!, 7)
  );
  const weekSpend = weekItems.reduce(
    (sum, item) => sum + itemCost(item),
    0
  );

  const avgCost =
    executedItems.length > 0
      ? executedItems.reduce(
          (sum, item) => sum + itemCost(item),
          0
        ) / executedItems.length
      : 0;

  const wasteItems = executedItems.filter(
    (item) =>
      item.status === "failed" || item.execution?.outcome === "failed"
  );
  const wasteSpend = wasteItems.reduce(
    (sum, item) => sum + itemCost(item),
    0
  );
  const totalBudget = executedItems.reduce(
    (sum, item) => sum + itemCost(item),
    0
  );
  const wastePct =
    totalBudget > 0 ? Math.round((wasteSpend / totalBudget) * 100) : 0;
  const budgetUtil =
    totalBudget > 0 ? Math.min(1, weekSpend / totalBudget) : 0;

  // Per-repo breakdown
  const repoMap = new Map<string, { total: number; count: number }>();
  for (const item of executedItems) {
    const repo = item.targetRepo;
    const existing = repoMap.get(repo) ?? { total: 0, count: 0 };
    existing.total += itemCost(item);
    existing.count += 1;
    repoMap.set(repo, existing);
  }

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Cost overview</span>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <div className="text-xl font-bold text-foreground">
            ${todaySpend.toFixed(2)}
          </div>
          <div className="text-[11px] text-muted-foreground/60">
            Today ({todayItems.length} items)
          </div>
        </div>
        <div>
          <div className="text-xl font-bold text-foreground">
            ${weekSpend.toFixed(2)}
          </div>
          <div className="text-[11px] text-muted-foreground/60">
            This week ({weekItems.length} items)
          </div>
        </div>
        <div>
          <div className="text-xl font-bold text-foreground">
            ${avgCost.toFixed(2)}
          </div>
          <div className="text-[11px] text-muted-foreground/60">Avg per work item</div>
        </div>
      </div>

      {/* Budget utilization bar */}
      <div className="mb-3">
        <div className="flex justify-between text-[11px] text-muted-foreground/60 mb-1">
          <span>Budget utilization</span>
          <span>{Math.round(budgetUtil * 100)}%</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-status-merged rounded-full transition-all"
            style={{ width: `${budgetUtil * 100}%` }}
          />
        </div>
      </div>

      {/* Waste callout */}
      {wasteSpend > 0 && (
        <div className="flex items-center gap-2 text-xs rounded-lg bg-status-blocked/5 border border-status-blocked/15 px-3 py-2">
          <RefreshCw size={12} className="text-status-blocked shrink-0" />
          <span className="text-muted-foreground">
            <span className="text-status-blocked font-medium">
              ${wasteSpend.toFixed(2)}
            </span>{" "}
            ({wastePct}%) spent on failed executions this week.
          </span>
        </div>
      )}

      {/* Per-repo breakdown */}
      {repoMap.size > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider mb-1.5">
            By repo
          </div>
          {Array.from(repoMap.entries()).map(([repo, data]) => (
            <div
              key={repo}
              className="flex items-center justify-between py-1 text-xs"
            >
              <span className="text-muted-foreground">{repo}</span>
              <span className="text-muted-foreground/60">
                ${data.total.toFixed(2)} &middot; {data.count} items
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
