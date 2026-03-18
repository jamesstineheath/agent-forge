"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

interface ChangeRecord {
  date: string;
  pattern_id: string;
  description: string;
  target_file: string;
  pr_number: number | null;
  pr_url: string | null;
  status: "proposed" | "merged" | "rejected" | "reverted";
  effective: boolean | null;
  follow_up_notes: string;
}

interface CompilerHistory {
  changes: ChangeRecord[];
  last_run: string;
}

const STATUS_STYLES: Record<string, string> = {
  proposed: "bg-status-executing/10 text-status-executing border-status-executing/20",
  merged: "bg-status-merged/10 text-status-merged border-status-merged/20",
  rejected: "bg-status-blocked/10 text-status-blocked border-status-blocked/20",
  reverted: "bg-secondary text-muted-foreground border-border",
};

export default function FeedbackCompilerPage() {
  const [history, setHistory] = useState<CompilerHistory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/feedback-compiler/history")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setHistory(data))
      .catch(() => setHistory(null))
      .finally(() => setLoading(false));
  }, []);

  const changes = history?.changes ?? [];
  const proposedCount = changes.filter((c) => c.status === "proposed").length;
  const mergedCount = changes.filter((c) => c.status === "merged").length;
  const rejectedCount = changes.filter((c) => c.status === "rejected").length;
  const effectiveCount = changes.filter((c) => c.effective === true).length;
  const ineffectiveCount = changes.filter((c) => c.effective === false).length;

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">
              Feedback Compiler
            </h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              TLM self-improvement loop
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              Last run: {history?.last_run || "never"}
            </span>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {/* Agent Health Scores */}
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Overview
            </p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: "Proposed", value: proposedCount, color: "text-status-executing" },
                { label: "Merged", value: mergedCount, color: "text-status-merged" },
                { label: "Rejected", value: rejectedCount, color: "text-status-blocked" },
                { label: "Effective", value: effectiveCount, color: "text-status-merged" },
                { label: "Ineffective", value: ineffectiveCount, color: "text-status-blocked" },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="rounded-xl card-elevated bg-surface-1 p-3.5 ring-1 ring-border"
                >
                  <div className={cn("text-2xl font-bold font-mono", stat.color)}>
                    {loading ? "-" : stat.value}
                  </div>
                  <div className="text-[10px] text-muted-foreground/60 mt-0.5">
                    {stat.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Change History */}
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              Change History
            </p>
            {loading ? (
              <div className="text-xs text-muted-foreground/60">Loading...</div>
            ) : changes.length === 0 ? (
              <div className="rounded-xl card-elevated bg-surface-1 p-6 ring-1 ring-border text-center">
                <p className="text-sm text-muted-foreground">
                  No changes yet. The Feedback Compiler runs weekly on Sunday at 10pm UTC.
                </p>
              </div>
            ) : (
              <div className="rounded-xl card-elevated bg-surface-1 ring-1 ring-border divide-y divide-border">
                {[...changes].reverse().map((change, i) => (
                  <div key={i} className="p-3.5">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span className="text-[10px] text-muted-foreground/60 font-mono">
                        {change.date}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] font-bold px-1.5 py-0.5 rounded-full border",
                          STATUS_STYLES[change.status] ?? STATUS_STYLES.reverted
                        )}
                      >
                        {change.status}
                      </span>
                      {change.effective !== null && (
                        <span
                          className={cn(
                            "text-[10px] font-bold px-1.5 py-0.5 rounded-full border",
                            change.effective
                              ? "bg-status-merged/10 text-status-merged border-status-merged/20"
                              : "bg-status-blocked/10 text-status-blocked border-status-blocked/20"
                          )}
                        >
                          {change.effective ? "effective" : "ineffective"}
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] font-medium text-foreground">
                      {change.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 mt-1 text-[10px] text-muted-foreground/60">
                      <span className="font-mono">{change.pattern_id}</span>
                      <span className="font-mono">{change.target_file}</span>
                      {change.pr_url && (
                        <a
                          href={change.pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:text-primary/80"
                        >
                          PR #{change.pr_number}
                        </a>
                      )}
                    </div>
                    {change.follow_up_notes && (
                      <p className="text-[10px] text-muted-foreground/40 mt-1">
                        {change.follow_up_notes}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
