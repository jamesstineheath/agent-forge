"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { GitPullRequest, Clock, Radio, Layers, Power, Loader2 } from "lucide-react";
import { PipelineStages } from "@/components/pipeline-stages";
import { BlockedSummary } from "@/components/blocked-summary";
import { DebateStatsCard } from "@/components/debate-stats-card";
import { useWorkItems, useRepos, useKillSwitch } from "@/lib/hooks";
import type { WorkItem } from "@/lib/types";

const ACTIVE_STATUSES: WorkItem["status"][] = ["generating", "executing", "reviewing"];

export default function PipelinePage() {
  const { data: workItems, isLoading: itemsLoading } = useWorkItems();
  const { data: repos } = useRepos();
  const { data: killSwitch, mutate: mutateKillSwitch } = useKillSwitch();
  const [toggling, setToggling] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  const isKilled = killSwitch?.enabled ?? false;

  const handleToggle = useCallback(() => {
    setPin("");
    setPinError(false);
    setShowConfirm(true);
  }, []);

  const confirmToggle = useCallback(async () => {
    setToggling(true);
    setPinError(false);
    try {
      const res = await fetch("/api/pipeline/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !isKilled, pin }),
      });
      if (!res.ok) {
        const data = await res.json();
        if (res.status === 403) {
          setPinError(true);
          setToggling(false);
          return;
        }
        throw new Error(data.error || "Request failed");
      }
      setShowConfirm(false);
      setPin("");
      await mutateKillSwitch();
    } finally {
      setToggling(false);
    }
  }, [isKilled, pin, mutateKillSwitch]);

  const queueItems = (workItems ?? [])
    .filter((i) => i.status === "ready" || i.status === "queued")
    .sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const pd = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (pd !== 0) return pd;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

  const activeWorkItems = (workItems ?? []).filter((i) => ACTIVE_STATUSES.includes(i.status));

  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Pipeline</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Work item flow &amp; execution status
            </p>
          </div>
          <div className="flex items-center gap-3 text-[11px]">
            {/* Kill Switch */}
            <button
              onClick={handleToggle}
              disabled={toggling}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold ring-1 transition-all text-[11px]",
                toggling && "opacity-60 cursor-wait",
                isKilled
                  ? "bg-status-blocked/10 text-status-blocked ring-status-blocked/30 hover:bg-status-blocked/20"
                  : "bg-emerald-500/10 text-emerald-500 ring-emerald-500/30 hover:bg-emerald-500/20"
              )}
            >
              {toggling ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Power className="h-3 w-3" />
              )}
              {isKilled ? "Pipeline Stopped" : "Pipeline Running"}
            </button>
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              <Radio className={cn("h-3 w-3", activeWorkItems.length > 0 ? "text-status-executing animate-status-pulse" : "text-muted-foreground/40")} />
              {activeWorkItems.length} active
            </span>
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              <Layers className="h-3 w-3" />
              {queueItems.length} queued
            </span>
          </div>
        </div>
      </header>

      {/* Confirmation Dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="rounded-2xl bg-surface-1 p-6 shadow-2xl ring-1 ring-border max-w-sm mx-4">
            <h2 className="text-base font-display font-bold text-foreground mb-2">
              {isKilled ? "Start Pipeline?" : "Stop Pipeline?"}
            </h2>
            <p className="text-[12px] text-muted-foreground mb-4 leading-relaxed">
              {isKilled
                ? "This will resume all agents. Queued work items will begin processing."
                : "This will prevent all agents (supervisor, dispatcher, health monitor, project manager) from running. Active executions will not be interrupted, but no new work will be picked up."}
            </p>
            <div className="mb-4">
              <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">
                Enter PIN to confirm
              </label>
              <input
                type="password"
                value={pin}
                onChange={(e) => { setPin(e.target.value); setPinError(false); }}
                onKeyDown={(e) => { if (e.key === "Enter" && pin) confirmToggle(); }}
                placeholder="PIN"
                autoFocus
                className={cn(
                  "w-full rounded-lg bg-surface-2 px-3 py-2 text-[13px] font-mono text-foreground ring-1 outline-none transition-colors placeholder:text-muted-foreground/40",
                  pinError
                    ? "ring-status-blocked focus:ring-status-blocked"
                    : "ring-border focus:ring-primary"
                )}
              />
              {pinError && (
                <p className="text-[11px] text-status-blocked mt-1">Incorrect PIN</p>
              )}
            </div>
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => { setShowConfirm(false); setPin(""); setPinError(false); }}
                className="rounded-lg px-4 py-2 text-[12px] font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmToggle}
                disabled={!pin || toggling}
                className={cn(
                  "rounded-lg px-4 py-2 text-[12px] font-semibold text-white transition-colors disabled:opacity-50",
                  isKilled
                    ? "bg-emerald-600 hover:bg-emerald-500"
                    : "bg-status-blocked hover:bg-status-blocked/90"
                )}
              >
                {toggling ? "..." : isKilled ? "Start Pipeline" : "Stop Pipeline"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kill Switch Banner */}
      {isKilled && (
        <div className="bg-status-blocked/10 border-b border-status-blocked/20 px-6 py-2.5">
          <div className="flex items-center gap-2 text-[11px] text-status-blocked font-medium">
            <Power className="h-3.5 w-3.5" />
            <span>
              Pipeline is stopped.
              {killSwitch?.toggledAt && (
                <> Since {new Date(killSwitch.toggledAt).toLocaleString()}.</>
              )}
              {" "}All cron agents are being skipped.
            </span>
          </div>
        </div>
      )}

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {/* Pipeline Stages */}
          {!itemsLoading && workItems && (
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Pipeline State
              </p>
              <PipelineStages workItems={workItems} />
            </div>
          )}

          {/* Blocked Summary */}
          {!itemsLoading && workItems && (
            <BlockedSummary workItems={workItems} />
          )}

          {/* Debate Reviews */}
          <DebateStatsCard />

          {/* Active Executions */}
          {activeWorkItems.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Active Executions
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {activeWorkItems.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl card-elevated bg-surface-1 p-3.5 ring-1 ring-status-executing/10"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="h-2 w-2 rounded-full bg-status-executing animate-status-pulse flex-shrink-0" />
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-status-executing/10 text-status-executing border-status-executing/20 flex-shrink-0">
                        {item.status}
                      </span>
                    </div>
                    <Link
                      href={`/work-items/${item.id}`}
                      className="text-[12px] font-medium text-foreground hover:text-primary line-clamp-2 transition-colors"
                    >
                      {item.title}
                    </Link>
                    <div className="text-[10px] text-muted-foreground/60 mt-1 truncate font-mono">{item.targetRepo}</div>
                    <div className="flex flex-wrap items-center justify-between text-[10px] text-muted-foreground mt-2 gap-1">
                      {item.execution?.startedAt && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          started {new Date(item.execution.startedAt).toLocaleString()}
                        </span>
                      )}
                      {item.execution?.prUrl && (
                        <a
                          href={item.execution.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 text-primary hover:text-primary/80 font-mono"
                        >
                          <GitPullRequest className="h-2.5 w-2.5" />
                          #{item.execution.prNumber}
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Queue */}
          {queueItems.length > 0 && (
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Queue ({queueItems.length})
              </p>
              <div className="rounded-xl card-elevated bg-surface-1 p-3.5 divide-y divide-border">
                {queueItems.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between py-2 gap-1">
                    <Link
                      href={`/work-items/${item.id}`}
                      className="text-[12px] font-medium text-foreground hover:text-primary truncate transition-colors"
                    >
                      {item.title}
                    </Link>
                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      <span className={cn(
                        "text-[10px] font-bold px-1.5 py-0.5 rounded-full border",
                        item.priority === "high"
                          ? "bg-status-blocked/10 text-status-blocked border-status-blocked/20"
                          : item.priority === "medium"
                            ? "bg-status-executing/10 text-status-executing border-status-executing/20"
                            : "bg-secondary text-muted-foreground border-border"
                      )}>
                        {item.priority}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 font-mono">{item.targetRepo}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
