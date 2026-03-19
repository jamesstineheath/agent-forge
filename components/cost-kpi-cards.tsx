"use client";

import { cn } from "@/lib/utils";
import { DollarSign, TrendingUp, Target, AlertTriangle, BarChart3 } from "lucide-react";
import type { CostAnalytics } from "@/lib/types";

interface CostKPICardsProps {
  summary: CostAnalytics["summary"];
}

function KPICard({
  label,
  value,
  subtitle,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  subtitle?: string;
  icon: typeof DollarSign;
  color?: string;
}) {
  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn("h-3.5 w-3.5", color ?? "text-muted-foreground")} />
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className={cn("text-lg font-display font-bold tabular-nums", color ?? "text-foreground")}>
        {value}
      </div>
      {subtitle && (
        <div className="text-[10px] text-muted-foreground/50 mt-0.5">{subtitle}</div>
      )}
    </div>
  );
}

export function CostKPICards({ summary }: CostKPICardsProps) {
  const hasActuals = summary.itemsWithActualCost > 0;
  const estLabel = hasActuals ? "" : " (est.)";

  return (
    <div className="space-y-3">
      {/* Primary row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KPICard
          label={`Today${estLabel}`}
          value={`$${summary.todaySpend.toFixed(2)}`}
          icon={DollarSign}
          color="text-foreground"
        />
        <KPICard
          label={`This week${estLabel}`}
          value={`$${summary.weekSpend.toFixed(2)}`}
          icon={DollarSign}
          color="text-foreground"
        />
        <KPICard
          label={`This month${estLabel}`}
          value={`$${summary.monthSpend.toFixed(2)}`}
          icon={DollarSign}
          color="text-foreground"
        />
        <KPICard
          label="Cost per merge"
          value={`$${summary.costPerMerge.toFixed(2)}`}
          icon={Target}
          color="text-status-merged"
        />
        <KPICard
          label="Waste"
          value={`${summary.wastePct}%`}
          subtitle={summary.wasteSpend > 0 ? `$${summary.wasteSpend.toFixed(2)} on failures` : undefined}
          icon={AlertTriangle}
          color={summary.wastePct > 10 ? "text-status-blocked" : "text-muted-foreground"}
        />
      </div>

      {/* Secondary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPICard
          label="Daily burn rate"
          value={`$${summary.dailyBurnRate.toFixed(2)}/day`}
          icon={TrendingUp}
        />
        <KPICard
          label="Month projection"
          value={`$${summary.monthProjection.toFixed(0)}`}
          icon={BarChart3}
        />
        <KPICard
          label="All-time spend"
          value={`$${summary.allTimeSpend.toFixed(2)}`}
          subtitle={`${summary.totalExecutedItems} items executed`}
          icon={DollarSign}
        />
        <KPICard
          label="Actual cost coverage"
          value={`${summary.itemsWithActualCost}/${summary.totalExecutedItems}`}
          subtitle={hasActuals ? "items with actual costs" : "no actuals yet — showing estimates"}
          icon={Target}
          color={hasActuals ? "text-status-merged" : "text-muted-foreground"}
        />
      </div>
    </div>
  );
}
