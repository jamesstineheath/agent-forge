"use client";

import { useState } from "react";
import Link from "next/link";
import { usePlans } from "@/lib/hooks";
import type { PlanStatus } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  ready: "bg-blue-100 text-blue-800",
  dispatching: "bg-yellow-100 text-yellow-800",
  executing: "bg-purple-100 text-purple-800",
  reviewing: "bg-orange-100 text-orange-800",
  complete: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  timed_out: "bg-red-100 text-red-800",
  budget_exceeded: "bg-red-100 text-red-800",
  needs_review: "bg-amber-100 text-amber-800",
  parked: "bg-gray-100 text-gray-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status] ?? "bg-gray-100 text-gray-800"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const FILTER_STATUSES: PlanStatus[] = [
  "needs_review", "ready", "executing", "reviewing", "complete", "failed",
];

export default function PlansPage() {
  const [filter, setFilter] = useState<PlanStatus | "">("");
  const { plans, isLoading, mutate } = usePlans(
    filter ? { status: filter } : undefined
  );

  const handleRetrigger = async (planId: string) => {
    try {
      await fetch(`/api/plans/${planId}/retrigger`, { method: "POST" });
      mutate();
    } catch {
      // Silent fail
    }
  };

  // Summary counts (across all plans when no filter)
  const counts = plans.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalEstimatedCost = plans
    .filter((p) => p.status === "ready" || p.status === "executing")
    .reduce((sum, p) => sum + (p.estimatedBudget ?? 0), 0);

  const totalActualCost = plans
    .filter((p) => p.status === "complete")
    .reduce((sum, p) => sum + (p.actualCost ?? 0), 0);

  const needsReviewCount = counts["needs_review"] ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Plans</h1>
        <p className="text-muted-foreground">Pipeline v2: One plan per PRD, one branch, one PR.</p>
      </div>

      {/* AC3: Summary card */}
      <div className="rounded-lg border p-4 bg-muted/30">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-muted-foreground">Total Plans</div>
            <div className="text-2xl font-bold">{plans.length}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Active (ready + executing)</div>
            <div className="text-2xl font-bold">{(counts["ready"] ?? 0) + (counts["executing"] ?? 0)}</div>
            {totalEstimatedCost > 0 && (
              <div className="text-xs text-muted-foreground">Est. cost: ${totalEstimatedCost.toFixed(0)}</div>
            )}
          </div>
          <div>
            <div className="text-muted-foreground">Completed</div>
            <div className="text-2xl font-bold">{counts["complete"] ?? 0}</div>
            {totalActualCost > 0 && (
              <div className="text-xs text-muted-foreground">Actual cost: ${totalActualCost.toFixed(2)}</div>
            )}
          </div>
          <div>
            <div className="text-muted-foreground">Failed / Timed Out</div>
            <div className="text-2xl font-bold text-red-600">
              {(counts["failed"] ?? 0) + (counts["timed_out"] ?? 0) + (counts["budget_exceeded"] ?? 0)}
            </div>
          </div>
        </div>
      </div>

      {/* Status filter chips */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter("")}
          className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${!filter ? "ring-2 ring-primary bg-primary/10" : "hover:bg-accent"}`}
        >
          All
        </button>
        {FILTER_STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => setFilter(filter === status ? "" : status)}
            className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${filter === status ? "ring-2 ring-primary bg-primary/10" : "hover:bg-accent"} ${status === "needs_review" && needsReviewCount > 0 ? "border-amber-400 bg-amber-50" : ""}`}
          >
            {status.replace(/_/g, " ")}
            <span className="ml-1 font-medium">{counts[status] ?? 0}</span>
            {/* AC2: attention indicator */}
            {status === "needs_review" && needsReviewCount > 0 && (
              <span className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            )}
          </button>
        ))}
      </div>

      {/* Plans table */}
      {isLoading ? (
        <div className="text-muted-foreground">Loading plans...</div>
      ) : plans.length === 0 ? (
        <div className="text-muted-foreground">No plans found{filter ? ` with status "${filter}"` : ""}.</div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">PRD</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-left p-3 font-medium">Progress</th>
                <th className="text-left p-3 font-medium">Repo</th>
                <th className="text-left p-3 font-medium">Branch</th>
                <th className="text-left p-3 font-medium">PR</th>
                <th className="text-right p-3 font-medium">Budget</th>
                <th className="text-right p-3 font-medium">Actual</th>
                <th className="text-right p-3 font-medium">Duration</th>
                <th className="text-center p-3 font-medium">Retries</th>
                <th className="text-left p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr
                  key={plan.id}
                  className={`border-b hover:bg-muted/30 ${plan.status === "needs_review" ? "bg-amber-50/50" : ""}`}
                >
                  <td className="p-3">
                    <Link href={`/plans/${plan.id}`} className="font-medium hover:underline">{plan.prdId}</Link>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">{plan.prdTitle}</div>
                  </td>
                  <td className="p-3">
                    <StatusBadge status={plan.status} />
                    {plan.status === "needs_review" && (
                      <span className="ml-1 inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    {plan.status === "executing" && plan.progress ? (
                      <Link href={`/plans/${plan.id}`} className="text-purple-600 font-medium hover:underline">
                        {plan.progress.criteriaComplete}/{plan.progress.criteriaTotal}
                      </Link>
                    ) : plan.status === "executing" ? (
                      <span className="text-muted-foreground italic">waiting...</span>
                    ) : plan.progress ? (
                      <Link href={`/plans/${plan.id}`} className="text-muted-foreground hover:underline">
                        {plan.progress.criteriaComplete}/{plan.progress.criteriaTotal}
                      </Link>
                    ) : "-"}
                  </td>
                  <td className="p-3 text-xs">{plan.targetRepo.split("/")[1] ?? plan.targetRepo}</td>
                  <td className="p-3 text-xs font-mono truncate max-w-[150px]">{plan.branchName}</td>
                  <td className="p-3">
                    {plan.prUrl ? (
                      <a href={plan.prUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        #{plan.prNumber}
                      </a>
                    ) : "-"}
                  </td>
                  <td className="p-3 text-right">${plan.estimatedBudget?.toFixed(0) ?? "-"}</td>
                  <td className="p-3 text-right">{plan.actualCost != null ? `$${plan.actualCost.toFixed(2)}` : "-"}</td>
                  <td className="p-3 text-right">{formatDuration(plan.startedAt, plan.completedAt)}</td>
                  <td className="p-3 text-center">{plan.retryCount > 0 ? plan.retryCount : "-"}</td>
                  <td className="p-3">
                    {(plan.status === "failed" || plan.status === "timed_out" || plan.status === "budget_exceeded") && (
                      <button
                        onClick={() => handleRetrigger(plan.id)}
                        className="text-xs px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600"
                      >
                        Retry
                      </button>
                    )}
                    {plan.status === "needs_review" && (
                      <Link
                        href={`/plans/${plan.id}`}
                        className="text-xs px-2 py-1 bg-amber-500 text-white rounded hover:bg-amber-600"
                      >
                        Review
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
