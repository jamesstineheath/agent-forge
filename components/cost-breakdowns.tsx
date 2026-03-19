"use client";

import { cn } from "@/lib/utils";
import { Layers } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CostAnalytics } from "@/lib/types";

interface CostBreakdownsProps {
  byRepo: CostAnalytics["byRepo"];
  byAgent: CostAnalytics["byAgent"];
  byComplexity: CostAnalytics["byComplexity"];
}

function getRepoShortName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

export function CostBreakdowns({ byRepo, byAgent, byComplexity }: CostBreakdownsProps) {
  const agentEntries = Object.entries(byAgent).sort(([, a], [, b]) => b - a);

  return (
    <div className="rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Breakdowns</span>
      </div>

      <Tabs defaultValue="repo">
        <TabsList className="mb-3">
          <TabsTrigger value="repo">By Repo</TabsTrigger>
          <TabsTrigger value="agent">By Agent</TabsTrigger>
          <TabsTrigger value="complexity">By Complexity</TabsTrigger>
        </TabsList>

        <TabsContent value="repo">
          {byRepo.length === 0 ? (
            <div className="text-sm text-muted-foreground/60 py-4 text-center">No repo data</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground/60">
                    <th className="text-left py-2 font-medium">Repo</th>
                    <th className="text-right py-2 font-medium">Spend</th>
                    <th className="text-right py-2 font-medium">Items</th>
                    <th className="text-right py-2 font-medium">Success</th>
                    <th className="text-right py-2 font-medium">$/Merge</th>
                    <th className="text-right py-2 font-medium">Waste</th>
                  </tr>
                </thead>
                <tbody>
                  {byRepo.map((row) => (
                    <tr key={row.repo} className="border-b border-border/50">
                      <td className="py-2 text-foreground font-medium">{getRepoShortName(row.repo)}</td>
                      <td className="py-2 text-right font-mono text-foreground">${row.totalSpend.toFixed(2)}</td>
                      <td className="py-2 text-right text-muted-foreground">{row.itemCount}</td>
                      <td className="py-2 text-right">
                        <span className={cn(
                          row.successRate >= 80 ? "text-status-merged" :
                            row.successRate >= 60 ? "text-status-reviewing" : "text-status-blocked"
                        )}>
                          {row.successRate}%
                        </span>
                      </td>
                      <td className="py-2 text-right font-mono text-muted-foreground">
                        ${row.costPerMerge.toFixed(2)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        <span className={row.wasteSpend > 0 ? "text-status-blocked" : "text-muted-foreground/40"}>
                          ${row.wasteSpend.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="agent">
          {agentEntries.length === 0 ? (
            <div className="text-sm text-muted-foreground/60 py-4 text-center">
              No agent-level cost data yet.
              <br />
              <span className="text-[11px]">Agent costs will appear as executions report through the pipeline.</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground/60">
                    <th className="text-left py-2 font-medium">Agent</th>
                    <th className="text-right py-2 font-medium">Cost</th>
                    <th className="text-right py-2 font-medium">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const totalAgent = agentEntries.reduce((s, [, v]) => s + v, 0);
                    return agentEntries.map(([agent, cost]) => (
                      <tr key={agent} className="border-b border-border/50">
                        <td className="py-2 text-foreground font-medium capitalize">{agent.replace(/-/g, " ")}</td>
                        <td className="py-2 text-right font-mono text-foreground">${cost.toFixed(2)}</td>
                        <td className="py-2 text-right text-muted-foreground">
                          {totalAgent > 0 ? Math.round((cost / totalAgent) * 100) : 0}%
                        </td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="complexity">
          {byComplexity.length === 0 ? (
            <div className="text-sm text-muted-foreground/60 py-4 text-center">No complexity data</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground/60">
                    <th className="text-left py-2 font-medium">Complexity</th>
                    <th className="text-right py-2 font-medium">Avg Budget</th>
                    <th className="text-right py-2 font-medium">Avg Actual</th>
                    <th className="text-right py-2 font-medium">Model Est.</th>
                    <th className="text-right py-2 font-medium">Items</th>
                  </tr>
                </thead>
                <tbody>
                  {byComplexity.map((row) => (
                    <tr key={row.complexity} className="border-b border-border/50">
                      <td className="py-2 text-foreground font-medium capitalize">{row.complexity}</td>
                      <td className="py-2 text-right font-mono text-muted-foreground">
                        ${row.avgBudget.toFixed(2)}
                      </td>
                      <td className="py-2 text-right font-mono text-foreground">
                        ${row.avgActual.toFixed(2)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {row.currentEstimate != null ? (
                          <span className={cn(
                            row.estimateConfidence === "learned" ? "text-status-merged" :
                              row.estimateConfidence === "partial" ? "text-status-reviewing" : "text-muted-foreground/40"
                          )}>
                            ${row.currentEstimate.toFixed(2)}
                            <span className="text-[9px] ml-0.5">
                              ({row.estimateConfidence === "learned" ? `${row.estimateSampleSize} samples` :
                                row.estimateConfidence === "partial" ? "partial" : "default"})
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/30">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">{row.itemCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
