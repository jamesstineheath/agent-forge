"use client";

import { useIntentCriteriaList, useProjects, useWorkItems } from "@/lib/hooks";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { Project, WorkItem } from "@/lib/types";

const statusColors: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  passed: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
};

const repoColors: Record<string, string> = {
  "personal-assistant": "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  "agent-forge": "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  "rez-sniper": "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  "8760": "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  "fitness-app": "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300",
};

/** Detect silent failure conditions from work items and derived status */
function getSilentFailureLabel(derivedStatus: string, workItems: WorkItem[]): string | null {
  if (workItems.length === 0 && (derivedStatus === "Executing" || derivedStatus === "Execute")) {
    return "\u26A0 No work items";
  }

  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;

  const mostRecentUpdate = workItems.reduce((latest, wi) => {
    const t = new Date(wi.updatedAt).getTime();
    return t > latest ? t : latest;
  }, 0);

  if (
    (derivedStatus === "Executing" || derivedStatus === "Execute") &&
    mostRecentUpdate > 0 &&
    mostRecentUpdate < twoHoursAgo
  ) {
    return "\u26A0 Stalled";
  }

  const hasBlocked = workItems.some((wi) => wi.status === "blocked" || wi.status === "escalated");
  if (hasBlocked) {
    return "\u26A0 Blocked";
  }

  if (derivedStatus === "Queued" && mostRecentUpdate > 0 && mostRecentUpdate < thirtyMinAgo) {
    return "\u26A0 Queued too long";
  }

  return null;
}

export default function ProjectsPage() {
  const { data: criteria, isLoading, mutate } = useIntentCriteriaList();
  const { data: workItems } = useWorkItems();
  const { data: notionProjects } = useProjects();
  const [importing, setImporting] = useState(false);

  const getProjectWorkItems = (entry: { projectId?: string; targetRepo?: string }): WorkItem[] => {
    if (!entry.projectId) return [];
    return (
      workItems?.filter(
        (wi) => wi.source?.type === "project" && wi.source?.sourceId === entry.projectId
      ) ?? []
    );
  };

  /** Look up Notion project by projectId to get authoritative status */
  const getNotionProject = (projectId?: string): Project | undefined => {
    if (!projectId || !notionProjects) return undefined;
    return notionProjects.find((p) => p.projectId === projectId);
  };

  /** Derive execution status from work item pipeline state */
  const deriveStatus = (pWI: WorkItem[]): string => {
    if (pWI.length === 0) return "No items";
    const merged = pWI.filter((w) => w.status === "merged" || w.status === "verified").length;
    const active = pWI.filter((w) => ["generating", "executing", "reviewing", "queued", "ready", "retrying"].includes(w.status)).length;
    const failed = pWI.filter((w) => w.status === "failed" || w.status === "blocked" || w.status === "escalated").length;
    if (merged === pWI.length) return "Complete";
    if (active > 0) return "Executing";
    if (failed > 0 && merged > 0) return "Partial";
    if (failed > 0) return "Failed";
    return "Queued";
  };

  const handleImportAll = async () => {
    setImporting(true);
    try {
      await fetch("/api/intent-criteria", { method: "POST" });
      mutate();
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="glass-header sticky top-0 z-10 flex items-center justify-between py-4">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            PRDs with acceptance criteria tracked through execution
          </p>
        </div>
        <button
          onClick={handleImportAll}
          disabled={importing}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${importing ? "animate-spin" : ""}`} />
          Import from Notion
        </button>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-12">Loading projects...</div>
      ) : !criteria || criteria.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-4">
            No criteria imported yet. Set a PRD to &quot;Approved&quot; in Notion, then click &quot;Import from Notion&quot;.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {criteria.map((entry) => {
            const progress = entry.criteriaCount > 0
              ? Math.round((entry.passedCount / entry.criteriaCount) * 100)
              : 0;
            const pWI = getProjectWorkItems(entry);
            const wiMerged = pWI.filter((w) => w.status === "merged" || w.status === "verified").length;
            const wiActive = pWI.filter((w) => ["generating", "executing", "reviewing", "queued", "ready", "retrying"].includes(w.status)).length;
            const wiFailed = pWI.filter((w) => w.status === "failed" || w.status === "blocked" || w.status === "escalated").length;
            const wiTotal = pWI.length;
            const wiProgress = wiTotal > 0 ? Math.round((wiMerged / wiTotal) * 100) : 0;
            const derivedStatus = deriveStatus(pWI);

            // AC-5: Prefer Notion/PRD status as authoritative source
            const notionProject = getNotionProject(entry.projectId);
            const displayStatus = notionProject?.status ?? derivedStatus;

            // AC-6: Detect silent failure conditions
            const failureLabel = getSilentFailureLabel(displayStatus, pWI);

            return (
              <Link
                key={entry.prdId}
                href={`/projects/${entry.prdId}`}
                className="block rounded-lg border bg-card p-4 hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{entry.prdTitle}</h3>
                      {entry.projectId && (
                        <span className="text-xs text-muted-foreground">
                          {entry.projectId}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {entry.targetRepo && (
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${repoColors[entry.targetRepo] || "bg-gray-100 text-gray-700"}`}>
                          {entry.targetRepo}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {displayStatus}
                      </span>
                      {failureLabel && (
                        <span className="text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded px-1.5 py-0.5">
                          {failureLabel}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        Est. ${entry.totalEstimatedCost.toFixed(0)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {entry.criteriaCount} criteria
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    {/* Work item pipeline progress */}
                    {wiTotal > 0 && (
                      <div className="text-right">
                        <div className="text-sm font-medium">
                          {wiMerged}/{wiTotal} work items
                        </div>
                        <div className="w-32 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mt-1 flex">
                          <div
                            className="h-full bg-green-500 transition-all"
                            style={{ width: `${wiProgress}%` }}
                          />
                          {wiActive > 0 && (
                            <div
                              className="h-full bg-blue-500 transition-all"
                              style={{ width: `${Math.round((wiActive / wiTotal) * 100)}%` }}
                            />
                          )}
                          {wiFailed > 0 && (
                            <div
                              className="h-full bg-red-500 transition-all"
                              style={{ width: `${Math.round((wiFailed / wiTotal) * 100)}%` }}
                            />
                          )}
                        </div>
                        <div className="flex gap-2 mt-0.5 justify-end">
                          {wiMerged > 0 && <span className="text-[10px] text-green-500">{wiMerged} done</span>}
                          {wiActive > 0 && <span className="text-[10px] text-blue-500">{wiActive} active</span>}
                          {wiFailed > 0 && <span className="text-[10px] text-red-500">{wiFailed} failed</span>}
                        </div>
                      </div>
                    )}

                    {/* Criteria progress */}
                    <div className="text-right">
                      <div className="text-sm font-medium">
                        {entry.passedCount}/{entry.criteriaCount} criteria
                      </div>
                      <div className="w-32 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mt-1">
                        <div
                          className="h-full bg-green-500 rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
