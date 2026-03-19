"use client";

import { useState } from "react";
import { useCostAnalytics } from "@/lib/hooks";
import { CostKPICards } from "@/components/cost-kpi-cards";
import { CostTrendChart } from "@/components/cost-trend-chart";
import { CostBudgetAccuracy } from "@/components/cost-budget-accuracy";
import { CostBreakdowns } from "@/components/cost-breakdowns";
import { CostItemTable } from "@/components/cost-item-table";

const PERIODS = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" },
];

export default function CostPage() {
  const [period, setPeriod] = useState("30d");
  const { data, isLoading } = useCostAnalytics(period);

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Cost Analytics</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Spend tracking across all managed repos
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-1 p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  period === p.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-12 text-center">
              Loading cost analytics...
            </div>
          ) : !data ? (
            <div className="text-sm text-muted-foreground py-12 text-center">
              Failed to load cost data
            </div>
          ) : (
            <>
              {/* KPI Cards */}
              <CostKPICards summary={data.summary} />

              {/* Spend Over Time */}
              <CostTrendChart dailySpend={data.dailySpend} />

              {/* Budget vs Actual */}
              <CostBudgetAccuracy budgetAccuracy={data.budgetAccuracy} />

              {/* Breakdowns */}
              <CostBreakdowns
                byRepo={data.byRepo}
                byAgent={data.byAgent}
                byComplexity={data.byComplexity}
              />

              {/* Recent Items */}
              <CostItemTable items={data.recentItems} />
            </>
          )}
        </div>
      </div>
    </>
  );
}
