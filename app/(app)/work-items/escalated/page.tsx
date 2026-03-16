"use client";

import { useState } from "react";
import { useWorkItems, useWorkItem } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

export default function EscalatedItemsPage() {
  const { data: entries, isLoading, error, mutate } = useWorkItems({ status: "escalated" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Escalated Items</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {entries?.length ?? 0} item{entries?.length !== 1 ? "s" : ""} awaiting
          resolution
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : error ? (
        <p className="text-sm text-red-600">Failed to load escalated items.</p>
      ) : !entries || entries.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <p className="text-lg">No escalated items</p>
          <p className="text-sm mt-2">
            All clear — no items need manual intervention.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {entries.map((entry) => (
            <EscalatedItemCard
              key={entry.id}
              itemId={entry.id}
              onUpdated={mutate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EscalatedItemCard({
  itemId,
  onUpdated,
}: {
  itemId: string;
  onUpdated: () => void;
}) {
  const { data: item, isLoading } = useWorkItem(itemId);
  const [retryOpen, setRetryOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [budgetOverride, setBudgetOverride] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (isLoading || !item) {
    return (
      <div className="border border-orange-200 rounded-lg bg-orange-50 p-5 animate-pulse">
        <div className="h-5 bg-orange-100 rounded w-1/3" />
      </div>
    );
  }

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const body: Record<string, unknown> = {};
      if (budgetOverride.trim()) {
        body.budget = parseFloat(budgetOverride);
      }

      const res = await fetch(`/api/work-items/${item.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        setRetryError(err.error ?? "Retry failed");
        return;
      }

      onUpdated();
    } catch {
      setRetryError("Network error");
    } finally {
      setRetrying(false);
    }
  };

  const escalationReason = item.escalation?.reason ?? "—";
  const escalatedAt = item.escalation?.blockedAt ?? null;
  const budget = item.handoff?.budget ?? "—";
  const triggeredBy = item.triggeredBy ?? "—";
  const targetRepo = item.targetRepo ?? "—";

  return (
    <div className="border border-orange-200 rounded-lg bg-orange-50 p-5 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-gray-900 truncate">
            {item.title}
          </h2>
          <p className="text-sm text-gray-600 mt-1 line-clamp-3">
            {item.description}
          </p>
        </div>
        <span className="shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-300">
          escalated
        </span>
      </div>

      {/* Metadata grid */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-gray-500">Target Repo</dt>
          <dd className="text-gray-900 font-mono text-xs">{targetRepo}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Triggered By</dt>
          <dd className="text-gray-900">{triggeredBy}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Original Budget</dt>
          <dd className="text-gray-900">${budget}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Escalated At</dt>
          <dd className="text-gray-900">
            {escalatedAt ? new Date(escalatedAt).toLocaleString() : "—"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-gray-500">Escalation Reason</dt>
          <dd className="text-gray-900 mt-0.5 bg-white border border-orange-200 rounded p-2 text-sm">
            {escalationReason}
          </dd>
        </div>
      </dl>

      {/* Action buttons */}
      <div className="flex gap-3 pt-1">
        <button
          onClick={() => {
            setRetryOpen(!retryOpen);
            setPromoteOpen(false);
          }}
          className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Retry
        </button>
        <button
          onClick={() => {
            setPromoteOpen(!promoteOpen);
            setRetryOpen(false);
          }}
          className="px-3 py-1.5 rounded-md bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition-colors"
        >
          Promote to Project
        </button>
      </div>

      {/* Retry panel */}
      {retryOpen && (
        <div className="bg-white border border-blue-200 rounded-md p-4 space-y-3">
          <p className="text-sm text-gray-700 font-medium">
            Retry — transition back to{" "}
            <code className="bg-gray-100 px-1 rounded">filed</code>
          </p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Budget override (optional, leave blank to keep ${budget})
            </label>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-sm">$</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder={String(budget)}
                value={budgetOverride}
                onChange={(e) => setBudgetOverride(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          {retryError && <p className="text-sm text-red-600">{retryError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {retrying ? "Retrying\u2026" : "Confirm Retry"}
            </button>
            <button
              onClick={() => {
                setRetryOpen(false);
                setRetryError(null);
                setBudgetOverride("");
              }}
              className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Promote panel */}
      {promoteOpen && (
        <div className="bg-white border border-purple-200 rounded-md p-4 space-y-3">
          <p className="text-sm text-gray-700 font-medium">
            Promote to Project
          </p>
          <p className="text-xs text-gray-500">
            Copy the description below and paste it into a new Notion project
            plan.
          </p>
          <textarea
            readOnly
            value={item.description}
            rows={5}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm font-mono bg-gray-50 focus:outline-none resize-y"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <p className="text-xs text-gray-400">
            Click the textarea to select all text for copying.
          </p>
          <button
            onClick={() => setPromoteOpen(false)}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
