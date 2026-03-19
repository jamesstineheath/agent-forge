"use client";

import { cn } from "@/lib/utils";
import { List } from "lucide-react";
import type { CostAnalytics } from "@/lib/types";

interface CostItemTableProps {
  items: CostAnalytics["recentItems"];
}

const statusBg: Record<string, string> = {
  merged: "bg-status-merged/10 text-status-merged border-status-merged/20",
  failed: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
  executing: "bg-status-executing/10 text-status-executing border-status-executing/20",
  reviewing: "bg-status-reviewing/10 text-status-reviewing border-status-reviewing/20",
  queued: "bg-status-queued/10 text-status-queued border-status-queued/20",
  ready: "bg-status-queued/10 text-status-queued border-status-queued/20",
};

const complexityBg: Record<string, string> = {
  simple: "bg-status-merged/10 text-status-merged border-status-merged/20",
  moderate: "bg-status-reviewing/10 text-status-reviewing border-status-reviewing/20",
  complex: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
};

function getRepoShortName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

export function CostItemTable({ items }: CostItemTableProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-1 p-4">
        <div className="flex items-center gap-2 mb-3">
          <List size={14} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Recent work items</span>
        </div>
        <div className="text-sm text-muted-foreground/60 py-4 text-center">No executed items</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-center gap-2 mb-3">
        <List size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Recent work items</span>
        <span className="text-[10px] text-muted-foreground/40 ml-auto">{items.length} items</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground/60">
              <th className="text-left py-2 font-medium">Title</th>
              <th className="text-left py-2 font-medium">Repo</th>
              <th className="text-center py-2 font-medium">Complexity</th>
              <th className="text-right py-2 font-medium">Budget</th>
              <th className="text-right py-2 font-medium">Actual</th>
              <th className="text-right py-2 font-medium">Delta</th>
              <th className="text-center py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const hasActual = item.actualCost != null;
              const delta = hasActual ? item.actualCost! - item.budget : null;
              const deltaPct = hasActual && item.budget > 0
                ? Math.round(((item.actualCost! - item.budget) / item.budget) * 100)
                : null;

              return (
                <tr key={item.id} className="border-b border-border/50 hover:bg-accent/20">
                  <td className="py-2 text-foreground max-w-[200px] truncate" title={item.title}>
                    {item.title}
                  </td>
                  <td className="py-2 text-muted-foreground">{getRepoShortName(item.targetRepo)}</td>
                  <td className="py-2 text-center">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full border font-medium capitalize",
                      complexityBg[item.complexity] ?? "bg-secondary text-muted-foreground border-border"
                    )}>
                      {item.complexity}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono text-muted-foreground/60">
                    ${item.budget.toFixed(2)}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {hasActual ? (
                      <span className="text-foreground font-medium">${item.actualCost!.toFixed(2)}</span>
                    ) : (
                      <span className="text-muted-foreground/30 italic">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {deltaPct != null ? (
                      <span className={cn(
                        deltaPct > 10 ? "text-status-blocked" :
                          deltaPct < -10 ? "text-status-merged" : "text-muted-foreground/60"
                      )}>
                        {deltaPct > 0 ? "+" : ""}{deltaPct}%
                      </span>
                    ) : (
                      <span className="text-muted-foreground/30">—</span>
                    )}
                  </td>
                  <td className="py-2 text-center">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full border font-semibold",
                      statusBg[item.status] ?? "bg-secondary text-muted-foreground border-border"
                    )}>
                      {item.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
