"use client";

import { QualityRing } from "@/components/quality-ring";

interface PAAgentRowProps {
  name: string;
  tier: string;
  assessmentTier: string;
  status: "active" | "idle";
}

export function PAAgentRow({ name, tier, assessmentTier, status }: PAAgentRowProps) {
  return (
    <div className="flex items-center gap-4 rounded-lg border bg-card p-3">
      <QualityRing rate={null} size={48} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{name}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {tier}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              status === "active"
                ? "bg-green-500/10 text-green-500"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {status === "active" ? "Active" : "Idle"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Assessment: {assessmentTier}
        </p>
      </div>
      <p className="text-xs text-muted-foreground italic">
        Metrics available when cross-repo evaluation API ships
      </p>
    </div>
  );
}
