"use client";

import { useState } from "react";
import {
  useModelRoutingAnalytics,
  useCostBaseline,
  type ModelRoutingParams,
} from "@/lib/hooks";

const TIME_RANGES = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
] as const;

export function ModelRoutingDashboard() {
  const [days, setDays] = useState<number>(30);
  const [taskType, setTaskType] = useState<string>("");

  const params: ModelRoutingParams = { days, taskType: taskType || undefined };
  const { data, isLoading } = useModelRoutingAnalytics(params);
  const { comparison, refresh: refreshBaseline } = useCostBaseline();

  async function handleRecordBaseline() {
    await fetch("/api/analytics/cost-baseline", { method: "POST" });
    refreshBaseline();
  }

  const perModelCostEntries = data?.perModelCosts
    ? Object.entries(data.perModelCosts)
    : [];

  return (
    <div className="space-y-8">
      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-center">
        <div className="flex gap-2">
          {TIME_RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                days === r.days
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Filter by task type..."
          value={taskType}
          onChange={(e) => setTaskType(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded text-sm bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="text-center py-12 text-muted-foreground">
          Loading analytics...
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !data && (
        <div className="text-center py-12 text-muted-foreground">
          No analytics data available for the selected range.
        </div>
      )}

      {data && (
        <>
          {/* Per-Model Cost Breakdown */}
          <section>
            <h2 className="text-lg font-semibold mb-3">
              Per-Model Cost Breakdown
            </h2>
            {perModelCostEntries.length === 0 ? (
              <p className="text-muted-foreground text-sm">No cost data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="px-4 py-2 border border-border font-medium">
                        Model
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Total Cost
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Call Count
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Avg Cost/Step
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {perModelCostEntries.map(([model, stats]) => (
                      <tr key={model} className="hover:bg-muted/30">
                        <td className="px-4 py-2 border border-border font-mono text-xs">
                          {model}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          ${stats.totalCost.toFixed(4)}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          {stats.callCount}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          ${stats.avgCostPerStep.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Daily Spend */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Daily Spend</h2>
            {!data.dailySpend || data.dailySpend.length === 0 ? (
              <p className="text-muted-foreground text-sm">No daily spend data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="px-4 py-2 border border-border font-medium">
                        Date
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Model
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Cost
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dailySpend.map((row, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-2 border border-border">
                          {row.date}
                        </td>
                        <td className="px-4 py-2 border border-border font-mono text-xs">
                          {row.model}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          ${row.cost.toFixed(4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Quality Scores */}
          <section>
            <h2 className="text-lg font-semibold mb-3">
              Quality Scores (Task Type × Model)
            </h2>
            {!data.qualityScores || data.qualityScores.length === 0 ? (
              <p className="text-muted-foreground text-sm">No quality score data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="px-4 py-2 border border-border font-medium">
                        Task Type
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Model
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Success Rate
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Total Calls
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.qualityScores.map((row, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-2 border border-border">
                          {row.taskType}
                        </td>
                        <td className="px-4 py-2 border border-border font-mono text-xs">
                          {row.model}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          <span
                            className={
                              row.successRate >= 0.8
                                ? "text-green-700 dark:text-green-400"
                                : row.successRate >= 0.5
                                ? "text-yellow-700 dark:text-yellow-400"
                                : "text-red-700 dark:text-red-400"
                            }
                          >
                            {(row.successRate * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td className="px-4 py-2 border border-border">
                          {row.totalCalls}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Escalation Rates */}
          <section>
            <h2 className="text-lg font-semibold mb-3">Escalation Rates</h2>
            {!data.escalationRates || data.escalationRates.length === 0 ? (
              <p className="text-muted-foreground text-sm">No escalation data.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="px-4 py-2 border border-border font-medium">
                        Task Type
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Escalations
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Total Calls
                      </th>
                      <th className="px-4 py-2 border border-border font-medium">
                        Rate
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.escalationRates.map((row, i) => (
                      <tr key={i} className="hover:bg-muted/30">
                        <td className="px-4 py-2 border border-border">
                          {row.taskType}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          {row.escalationCount}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          {row.totalCalls}
                        </td>
                        <td className="px-4 py-2 border border-border">
                          <span
                            className={
                              row.rate <= 0.05
                                ? "text-green-700 dark:text-green-400"
                                : row.rate <= 0.15
                                ? "text-yellow-700 dark:text-yellow-400"
                                : "text-red-700 dark:text-red-400"
                            }
                          >
                            {(row.rate * 100).toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* Phase 1 ROI */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Phase 1 ROI</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Cost reduction vs all-Opus baseline
        </p>
        {comparison?.baseline == null ? (
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              No baseline recorded. Record a baseline to start tracking cost
              reduction.
            </p>
            <button
              onClick={handleRecordBaseline}
              className="px-3 py-1.5 rounded text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Record Baseline
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <p className="text-2xl font-bold text-green-700 dark:text-green-400">
                {comparison.costReductionPct != null
                  ? `${comparison.costReductionPct.toFixed(1)}%`
                  : "\u2014"}
              </p>
              <p className="text-xs text-muted-foreground">
                cost reduction vs baseline
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-medium">Baseline cost/success</p>
                <p className="text-muted-foreground">
                  ${comparison.baselineCostPerSuccess?.toFixed(4) ?? "\u2014"}
                </p>
              </div>
              <div>
                <p className="font-medium">Current cost/success</p>
                <p className="text-muted-foreground">
                  ${comparison.currentCostPerSuccess?.toFixed(4) ?? "\u2014"}
                </p>
              </div>
              <div>
                <p className="font-medium">Baseline success rate</p>
                <p className="text-muted-foreground">
                  {comparison.baselineSuccessRate != null
                    ? `${(comparison.baselineSuccessRate * 100).toFixed(1)}%`
                    : "\u2014"}
                </p>
              </div>
              <div>
                <p className="font-medium">Current success rate</p>
                <p className="text-muted-foreground">
                  {comparison.currentSuccessRate != null
                    ? `${(comparison.currentSuccessRate * 100).toFixed(1)}%`
                    : "\u2014"}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Baseline recorded{" "}
              {new Date(comparison.baseline.recordedAt).toLocaleDateString()}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
