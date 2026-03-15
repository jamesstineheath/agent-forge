"use client";

interface QualityRingProps {
  rate: number | null;
  size?: number;
}

export function QualityRing({ rate, size = 80 }: QualityRingProps) {
  const strokeWidth = size * 0.1;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let color = "text-muted-foreground";
  let strokeColor = "stroke-muted";
  if (rate !== null) {
    if (rate >= 80) {
      color = "text-green-500";
      strokeColor = "stroke-green-500";
    } else if (rate >= 60) {
      color = "text-amber-500";
      strokeColor = "stroke-amber-500";
    } else {
      color = "text-red-500";
      strokeColor = "stroke-red-500";
    }
  }

  const progress = rate !== null ? circumference - (rate / 100) * circumference : circumference;

  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/30"
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={progress}
          strokeLinecap="round"
          className={strokeColor}
        />
      </svg>
      <span className={`text-sm font-semibold ${color}`}>
        {rate !== null ? `${Math.round(rate)}%` : "N/A"}
      </span>
    </div>
  );
}
