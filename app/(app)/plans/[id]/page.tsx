"use client";

import { useState, useEffect, use } from "react";
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

function ProgressBar({ complete, total }: { complete: number; total: number }) {
  const pct = total > 0 ? Math.round((complete / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{complete} of {total} criteria complete</span>
        <span className="text-muted-foreground">{pct}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2.5">
        <div
          className="bg-purple-600 h-2.5 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString();
}

export default function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchPlan = () => {
      fetch(`/api/plans/${id}`)
        .then((r) => {
          if (!r.ok) throw new Error("Plan not found");
          return r.json();
        })
        .then((data) => {
          if (!cancelled) setPlan(data);
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    fetchPlan();

    // Auto-refresh every 30 seconds for executing plans
    const interval = setInterval(fetchPlan, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id]);

  if (loading) return <div className="text-muted-foreground p-6">Loading plan...</div>;
  if (error || !plan) return <div className="text-red-500 p-6">{error ?? "Plan not found"}</div>;

  const progress = plan.progress;
  const isExecuting = plan.status === "executing";
  const showWaiting = isExecuting && !progress;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/plans" className="text-sm text-muted-foreground hover:underline">
          Plans
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-bold">{plan.prdId}: {plan.prdTitle}</h1>
      </div>

      {/* Status + metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Status</div>
          <div className="mt-1"><StatusBadge status={plan.status} /></div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Repository</div>
          <div className="mt-1 text-sm font-medium">{plan.targetRepo}</div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Budget</div>
          <div className="mt-1 text-sm font-medium">
            {plan.actualCost ? `$${plan.actualCost.toFixed(2)}` : "-"} / ${plan.estimatedBudget?.toFixed(0) ?? "-"}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">PR</div>
          <div className="mt-1 text-sm">
            {plan.prUrl ? (
              <a href={plan.prUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                #{plan.prNumber}
              </a>
            ) : "-"}
          </div>
        </div>
      </div>

      {/* Progress section */}
      {showWaiting && (
        <div className="rounded-lg border p-6 bg-purple-50">
          <div className="flex items-center gap-2">
            <div className="animate-pulse h-3 w-3 rounded-full bg-purple-500" />
            <span className="text-sm font-medium text-purple-800">
              Executing — waiting for first checkpoint
            </span>
          </div>
          <p className="mt-2 text-xs text-purple-600">
            Progress will appear once the agent commits its first PLAN_STATUS.md checkpoint.
          </p>
        </div>
      )}

      {progress && (
        <div className="space-y-4">
          {/* Progress bar */}
          {progress.criteriaTotal > 0 && (
            <div className="rounded-lg border p-4">
              <ProgressBar complete={progress.criteriaComplete} total={progress.criteriaTotal} />
            </div>
          )}

          {/* Current state */}
          {progress.currentState && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-2">Current State</h3>
              <p className="text-sm text-muted-foreground">{progress.currentState}</p>
            </div>
          )}

          {/* Issues */}
          {progress.issues.length > 0 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-2">Issues</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                {progress.issues.map((issue, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-red-500 shrink-0">!</span>
                    {issue}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Decisions */}
          {progress.decisions.length > 0 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-2">Decisions</h3>
              <ul className="text-sm text-muted-foreground space-y-1">
                {progress.decisions.map((decision, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-blue-500 shrink-0">-</span>
                    {decision}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Commit timeline */}
          {progress.commits.length > 0 && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-3">Commits ({progress.commits.length})</h3>
              <div className="space-y-2">
                {progress.commits.map((commit) => (
                  <div key={commit.sha} className="flex items-start gap-3 text-sm">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono shrink-0">
                      {commit.sha}
                    </code>
                    <span className="text-muted-foreground flex-1 truncate">{commit.message}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {new Date(commit.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Last updated */}
          {progress.lastUpdated && (
            <div className="text-xs text-muted-foreground">
              Progress last updated: {formatTimestamp(progress.lastUpdated)}
            </div>
          )}
        </div>
      )}

      {/* Error log */}
      {plan.errorLog && (
        <div className="rounded-lg border border-red-200 p-4 bg-red-50">
          <h3 className="text-sm font-medium text-red-800 mb-2">Error Log</h3>
          <pre className="text-xs text-red-700 whitespace-pre-wrap">{plan.errorLog}</pre>
        </div>
      )}
    </div>
  );
}
