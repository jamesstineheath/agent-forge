"use client";

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

export function CostSummary({ workItems }: CostSummaryProps) {
  const executedItems = workItems.filter(
    (item) => item.handoff && item.execution?.startedAt
  );

  const todaySpend = executedItems
    .filter((item) => isToday(item.execution!.startedAt!))
    .reduce((sum, item) => sum + (item.handoff?.budget ?? 0), 0);

  const weekSpend = executedItems
    .filter((item) => isWithinDays(item.execution!.startedAt!, 7))
    .reduce((sum, item) => sum + (item.handoff?.budget ?? 0), 0);

  const avgCost =
    executedItems.length > 0
      ? executedItems.reduce((sum, item) => sum + (item.handoff?.budget ?? 0), 0) /
        executedItems.length
      : 0;

  const wasteItems = executedItems.filter(
    (item) =>
      item.status === "failed" || item.execution?.outcome === "failed"
  );
  const wasteSpend = wasteItems.reduce(
    (sum, item) => sum + (item.handoff?.budget ?? 0),
    0
  );

  // Per-repo breakdown
  const repoMap = new Map<string, { total: number; count: number }>();
  for (const item of executedItems) {
    const repo = item.targetRepo;
    const existing = repoMap.get(repo) ?? { total: 0, count: 0 };
    existing.total += item.handoff?.budget ?? 0;
    existing.count += 1;
    repoMap.set(repo, existing);
  }

  const totalBudget = executedItems.reduce(
    (sum, item) => sum + (item.handoff?.budget ?? 0),
    0
  );

  return (
    <div className="rounded-lg border bg-card p-4">
      <h2 className="text-lg font-semibold mb-4">Cost Overview</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-sm text-muted-foreground">Today</p>
          <p className="text-2xl font-bold">${todaySpend.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">This Week</p>
          <p className="text-2xl font-bold">${weekSpend.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Avg / Item</p>
          <p className="text-2xl font-bold">${avgCost.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">Total Items</p>
          <p className="text-2xl font-bold">{executedItems.length}</p>
        </div>
      </div>

      {/* Budget utilization bar */}
      {totalBudget > 0 && (
        <div className="mt-4">
          <div className="flex justify-between text-sm text-muted-foreground mb-1">
            <span>Budget Utilization</span>
            <span>${totalBudget.toFixed(2)} total</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.min(100, (weekSpend / Math.max(totalBudget, 1)) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Waste callout */}
      {wasteSpend > 0 && (
        <div className="mt-4 rounded-md bg-red-500/10 p-3">
          <p className="text-sm font-medium text-red-500">
            ${wasteSpend.toFixed(2)} spent on {wasteItems.length} failed execution
            {wasteItems.length !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      {/* Per-repo breakdown */}
      {repoMap.size > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium mb-2">Per-Repo Breakdown</h3>
          <div className="space-y-1">
            {Array.from(repoMap.entries()).map(([repo, data]) => (
              <div key={repo} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{repo}</span>
                <span>
                  ${data.total.toFixed(2)} ({data.count} item{data.count !== 1 ? "s" : ""})
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
