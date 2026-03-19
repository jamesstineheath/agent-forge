"use client";

import { cn } from "@/lib/utils";
import { useEvaluationMetrics } from "@/lib/hooks";
import type {
  FailureAttributionEntry,
  CostTrendEntry,
  ReasoningQualityMetrics,
  DriftAlert,
} from "@/app/api/agents/evaluation-metrics/route";

// --- Helpers ---

function timeAgo(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const severityColor: Record<DriftAlert["severity"], string> = {
  low: "text-muted-foreground bg-secondary border-border",
  medium: "text-status-reviewing bg-status-reviewing/10 border-status-reviewing/30",
  high: "text-status-blocked bg-status-blocked/10 border-status-blocked/30",
};

// --- Sub-sections ---

function FailureAttributionSection({ data }: { data: FailureAttributionEntry[] }) {
  if (data.length === 0) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-muted-foreground/60">No failure attribution data yet.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 space-y-2">
      {data.map((entry) => (
        <div key={entry.agent} className="flex items-center gap-3">
          <span className="text-xs text-foreground font-mono w-40 truncate" title={entry.agent}>
            {entry.agent}
          </span>
          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-status-blocked/70 rounded-full"
              style={{ width: `${entry.percentage}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-muted-foreground w-16 text-right">
            {entry.count} ({entry.percentage}%)
          </span>
        </div>
      ))}
    </div>
  );
}

function CostTrendSection({ data }: { data: CostTrendEntry[] }) {
  if (data.length === 0) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-muted-foreground/60">
          No cost data available — cost tracking may not be enabled.
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="space-y-1">
        <div className="flex items-center gap-3 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
          <span className="w-24">Date</span>
          <span className="w-20 text-right">Avg Cost</span>
          <span className="w-16 text-right">Items</span>
        </div>
        {data.map((entry) => (
          <div key={entry.date} className="flex items-center gap-3 text-xs">
            <span className="w-24 font-mono text-muted-foreground">{entry.date}</span>
            <span className="w-20 text-right font-mono text-foreground">
              ${entry.avgCostUsd.toFixed(4)}
            </span>
            <span className="w-16 text-right font-mono text-muted-foreground">
              {entry.itemCount}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReasoningQualitySection({ data }: { data?: ReasoningQualityMetrics }) {
  const allNull =
    data?.planQuality == null &&
    data?.stepEfficiency == null &&
    data?.toolCorrectness == null;

  if (!data || (allNull && data.dataSource?.includes("not yet"))) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-muted-foreground/60">
          Reasoning quality data will appear after the Supervisor agent runs.
        </p>
      </div>
    );
  }

  const metrics = [
    { label: "Plan Quality", value: data.planQuality },
    { label: "Step Efficiency", value: data.stepEfficiency },
    { label: "Tool Correctness", value: data.toolCorrectness },
  ];

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap gap-4">
        {metrics.map((m) => (
          <div
            key={m.label}
            className="flex-1 min-w-[100px] rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-border"
          >
            <div className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
              {m.label}
            </div>
            <div className="text-lg font-mono font-bold text-foreground mt-0.5">
              {m.value != null ? `${Math.round(m.value)}/100` : "\u2014"}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/40 mt-2">
        Source: {data.dataSource}
      </p>
    </div>
  );
}

function DriftAlertsSection({ data }: { data: DriftAlert[] }) {
  if (data.length === 0) {
    return (
      <div className="px-4 py-3">
        <p className="text-xs text-status-merged">
          <span className="mr-1">{"\u2713"}</span>
          No drift detected
        </p>
      </div>
    );
  }

  const display = data.slice(0, 10);

  return (
    <div className="px-4 py-3 space-y-1.5">
      {display.map((alert) => (
        <div key={alert.id} className="flex items-start gap-2 text-xs">
          <span
            className={cn(
              "inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0",
              severityColor[alert.severity]
            )}
          >
            {alert.severity}
          </span>
          <span className="text-muted-foreground flex-1 truncate">{alert.message}</span>
          <span className="text-muted-foreground/50 shrink-0 text-[10px]">
            {timeAgo(alert.detectedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- Main Panel ---

export function EvaluationMetricsPanel() {
  const { metrics, isLoading, error } = useEvaluationMetrics();

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4 animate-pulse">
        <div className="h-4 w-48 bg-muted rounded mb-3" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-3 w-full bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <p className="text-sm text-muted-foreground/60">
          Failed to load evaluation metrics.
        </p>
      </div>
    );
  }

  const sections = [
    { title: "Failure Attribution", content: <FailureAttributionSection data={metrics?.failureAttribution ?? []} /> },
    { title: "Cost per Work Item Trend", content: <CostTrendSection data={metrics?.costTrend ?? []} /> },
    { title: "Reasoning Quality", content: <ReasoningQualitySection data={metrics?.reasoningQuality} /> },
    { title: "Drift Detection Alerts", content: <DriftAlertsSection data={metrics?.driftAlerts ?? []} /> },
  ];

  return (
    <div className="rounded-xl card-elevated overflow-hidden bg-surface-1 divide-y divide-border">
      {sections.map((section) => (
        <div key={section.title}>
          <div className="px-4 pt-3 pb-1">
            <div className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
              {section.title}
            </div>
          </div>
          {section.content}
        </div>
      ))}
    </div>
  );
}
