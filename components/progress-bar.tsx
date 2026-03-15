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
      <p className="text-sm text-muted-foreground">No work items yet</p>
    );
  }

  const pct = (n: number) => (n / total) * 100;

  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
        {completed > 0 && (
          <div
            className="bg-emerald-500"
            style={{ width: `${pct(completed)}%` }}
          />
        )}
        {executing > 0 && (
          <div
            className="bg-amber-500"
            style={{ width: `${pct(executing)}%` }}
          />
        )}
        {failed > 0 && (
          <div
            className="bg-red-500"
            style={{ width: `${pct(failed)}%` }}
          />
        )}
        {blocked > 0 && (
          <div
            className="bg-orange-500"
            style={{ width: `${pct(blocked)}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <div className="flex gap-3">
          {completed > 0 && (
            <span className="text-emerald-600">{completed} done</span>
          )}
          {executing > 0 && (
            <span className="text-amber-600">{executing} running</span>
          )}
          {failed > 0 && (
            <span className="text-red-600">{failed} failed</span>
          )}
          {blocked > 0 && (
            <span className="text-orange-600">{blocked} blocked</span>
          )}
        </div>
        <span className="text-muted-foreground">
          {completed}/{total}
        </span>
      </div>
    </div>
  );
}
