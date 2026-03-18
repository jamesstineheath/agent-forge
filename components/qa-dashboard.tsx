"use client";

import { useQAResults } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function passRateColor(rate: number): string {
  if (rate >= 90) return "text-status-merged";
  if (rate >= 70) return "text-status-executing";
  return "text-status-blocked";
}

function passRateBadgeVariant(
  rate: number
): "default" | "secondary" | "destructive" {
  if (rate >= 90) return "default";
  if (rate >= 70) return "secondary";
  return "destructive";
}

export function QADashboard() {
  const { data, isLoading, error } = useQAResults();

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          QA Agent
        </p>
        <p className="text-xs text-muted-foreground/60">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          QA Agent
        </p>
        <p className="text-xs text-muted-foreground/60">
          Failed to load QA data.
        </p>
      </div>
    );
  }

  const isEmpty = !data || !data.summary || data.summary.totalRuns === 0;

  if (isEmpty) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          QA Agent
        </p>
        <p className="text-xs text-muted-foreground/60">
          No QA runs recorded. Deploy the QA Agent to get started.
        </p>
      </div>
    );
  }

  const { summary, runs } = data;
  const recentRuns = (runs ?? []).slice(0, 10);
  const grad = summary.graduation;

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
          QA Agent
        </p>
        <div className="grid grid-cols-4 gap-3">
          <div>
            <p className="text-[10px] text-muted-foreground/60">Pass Rate</p>
            <p
              className={`text-lg font-bold font-display ${passRateColor(summary.passRate)}`}
            >
              {summary.passRate.toFixed(1)}%
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60">Total Runs</p>
            <p className="text-lg font-bold font-display">
              {summary.totalRuns}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60">Avg Duration</p>
            <p className="text-lg font-bold font-display">
              {formatDuration(summary.avgDurationMs)}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/60">Graduation</p>
            <p className="text-lg font-bold font-display">
              {grad.runsCompleted}/{grad.runsRequired}
            </p>
          </div>
        </div>
      </div>

      {/* Graduation progress */}
      <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] text-muted-foreground/60">
            Graduation Progress
          </p>
          <p className="text-[10px] text-muted-foreground/60">
            {grad.falseNegativeRate.toFixed(1)}% false-negative rate
          </p>
        </div>
        <Progress value={(grad.runsCompleted / grad.runsRequired) * 100} />
        <p className="text-[10px] text-muted-foreground/60 mt-1.5">
          {grad.runsCompleted} of {grad.runsRequired} runs completed
        </p>
      </div>

      {/* Failure categories */}
      {summary.failureCategories &&
        Object.keys(summary.failureCategories).length > 0 && (
          <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
              Failure Categories
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(summary.failureCategories)
                  .sort(([, a], [, b]) => b - a)
                  .map(([category, count]) => (
                    <TableRow key={category}>
                      <TableCell className="text-sm">{category}</TableCell>
                      <TableCell className="text-right text-sm">
                        {count}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}

      {/* Per-repo breakdown */}
      {summary.byRepo && summary.byRepo.length > 0 && (
        <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
            Per-Repo Breakdown
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead className="text-right">Runs</TableHead>
                <TableHead className="text-right">Pass Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.byRepo.map((row) => (
                <TableRow key={row.repo}>
                  <TableCell className="font-mono text-sm">{row.repo}</TableCell>
                  <TableCell className="text-right text-sm">
                    {row.runs}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={passRateBadgeVariant(row.passRate)}>
                      {row.passRate.toFixed(1)}%
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Recent runs */}
      {recentRuns.length > 0 && (
        <div className="rounded-xl card-elevated bg-surface-1 p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-3">
            Recent Runs
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repo</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentRuns.map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-mono text-sm">{run.repo}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatTimestamp(run.timestamp)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDuration(run.durationMs)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={run.passed ? "default" : "destructive"}>
                      {run.passed ? "Pass" : "Fail"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
