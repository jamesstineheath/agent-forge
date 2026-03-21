"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { Plan } from "@/lib/types";

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

export default function PlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("");

  useEffect(() => {
    const fetchPlans = () => {
      const url = filter ? `/api/plans?status=${filter}` : "/api/plans";
      fetch(url)
        .then((r) => r.json())
        .then((data) => setPlans(data.plans ?? []))
        .catch(() => setPlans([]))
        .finally(() => setLoading(false));
    };

    fetchPlans();
    const interval = setInterval(fetchPlans, 30000);
    return () => clearInterval(interval);
  }, [filter]);

  const handleRetrigger = async (planId: string) => {
    try {
      await fetch(`/api/plans/${planId}/retrigger`, { method: "POST" });
      // Refresh
      const r = await fetch(filter ? `/api/plans?status=${filter}` : "/api/plans");
      const data = await r.json();
      setPlans(data.plans ?? []);
    } catch {
      // Silent fail
    }
  };

  // Summary counts
  const counts = plans.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const totalCost = plans.reduce((sum, p) => sum + (p.actualCost ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Plans</h1>
        <p className="text-muted-foreground">Pipeline v2: One plan per PRD, one branch, one PR.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {(["ready", "executing", "reviewing", "complete", "failed"] as const).map((status) => (
          <button
            key={status}
            onClick={() => setFilter(filter === status ? "" : status)}
            className={`rounded-lg border p-4 text-left transition-colors hover:bg-accent ${filter === status ? "ring-2 ring-primary" : ""}`}
          >
            <div className="text-2xl font-bold">{counts[status] ?? 0}</div>
            <div className="text-sm text-muted-foreground capitalize">{status.replace(/_/g, " ")}</div>
          </button>
        ))}
      </div>

      {/* Total cost */}
      {totalCost > 0 && (
        <div className="text-sm text-muted-foreground">
          Total actual cost: <span className="font-medium">${totalCost.toFixed(2)}</span>
        </div>
      )}

      {/* Plans table */}
      {loading ? (
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
                <tr key={plan.id} className="border-b hover:bg-muted/30">
                  <td className="p-3">
                    <Link href={`/plans/${plan.id}`} className="font-medium hover:underline">{plan.prdId}</Link>
                    <div className="text-xs text-muted-foreground truncate max-w-[200px]">{plan.prdTitle}</div>
                  </td>
                  <td className="p-3"><StatusBadge status={plan.status} /></td>
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
                  <td className="p-3 text-right">{plan.actualCost ? `$${plan.actualCost.toFixed(2)}` : "-"}</td>
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
