"use client";

import { Card, CardContent } from "@/components/ui/card";
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

  // Count how often each dependency appears across blocked items
  const depFrequency = new Map<string, number>();
  for (const item of blockedItems) {
    for (const depId of item.dependencies) {
      depFrequency.set(depId, (depFrequency.get(depId) ?? 0) + 1);
    }
  }

  // Sort by frequency descending
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
      // All blocked items share the same single blocker
      sentences.push(
        `All ${blockedItems.length} blocked items are waiting on "${topTitle}" (currently ${topStatus}${elapsed}). Once it completes, all items will unblock.`
      );
    } else {
      sentences.push(
        `Most items are waiting on "${topTitle}" (currently ${topStatus}${elapsed}). Once that completes, ${topCount} item${topCount !== 1 ? "s" : ""} will unblock immediately.`
      );

      // Find independent chains: deps that don't overlap with the top blocker's blocked items
      const topBlockedItemIds = new Set(
        blockedItems
          .filter((i) => i.dependencies.includes(topDepId))
          .map((i) => i.id)
      );

      for (const [depId] of sortedDeps.slice(1)) {
        // Check if any items blocked by this dep are NOT in the top blocker's set
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
    <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800">
      <CardContent className="pt-6">
        <div className="flex items-start gap-3">
          <span className="text-amber-600 text-lg flex-shrink-0">&#9888;</span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              {blockedItems.length} item{blockedItems.length !== 1 ? "s" : ""} blocked
            </p>
            {sentences.map((s, i) => (
              <p key={i} className="text-sm text-amber-800 dark:text-amber-300">
                {s}
              </p>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
