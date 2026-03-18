"use client";

interface ProgressBarProps {
  total: number;
  completed: number;
  executing: number;
  failed: number;
  blocked: number;
}

export function ProgressBar({
  total,
  completed,
  executing,
  failed,
  blocked,
}: ProgressBarProps) {
  if (total === 0) {
    return (
      <div className="text-xs text-muted-foreground/60">No work items yet</div>
    );
  }

  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <div className="w-full">
      <div className="flex h-1.5 rounded-full overflow-hidden bg-border/50">
        {completed > 0 && (
          <div
            className="bg-status-merged transition-all"
            style={{ width: pct(completed) }}
          />
        )}
        {executing > 0 && (
          <div
            className="bg-status-executing transition-all"
            style={{ width: pct(executing) }}
          />
        )}
        {failed > 0 && (
          <div
            className="bg-status-blocked transition-all"
            style={{ width: pct(failed) }}
          />
        )}
        {blocked > 0 && (
          <div
            className="bg-status-blocked/40 transition-all"
            style={{ width: pct(blocked) }}
          />
        )}
      </div>
      <div className="flex gap-3 mt-1.5 text-[10px] text-muted-foreground">
        {completed > 0 && (
          <span className="text-status-merged">{completed} done</span>
        )}
        {executing > 0 && (
          <span className="text-status-executing">{executing} running</span>
        )}
        {failed > 0 && (
          <span className="text-status-blocked">{failed} failed</span>
        )}
        {blocked > 0 && (
          <span className="text-status-blocked">{blocked} blocked</span>
        )}
        <span className="ml-auto font-mono tabular-nums">
          {completed}/{total}
        </span>
      </div>
    </div>
  );
}
