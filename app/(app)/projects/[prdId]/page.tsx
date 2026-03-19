"use client";

import { useIntentCriteria } from "@/lib/hooks";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw, CheckCircle2, XCircle, Clock, SkipForward } from "lucide-react";
import { useState } from "react";
import type { CriterionStatus, CriterionType } from "@/lib/types";

const statusConfig: Record<CriterionStatus, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pending: { icon: Clock, color: "text-gray-400", label: "Pending" },
  passed: { icon: CheckCircle2, color: "text-green-500", label: "Passed" },
  failed: { icon: XCircle, color: "text-red-500", label: "Failed" },
  skipped: { icon: SkipForward, color: "text-yellow-500", label: "Skipped" },
};

const typeColors: Record<CriterionType, string> = {
  ui: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  api: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  data: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  integration: "bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300",
  performance: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
};

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const prdId = params.prdId as string;
  const { data, isLoading, mutate } = useIntentCriteria(prdId);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetch(`/api/intent-criteria/${prdId}`, { method: "POST" });
      mutate();
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) {
    return <div className="text-center text-muted-foreground py-12">Loading criteria...</div>;
  }

  if (!data) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Criteria not found for this PRD.</p>
        <button onClick={() => router.push("/projects")} className="mt-4 text-primary hover:underline">
          Back to projects
        </button>
      </div>
    );
  }

  const progress = data.criteria.length > 0
    ? Math.round((data.passedCount / data.criteria.length) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-header sticky top-0 z-10 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/projects")} className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <h1 className="text-2xl font-bold">{data.prdTitle}</h1>
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                {data.projectId && <span>{data.projectId}</span>}
                {data.targetRepo && <span>{data.targetRepo}</span>}
                {data.priority && <span>Priority: {data.priority}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {data.notionUrl && (
              <a
                href={data.notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-accent"
              >
                <ExternalLink className="h-4 w-4" />
                Notion
              </a>
            )}
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh from Notion
            </button>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Total Criteria</div>
          <div className="text-2xl font-bold">{data.criteria.length}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Passed</div>
          <div className="text-2xl font-bold text-green-500">{data.passedCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Failed</div>
          <div className="text-2xl font-bold text-red-500">{data.failedCount}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="text-sm text-muted-foreground">Est. Cost</div>
          <div className="text-2xl font-bold">${data.totalEstimatedCost.toFixed(0)}</div>
        </div>
      </div>

      {/* Progress bar */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">Criteria Progress</span>
          <span className="text-sm text-muted-foreground">{progress}%</span>
        </div>
        <div className="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Criteria table */}
      <div className="rounded-lg border bg-card">
        <div className="p-4 border-b">
          <h2 className="font-semibold">Acceptance Criteria</h2>
          <p className="text-sm text-muted-foreground">
            Imported {new Date(data.notionSyncedAt).toLocaleDateString()} at{" "}
            {new Date(data.notionSyncedAt).toLocaleTimeString()}
          </p>
        </div>
        <div className="divide-y">
          {data.criteria.map((criterion) => {
            const config = statusConfig[criterion.status];
            const StatusIcon = config.icon;
            return (
              <div key={criterion.id} className="flex items-start gap-3 p-4">
                <StatusIcon className={`h-5 w-5 mt-0.5 ${config.color}`} />
                <div className="flex-1">
                  <p className="text-sm">{criterion.description}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${typeColors[criterion.type]}`}>
                      {criterion.type}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Est. ${criterion.estimatedCost.toFixed(2)}
                    </span>
                    {criterion.evidence && (
                      <span className="text-xs text-muted-foreground">
                        {criterion.evidence}
                      </span>
                    )}
                    {criterion.verifiedAt && (
                      <span className="text-xs text-muted-foreground">
                        Verified {new Date(criterion.verifiedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <span className={`text-xs font-medium ${config.color}`}>{config.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
