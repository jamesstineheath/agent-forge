"use client";

interface ConcurrencyGaugeProps {
  repoName: string;
  active: number;
  limit: number;
}

export function ConcurrencyGauge({ repoName, active, limit }: ConcurrencyGaugeProps) {
  const pct = limit > 0 ? Math.min((active / limit) * 100, 100) : 0;
  const shortName = repoName.split("/").pop() ?? repoName;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium truncate max-w-[120px]" title={repoName}>
          {shortName}
        </span>
        <span className="text-muted-foreground ml-2 flex-shrink-0">
          {active}/{limit}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-border/50 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
