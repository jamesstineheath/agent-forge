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
      <div className="text-xs text-zinc-500">No work items yet</div>
    );
  }

  const pct = (n: number) => `${(n / total) * 100}%`;

  return (
    <div className="w-full">
      <div className="flex h-2 rounded-full overflow-hidden bg-zinc-800">
        {completed > 0 && (
          <div
            className="bg-emerald-500 transition-all"
            style={{ width: pct(completed) }}
          />
        )}
        {executing > 0 && (
          <div
            className="bg-amber-500 transition-all"
            style={{ width: pct(executing) }}
          />
        )}
        {failed > 0 && (
          <div
            className="bg-red-500 transition-all"
            style={{ width: pct(failed) }}
          />
        )}
        {blocked > 0 && (
          <div
            className="bg-orange-500/40 transition-all"
            style={{ width: pct(blocked) }}
          />
        )}
      </div>
      <div className="flex gap-3 mt-1.5 text-xs text-zinc-400">
        {completed > 0 && (
          <span className="text-emerald-400">{completed} done</span>
        )}
        {executing > 0 && (
          <span className="text-amber-400">{executing} running</span>
        )}
        {failed > 0 && (
          <span className="text-red-400">{failed} failed</span>
        )}
        {blocked > 0 && (
          <span className="text-orange-400">{blocked} blocked</span>
        )}
        <span className="ml-auto">
          {completed}/{total}
        </span>
      </div>
    </div>
  );
}
