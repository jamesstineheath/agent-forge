"use client";

import type { WorkItem } from "@/lib/types";

interface BlockedSummaryProps {
  workItems: WorkItem[];
}

function formatElapsed(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function BlockedSummary({ workItems }: BlockedSummaryProps) {
  const blockedItems = workItems.filter((i) => i.status === "blocked");

  if (blockedItems.length === 0) return null;

  const itemMap = new Map(workItems.map((i) => [i.id, i]));

  const depFrequency = new Map<string, number>();
  for (const item of blockedItems) {
    for (const depId of item.dependencies) {
      depFrequency.set(depId, (depFrequency.get(depId) ?? 0) + 1);
    }
  }

  const sortedDeps = [...depFrequency.entries()].sort((a, b) => b[1] - a[1]);

  const sentences: string[] = [];

  if (sortedDeps.length > 0) {
    const [topDepId, topCount] = sortedDeps[0];
    const topDep = itemMap.get(topDepId);
    const topTitle = topDep ? topDep.title : `${topDepId.slice(0, 8)} (unknown)`;
    const topStatus = topDep?.status ?? "unknown";
    const elapsed = topDep?.execution?.startedAt
      ? `, ${formatElapsed(topDep.execution.startedAt)} elapsed`
      : "";

    if (topCount === blockedItems.length && sortedDeps.length === 1) {
      sentences.push(
        `All ${blockedItems.length} blocked items are waiting on "${topTitle}" (currently ${topStatus}${elapsed}). Once it completes, all items will unblock.`
      );
    } else {
      sentences.push(
        `Most items are waiting on "${topTitle}" (currently ${topStatus}${elapsed}). Once that completes, ${topCount} item${topCount !== 1 ? "s" : ""} will unblock immediately.`
      );

      const topBlockedItemIds = new Set(
        blockedItems
          .filter((i) => i.dependencies.includes(topDepId))
          .map((i) => i.id)
      );

      for (const [depId] of sortedDeps.slice(1)) {
        const independentBlockedItems = blockedItems.filter(
          (i) => i.dependencies.includes(depId) && !topBlockedItemIds.has(i.id)
        );
        if (independentBlockedItems.length > 0) {
          const dep = itemMap.get(depId);
          const depTitle = dep ? dep.title : `${depId.slice(0, 8)} (unknown)`;
          const depStatus = dep?.status ?? "unknown";
          const repo = dep?.targetRepo;
          const repoLabel = repo ? `${repo} ` : "";
          sentences.push(
            `The ${repoLabel}chain is independently blocked on "${depTitle}" which is ${depStatus}.`
          );
        }
      }
    }
  }

  return (
    <div className="rounded-lg border border-status-reviewing/20 bg-status-reviewing/5 p-3">
      <div className="text-xs font-medium text-status-reviewing mb-1">
        {blockedItems.length} item{blockedItems.length !== 1 ? "s" : ""} blocked
      </div>
      {sentences.map((s, i) => (
        <div key={i} className="text-xs text-muted-foreground/60">
          {s}
        </div>
      ))}
    </div>
  );
}
