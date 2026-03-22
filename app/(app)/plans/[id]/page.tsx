"use client";

import { useState, use } from "react";
import Link from "next/link";
import { usePlan } from "@/lib/hooks";

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

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const minutes = Math.round((end - start) / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const RETRIGGERABLE = new Set(["failed", "timed_out", "budget_exceeded"]);
const AUTO_DISPATCH_CAP = 100; // dollars — matches dispatcher logic

export default function PlanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { plan, isLoading, error, mutate } = usePlan(id);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [retryFeedback, setRetryFeedback] = useState("");

  const handleApprove = async () => {
    if (!plan) return;
    setActionLoading("approve");
    try {
      await fetch(`/api/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      });
      mutate();
    } finally {
      setActionLoading(null);
    }
  };

  const handlePark = async () => {
    if (!plan) return;
    setActionLoading("park");
    try {
      await fetch(`/api/plans/${plan.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "parked" }),
      });
      mutate();
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetrigger = async () => {
    if (!plan) return;
    setActionLoading("retrigger");
    try {
      await fetch(`/api/plans/${plan.id}/retrigger`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewFeedback: retryFeedback.trim() || undefined,
        }),
      });
      setRetryFeedback("");
      mutate();
    } finally {
      setActionLoading(null);
    }
  };

  if (isLoading) return <div className="text-muted-foreground p-6">Loading plan...</div>;
  if (error || !plan) return <div className="text-red-500 p-6">{error?.message ?? "Plan not found"}</div>;

  const progress = plan.progress;
  const isExecuting = plan.status === "executing";
  const showWaiting = isExecuting && !progress;
  const githubBranchUrl = `https://github.com/${plan.targetRepo}/tree/${plan.branchName}`;

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

      {/* Status + metadata cards */}
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
          <div className="text-sm text-muted-foreground">Cost (actual / estimated)</div>
          <div className="mt-1 text-sm font-medium">
            {plan.actualCost != null ? `$${plan.actualCost.toFixed(2)}` : "-"}{" "}
            / ${plan.estimatedBudget?.toFixed(0) ?? "-"}
          </div>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground">Duration</div>
          <div className="mt-1 text-sm font-medium">
            {formatDuration(plan.startedAt, plan.completedAt)}
            {plan.maxDurationMinutes && (
              <span className="text-muted-foreground"> / {plan.maxDurationMinutes}m max</span>
            )}
          </div>
        </div>
      </div>

      {/* Branch & PR links */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground mb-1">Branch</div>
          <a
            href={githubBranchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-mono text-blue-600 hover:underline break-all"
          >
            {plan.branchName}
          </a>
        </div>
        <div className="rounded-lg border p-4">
          <div className="text-sm text-muted-foreground mb-1">Pull Request</div>
          {plan.prUrl ? (
            <a href={plan.prUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
              #{plan.prNumber} — View on GitHub
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">No PR yet</span>
          )}
        </div>
      </div>

      {/* Retry count */}
      {plan.retryCount > 0 && (
        <div className="text-sm text-muted-foreground">
          Retry count: <span className="font-medium">{plan.retryCount}</span>
        </div>
      )}

      {/* ── AC2: Review panel for needs_review ── */}
      {plan.status === "needs_review" && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-6 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-amber-900">Review Required</h3>
            <p className="text-sm text-amber-800 mt-1">
              Estimated budget ${plan.estimatedBudget?.toFixed(0) ?? "?"} exceeds ${AUTO_DISPATCH_CAP} auto-dispatch cap.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleApprove}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {actionLoading === "approve" ? "Approving..." : "Approve & Dispatch"}
            </button>
            <button
              onClick={handlePark}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-gray-500 text-white text-sm font-medium rounded-md hover:bg-gray-600 disabled:opacity-50"
            >
              {actionLoading === "park" ? "Parking..." : "Park"}
            </button>
          </div>
        </div>
      )}

      {/* ── Acceptance Criteria ── */}
      {plan.acceptanceCriteria && (
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium mb-2">Acceptance Criteria</h3>
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap">{plan.acceptanceCriteria}</pre>
        </div>
      )}

      {/* ── KG Context (Affected Files) ── */}
      {plan.kgContext && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium">Knowledge Graph Context</h3>
          {plan.kgContext.affectedFiles?.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Affected Files ({plan.kgContext.affectedFiles.length})</div>
              <div className="flex flex-wrap gap-1">
                {plan.kgContext.affectedFiles.map((f) => (
                  <span key={f} className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{f}</span>
                ))}
              </div>
            </div>
          )}
          {plan.kgContext.relevantADRs?.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Relevant ADRs</div>
              <ul className="text-sm text-muted-foreground space-y-1">
                {plan.kgContext.relevantADRs.map((adr, i) => (
                  <li key={i} className="flex gap-2">
                    <StatusBadge status={adr.status} />
                    <span>{adr.title}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {plan.kgContext.systemMapSections && (
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">System Map Sections</div>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{plan.kgContext.systemMapSections}</pre>
            </div>
          )}
        </div>
      )}

      {/* Also show affectedFiles if present but kgContext is not */}
      {!plan.kgContext && plan.affectedFiles && plan.affectedFiles.length > 0 && (
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium mb-2">Affected Files</h3>
          <div className="flex flex-wrap gap-1">
            {plan.affectedFiles.map((f) => (
              <span key={f} className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{f}</span>
            ))}
          </div>
        </div>
      )}

      {/* ── Progress section ── */}
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
          {progress.criteriaTotal > 0 && (
            <div className="rounded-lg border p-4">
              <ProgressBar complete={progress.criteriaComplete} total={progress.criteriaTotal} />
            </div>
          )}

          {progress.currentState && (
            <div className="rounded-lg border p-4">
              <h3 className="text-sm font-medium mb-2">Current State</h3>
              <p className="text-sm text-muted-foreground">{progress.currentState}</p>
            </div>
          )}

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

          {progress.lastUpdated && (
            <div className="text-xs text-muted-foreground">
              Progress last updated: {new Date(progress.lastUpdated).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* ── AC4: Error log + retry for failed plans ── */}
      {plan.errorLog && (
        <div className="rounded-lg border border-red-200 p-4 bg-red-50">
          <h3 className="text-sm font-medium text-red-800 mb-2">Error Log</h3>
          <pre className="text-xs text-red-700 whitespace-pre-wrap max-h-80 overflow-y-auto">{plan.errorLog}</pre>
        </div>
      )}

      {RETRIGGERABLE.has(plan.status) && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium">Retry Plan</h3>
          <textarea
            value={retryFeedback}
            onChange={(e) => setRetryFeedback(e.target.value)}
            placeholder="Optional: feedback for the next execution attempt..."
            className="w-full text-sm border rounded-md p-2 h-20 resize-y"
          />
          <button
            onClick={handleRetrigger}
            disabled={actionLoading !== null}
            className="px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded-md hover:bg-blue-600 disabled:opacity-50"
          >
            {actionLoading === "retrigger" ? "Retrying..." : `Retry (attempt #${plan.retryCount + 1})`}
          </button>
        </div>
      )}

      {/* Review feedback from previous retry */}
      {plan.reviewFeedback && (
        <div className="rounded-lg border p-4">
          <h3 className="text-sm font-medium mb-2">Review Feedback (from last retry)</h3>
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap">{plan.reviewFeedback}</pre>
        </div>
      )}
    </div>
  );
}
