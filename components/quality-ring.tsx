"use client";

interface QualityRingProps {
  rate: number | null;
  size?: number;
  label?: string;
}

export function QualityRing({ rate, size = 56, label }: QualityRingProps) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const fill = rate != null ? circ * (rate / 100) : 0;
  const color =
    rate == null
      ? "#52525b"
      : rate >= 80
        ? "#34d399"
        : rate >= 60
          ? "#fbbf24"
          : "#f87171";

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#27272a"
          strokeWidth={4}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={4}
          strokeDasharray={`${fill} ${circ - fill}`}
          strokeLinecap="round"
        />
      </svg>
      <span className="text-xs font-medium" style={{ color }}>
        {rate != null ? `${Math.round(rate)}%` : "n/a"}
      </span>
      {label && <span className="text-[10px] text-muted-foreground/50">{label}</span>}
    </div>
  );
}
