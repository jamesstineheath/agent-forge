import type { Priority, WorkItem } from "../types";

// ---------------------------------------------------------------------------
// Dispatch sort constants and comparator (client-safe)
// ---------------------------------------------------------------------------

// Legacy work items that predate the triagePriority/rank fields default to P1 / 999,
// placing them in the middle of the queue behind any explicitly filed P0 items.
export const DEFAULT_PRIORITY: Priority = 'P1';
export const DEFAULT_RANK = 999;

/** Maps Priority labels to numeric sort keys (lower = higher urgency). */
export const PRIORITY_ORDER: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/**
 * Comparator for sorting WorkItems before dispatch.
 *
 * Sort order (ascending):
 *   1. Priority:  P0 → P1 → P2  (undefined treated as DEFAULT_PRIORITY = 'P1')
 *   2. Rank:      lower rank first (undefined treated as DEFAULT_RANK = 999)
 *   3. createdAt: earliest first (FIFO tiebreaker)
 *
 * Usage: workItems.sort(dispatchSortComparator)
 */
export function dispatchSortComparator(a: WorkItem, b: WorkItem): number {
  // 1. Priority comparison — legacy items without triagePriority default to P1
  const aPriority = PRIORITY_ORDER[a.triagePriority ?? DEFAULT_PRIORITY];
  const bPriority = PRIORITY_ORDER[b.triagePriority ?? DEFAULT_PRIORITY];
  if (aPriority !== bPriority) return aPriority - bPriority;

  // 2. Rank comparison — legacy items without rank default to 999
  const aRank = a.rank ?? DEFAULT_RANK;
  const bRank = b.rank ?? DEFAULT_RANK;
  if (aRank !== bRank) return aRank - bRank;

  // 3. createdAt tiebreaker — earliest submitted wins (FIFO)
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
