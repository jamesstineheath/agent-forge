"use client";

import { useIntentCriteria } from "@/lib/hooks";
import { WaveProgress } from "@/components/wave-progress";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, RefreshCw, CheckCircle2, XCircle, Clock, SkipForward, FileCode2, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import type { CriterionStatus, CriterionType, ArchitecturePlan } from "@/lib/types";

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
  const { data: plan } = useSWR<ArchitecturePlan>(
    `/api/intent-criteria/${prdId}/plan`,
    (url: string) => fetch(url).then((r) => r.ok ? r.json() : null),
    { refreshInterval: 30000 }
  );
  const [refreshing, setRefreshing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);

  const handleGeneratePlan = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/intent-criteria/${prdId}/plan?decompose=true`, { method: "POST" });
      if (res.ok) {
        mutate();
      }
    } finally {
      setGenerating(false);
    }
  };

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
            {!plan && data.criteria.length > 0 && (
              <button
                onClick={handleGeneratePlan}
                disabled={generating}
                className="flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                <FileCode2 className={`h-4 w-4 ${generating ? "animate-pulse" : ""}`} />
                {generating ? "Generating..." : "Generate Plan & Execute"}
              </button>
            )}
            {plan && (
              <button
                onClick={handleGeneratePlan}
                disabled={generating}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
              >
                <FileCode2 className={`h-4 w-4 ${generating ? "animate-pulse" : ""}`} />
                {generating ? "Regenerating..." : "Regenerate Plan"}
              </button>
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

      {/* Wave Progress */}
      {data.projectId && (
        <WaveProgress projectId={data.projectId} />
      )}

      {/* Architecture Plan */}
      {plan && (
        <div className="rounded-lg border bg-card">
          <button
            onClick={() => setPlanExpanded(!planExpanded)}
            className="w-full flex items-center justify-between p-4 hover:bg-accent/50"
          >
            <div className="flex items-center gap-2">
              <FileCode2 className="h-5 w-5 text-muted-foreground" />
              <div className="text-left">
                <h2 className="font-semibold">Architecture Plan</h2>
                <p className="text-sm text-muted-foreground">
                  v{plan.version} — {plan.criterionPlans.length} criterion plans, est. {plan.estimatedWorkItems} work items, ${plan.totalEstimatedCost}
                  {plan.generatedBy === "gap-analysis" && " (gap analysis)"}
                </p>
              </div>
            </div>
            {planExpanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          </button>
          {planExpanded && (
            <div className="border-t divide-y">
              {plan.sharedTypes.length > 0 && (
                <div className="p-4">
                  <h3 className="text-sm font-medium mb-2">Shared Types</h3>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    {plan.sharedTypes.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              )}
              {plan.prerequisites.length > 0 && (
                <div className="p-4">
                  <h3 className="text-sm font-medium mb-2">Prerequisites</h3>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    {plan.prerequisites.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </div>
              )}
              {plan.riskAssessment && (
                <div className="p-4">
                  <h3 className="text-sm font-medium mb-2">Risk Assessment</h3>
                  <p className="text-sm text-muted-foreground">{plan.riskAssessment}</p>
                </div>
              )}
              {plan.criterionPlans.map((cp) => (
                <div key={cp.criterionId} className="p-4">
                  <p className="text-sm font-medium">{cp.criterionDescription}</p>
                  <p className="text-sm text-muted-foreground mt-1">{cp.approach}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {cp.filesToCreate.map((f) => (
                      <span key={f} className="px-2 py-0.5 rounded text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                        + {f}
                      </span>
                    ))}
                    {cp.filesToModify.map((f) => (
                      <span key={f} className="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300">
                        ~ {f}
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span>{cp.complexity}</span>
                    <span>Est. ${cp.estimatedCost}</span>
                    {cp.apiEndpoints.length > 0 && <span>{cp.apiEndpoints.length} endpoint(s)</span>}
                    {cp.dependencies.length > 0 && <span>{cp.dependencies.length} dep(s)</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
