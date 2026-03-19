import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listWorkItemsFull } from "@/lib/work-items";
import { getCostsForPeriod, aggregateCosts } from "@/lib/cost-tracking";
import type { WorkItem, CostAnalytics } from "@/lib/types";

function itemCost(item: WorkItem): number {
  return item.execution?.actualCost ?? item.handoff?.budget ?? 0;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isToday(dateStr: string): boolean {
  return dateStr.slice(0, 10) === toDateStr(new Date());
}

function isWithinDays(dateStr: string, days: number): boolean {
  const d = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return d >= cutoff;
}

function getPeriodDays(period: string): number {
  switch (period) {
    case "7d": return 7;
    case "30d": return 30;
    case "90d": return 90;
    case "all": return 365;
    default: return 30;
  }
}

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  try {
    const period = req.nextUrl.searchParams.get("period") ?? "30d";
    const days = getPeriodDays(period);

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [allItems, costEntries] = await Promise.all([
      listWorkItemsFull(),
      getCostsForPeriod(toDateStr(startDate), toDateStr(endDate)),
    ]);

    const executed = allItems.filter(
      (item) => item.handoff && item.execution?.startedAt
    );

    // --- Summary KPIs ---
    const todaySpend = executed
      .filter((i) => i.execution?.startedAt && isToday(i.execution.startedAt))
      .reduce((s, i) => s + itemCost(i), 0);

    const weekSpend = executed
      .filter((i) => i.execution?.startedAt && isWithinDays(i.execution.startedAt, 7))
      .reduce((s, i) => s + itemCost(i), 0);

    const monthSpend = executed
      .filter((i) => i.execution?.startedAt && isWithinDays(i.execution.startedAt, 30))
      .reduce((s, i) => s + itemCost(i), 0);

    const allTimeSpend = executed.reduce((s, i) => s + itemCost(i), 0);

    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dailyBurnRate = dayOfMonth > 0 ? monthSpend / dayOfMonth : 0;
    const monthProjection = dailyBurnRate * daysInMonth;

    const mergedItems = executed.filter((i) => i.status === "merged");
    const failedItems = executed.filter(
      (i) => i.status === "failed" || i.execution?.outcome === "failed" || i.execution?.outcome === "reverted"
    );
    const wasteSpend = failedItems.reduce((s, i) => s + itemCost(i), 0);
    const wastePct = allTimeSpend > 0 ? Math.round((wasteSpend / allTimeSpend) * 100) : 0;

    const mergedSpend = mergedItems.reduce((s, i) => s + itemCost(i), 0);
    const costPerMerge = mergedItems.length > 0 ? mergedSpend / mergedItems.length : 0;

    const itemsWithActualCost = executed.filter((i) => i.execution?.actualCost != null).length;

    // --- Daily Spend ---
    const dailyMap = new Map<string, { total: number; byRepo: Record<string, number>; itemCount: number }>();

    // Fill all dates in range
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      dailyMap.set(toDateStr(d), { total: 0, byRepo: {}, itemCount: 0 });
    }

    for (const item of executed) {
      const dateStr = (item.execution?.completedAt ?? item.execution?.startedAt ?? "").slice(0, 10);
      if (!dateStr) continue;
      const day = dailyMap.get(dateStr);
      if (!day) continue;
      const cost = itemCost(item);
      day.total += cost;
      day.byRepo[item.targetRepo] = (day.byRepo[item.targetRepo] ?? 0) + cost;
      day.itemCount += 1;
    }

    const dailySpend = Array.from(dailyMap.entries())
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // --- Budget Accuracy ---
    const itemsWithBoth = executed.filter(
      (i) => i.execution?.actualCost != null && i.handoff?.budget != null
    );
    const accuracyItems = itemsWithBoth.map((i) => {
      const budget = i.handoff!.budget;
      const actual = i.execution!.actualCost!;
      const delta = actual - budget;
      const deltaPct = budget > 0 ? Math.round((delta / budget) * 100) : 0;
      return {
        id: i.id,
        title: i.title,
        budget,
        actual,
        delta,
        deltaPct,
        outcome: i.execution?.outcome ?? null,
      };
    });

    const overBudgetCount = accuracyItems.filter((i) => i.deltaPct > 10).length;
    const underBudgetCount = accuracyItems.filter((i) => i.deltaPct < -10).length;
    const avgOverrunPct = accuracyItems.length > 0
      ? Math.round(accuracyItems.reduce((s, i) => s + i.deltaPct, 0) / accuracyItems.length)
      : 0;

    // --- By Repo ---
    const repoMap = new Map<string, {
      totalSpend: number; itemCount: number; mergedCount: number;
      failedCount: number; mergedSpend: number; wasteSpend: number;
    }>();
    for (const item of executed) {
      const repo = item.targetRepo;
      const entry = repoMap.get(repo) ?? {
        totalSpend: 0, itemCount: 0, mergedCount: 0,
        failedCount: 0, mergedSpend: 0, wasteSpend: 0,
      };
      const cost = itemCost(item);
      entry.totalSpend += cost;
      entry.itemCount += 1;
      if (item.status === "merged") {
        entry.mergedCount += 1;
        entry.mergedSpend += cost;
      }
      if (item.status === "failed" || item.execution?.outcome === "failed" || item.execution?.outcome === "reverted") {
        entry.failedCount += 1;
        entry.wasteSpend += cost;
      }
      repoMap.set(repo, entry);
    }

    const byRepo = Array.from(repoMap.entries()).map(([repo, d]) => ({
      repo,
      totalSpend: d.totalSpend,
      itemCount: d.itemCount,
      mergedCount: d.mergedCount,
      failedCount: d.failedCount,
      successRate: d.itemCount > 0 ? Math.round((d.mergedCount / d.itemCount) * 100) : 0,
      costPerMerge: d.mergedCount > 0 ? d.mergedSpend / d.mergedCount : 0,
      wasteSpend: d.wasteSpend,
    })).sort((a, b) => b.totalSpend - a.totalSpend);

    // --- By Agent (from CostEntry data) ---
    const agentAgg = aggregateCosts(costEntries);
    const byAgent = agentAgg.byAgent;

    // --- By Complexity ---
    const complexityMap = new Map<string, { budgetSum: number; actualSum: number; count: number }>();
    for (const item of executed) {
      const c = item.complexity ?? "unknown";
      const entry = complexityMap.get(c) ?? { budgetSum: 0, actualSum: 0, count: 0 };
      entry.budgetSum += item.handoff?.budget ?? 0;
      entry.actualSum += itemCost(item);
      entry.count += 1;
      complexityMap.set(c, entry);
    }

    const byComplexity = Array.from(complexityMap.entries()).map(([complexity, d]) => ({
      complexity,
      avgBudget: d.count > 0 ? d.budgetSum / d.count : 0,
      avgActual: d.count > 0 ? d.actualSum / d.count : 0,
      itemCount: d.count,
    }));

    // --- Recent Items ---
    const recentItems = executed
      .sort((a, b) => {
        const aDate = a.execution?.completedAt ?? a.execution?.startedAt ?? a.updatedAt;
        const bDate = b.execution?.completedAt ?? b.execution?.startedAt ?? b.updatedAt;
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })
      .slice(0, 25)
      .map((i) => ({
        id: i.id,
        title: i.title,
        targetRepo: i.targetRepo,
        complexity: i.complexity ?? "unknown",
        budget: i.handoff?.budget ?? 0,
        actualCost: i.execution?.actualCost ?? null,
        status: i.status,
        outcome: i.execution?.outcome ?? null,
        completedAt: i.execution?.completedAt ?? null,
      }));

    const analytics: CostAnalytics = {
      summary: {
        todaySpend,
        weekSpend,
        monthSpend,
        allTimeSpend,
        dailyBurnRate,
        monthProjection,
        wastePct,
        wasteSpend,
        costPerMerge,
        itemsWithActualCost,
        totalExecutedItems: executed.length,
      },
      dailySpend,
      budgetAccuracy: {
        items: accuracyItems,
        avgOverrunPct,
        overBudgetCount,
        underBudgetCount,
      },
      byRepo,
      byAgent,
      byComplexity,
      recentItems,
    };

    return NextResponse.json(analytics);
  } catch (err) {
    console.error("[api/costs/analytics] GET error:", err);
    return NextResponse.json({ error: "Failed to compute cost analytics" }, { status: 500 });
  }
}
