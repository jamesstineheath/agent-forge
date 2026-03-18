"use client";

import { useDebateStats } from "@/lib/hooks";

export function DebateStatsCard() {
  const { data: stats, isLoading, error } = useDebateStats();

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          Debate Reviews
        </p>
        <p className="text-xs text-muted-foreground/60">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          Debate Reviews
        </p>
        <p className="text-xs text-muted-foreground/60">Failed to load debate stats.</p>
      </div>
    );
  }

  const total = stats?.totalSessions ?? 0;
  const dist = stats?.verdictDistribution ?? {};

  return (
    <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
        Debate Reviews
      </p>
      {total === 0 ? (
        <p className="text-xs text-muted-foreground/60">No debate sessions yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground/60">Sessions</p>
              <p className="text-lg font-bold font-display">{total}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/60">Avg Rounds</p>
              <p className="text-lg font-bold font-display">{stats?.avgRounds ?? 0}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/60">Avg Tokens</p>
              <p className="text-lg font-bold font-display">{(stats?.avgTokens ?? 0).toLocaleString()}</p>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60 mb-1.5">Verdicts</p>
            <div className="flex gap-3 text-[11px]">
              <span className="text-status-merged font-medium">{dist.approve ?? 0} approved</span>
              <span className="text-status-executing font-medium">{dist.request_changes ?? 0} changes</span>
              <span className="text-status-blocked font-medium">{dist.escalate ?? 0} escalated</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
