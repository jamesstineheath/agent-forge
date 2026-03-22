"use client";

import { Shield, ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import { useSecurityAlerts } from "@/lib/hooks";
import type { SecurityAlertSummary, SeverityCounts } from "@/lib/security";

function SeverityBar({ counts }: { counts: SeverityCounts }) {
  const { critical, high, medium, low } = counts;
  const total = critical + high + medium + low;
  if (total === 0) return <span className="text-[10px] text-muted-foreground/60">None</span>;

  return (
    <div className="flex items-center gap-1.5">
      {critical > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">
          {critical} critical
        </span>
      )}
      {high > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-100 text-orange-700">
          {high} high
        </span>
      )}
      {medium > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-yellow-100 text-yellow-700">
          {medium} med
        </span>
      )}
      {low > 0 && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-500">
          {low} low
        </span>
      )}
    </div>
  );
}

function RepoAlertRow({ summary }: { summary: SecurityAlertSummary }) {
  const repoShort = summary.repo.split("/").pop() ?? summary.repo;
  const depTotal = summary.dependabot.critical + summary.dependabot.high + summary.dependabot.medium + summary.dependabot.low;
  const csTotal = summary.codeScanning.critical + summary.codeScanning.high + summary.codeScanning.medium + summary.codeScanning.low;

  return (
    <div className="space-y-2 py-2.5 border-b border-border/40 last:border-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">{repoShort}</span>
        {summary.totalOpen === 0 ? (
          <ShieldCheck size={14} className="text-green-500" />
        ) : (
          <span className="text-[10px] font-bold tabular-nums text-muted-foreground">
            {summary.totalOpen} open
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
            Dependabot ({depTotal})
          </p>
          <SeverityBar counts={summary.dependabot} />
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
            CodeQL ({csTotal})
          </p>
          <SeverityBar counts={summary.codeScanning} />
        </div>
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-0.5">
            Secrets
          </p>
          {summary.secretScanning.open > 0 ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">
              {summary.secretScanning.open} exposed
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/60">None</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SecuritySummary() {
  const { data, isLoading, error } = useSecurityAlerts();

  if (isLoading) {
    return (
      <div className="space-y-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Security
        </h2>
        <div className="rounded-xl card-elevated bg-surface-1 p-4 h-20 animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-3">
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Security
        </h2>
        <div className="rounded-xl card-elevated bg-surface-1 p-4">
          <p className="text-xs text-muted-foreground">Unable to load security alerts</p>
        </div>
      </div>
    );
  }

  const hasAlerts = data.totalAlerts > 0;
  const Icon = hasAlerts ? ShieldAlert : Shield;
  const iconColor = hasAlerts ? "text-amber-500" : "text-green-500";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        <div className={`relative flex h-6 w-6 items-center justify-center rounded-lg ${hasAlerts ? "bg-amber-500/15" : "bg-green-500/15"}`}>
          <Icon className={`h-3.5 w-3.5 ${iconColor}`} />
        </div>
        <h2 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          Security Posture
        </h2>
        {hasAlerts && (
          <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold tabular-nums text-white">
            {data.totalAlerts}
          </span>
        )}
      </div>
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        {data.repos.length === 0 ? (
          <p className="text-xs text-muted-foreground">No repos registered</p>
        ) : (
          <div className="divide-y-0">
            {data.repos.map((summary) => (
              <RepoAlertRow key={summary.repo} summary={summary} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
