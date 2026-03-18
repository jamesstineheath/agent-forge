"use client";

import { useState } from "react";
import { useWorkItems, useWorkItem } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

export default function EscalatedItemsPage() {
  const { data: entries, isLoading, error, mutate } = useWorkItems({ status: "escalated" });

  return (
    <>
      {/* Sticky glass header */}
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Escalated Items</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              {entries?.length ?? 0} item{entries?.length !== 1 ? "s" : ""} awaiting
              resolution
            </p>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-4xl space-y-4">
          {isLoading ? (
            <p className="text-[12px] text-muted-foreground">Loading...</p>
          ) : error ? (
            <p className="text-[12px] text-status-blocked">Failed to load escalated items.</p>
          ) : !entries || entries.length === 0 ? (
            <div className="rounded-xl card-elevated bg-surface-1 text-center py-16">
              <p className="text-sm font-display text-foreground">No escalated items</p>
              <p className="text-[12px] text-muted-foreground mt-2">
                All clear — no items need manual intervention.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
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
      </div>
    </>
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
      <div className="rounded-xl card-elevated bg-surface-1 border border-border p-5 animate-pulse">
        <div className="h-5 bg-muted rounded w-1/3" />
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

  const escalationReason = item.escalation?.reason ?? "\u2014";
  const escalatedAt = item.escalation?.blockedAt ?? null;
  const budget = item.handoff?.budget ?? "\u2014";
  const triggeredBy = item.triggeredBy ?? "\u2014";
  const targetRepo = item.targetRepo ?? "\u2014";

  return (
    <div className="rounded-xl card-elevated bg-surface-1 border border-border p-5 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="font-display font-semibold text-foreground truncate">
            {item.title}
          </h2>
          <p className="text-[12px] text-muted-foreground mt-1 line-clamp-3">
            {item.description}
          </p>
        </div>
        <span className="shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-status-reviewing/15 text-status-reviewing border border-status-reviewing/30">
          escalated
        </span>
      </div>

      {/* Metadata grid */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
        <div>
          <dt className="text-muted-foreground">Target Repo</dt>
          <dd className="text-foreground font-mono text-[11px]">{targetRepo}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Triggered By</dt>
          <dd className="text-foreground">{triggeredBy}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Original Budget</dt>
          <dd className="text-foreground">${budget}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Escalated At</dt>
          <dd className="text-foreground">
            {escalatedAt ? new Date(escalatedAt).toLocaleString() : "\u2014"}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">Escalation Reason</dt>
          <dd className="text-foreground mt-0.5 bg-muted border border-border rounded p-2 text-[12px]">
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
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium hover:bg-primary/90 transition-colors"
        >
          Retry
        </button>
        <button
          onClick={() => {
            setPromoteOpen(!promoteOpen);
            setRetryOpen(false);
          }}
          className="px-3 py-1.5 rounded-md bg-secondary text-secondary-foreground text-[12px] font-medium hover:bg-secondary/80 transition-colors"
        >
          Promote to Project
        </button>
      </div>

      {/* Retry panel */}
      {retryOpen && (
        <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-3">
          <p className="text-[12px] text-foreground font-medium">
            Retry — transition back to{" "}
            <code className="bg-muted px-1 rounded text-[11px]">filed</code>
          </p>
          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">
              Budget override (optional, leave blank to keep ${budget})
            </label>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[12px]">$</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder={String(budget)}
                value={budgetOverride}
                onChange={(e) => setBudgetOverride(e.target.value)}
                className="border border-border bg-surface-1 rounded px-2 py-1 text-[12px] text-foreground w-24 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          {retryError && <p className="text-[12px] text-status-blocked">{retryError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {retrying ? "Retrying\u2026" : "Confirm Retry"}
            </button>
            <button
              onClick={() => {
                setRetryOpen(false);
                setRetryError(null);
                setBudgetOverride("");
              }}
              className="px-3 py-1.5 rounded-md border border-border text-foreground text-[12px] font-medium hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Promote panel */}
      {promoteOpen && (
        <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-3">
          <p className="text-[12px] text-foreground font-medium">
            Promote to Project
          </p>
          <p className="text-[11px] text-muted-foreground">
            Copy the description below and paste it into a new Notion project
            plan.
          </p>
          <textarea
            readOnly
            value={item.description}
            rows={5}
            className="w-full border border-border bg-surface-1 rounded px-2 py-1 text-[12px] font-mono text-foreground focus:outline-none resize-y"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <p className="text-[11px] text-muted-foreground/60">
            Click the textarea to select all text for copying.
          </p>
          <button
            onClick={() => setPromoteOpen(false)}
            className="px-3 py-1.5 rounded-md border border-border text-foreground text-[12px] font-medium hover:bg-muted transition-colors"
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
