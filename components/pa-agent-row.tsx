"use client";

import { TrendingUp } from "lucide-react";
import { QualityRing } from "@/components/quality-ring";

interface PAAgentRowProps {
  name: string;
  tier: string;
  assessmentTier: string;
  status: "active" | "idle";
}

export function PAAgentRow({ name, tier, assessmentTier, status }: PAAgentRowProps) {
  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-zinc-800/30 transition-colors">
      <QualityRing rate={null} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-200">{name}</span>
          <span className="text-[10px] text-zinc-600">{tier}</span>
          {status === "active" && (
            <TrendingUp size={11} className="text-emerald-400" />
          )}
        </div>
        <div className="text-[11px] text-zinc-600">
          Assessment: {assessmentTier}
        </div>
      </div>
    </div>
  );
}
