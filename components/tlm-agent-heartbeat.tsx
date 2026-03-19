"use client";

import { useTlmAgents, TlmWorkflowStatus } from "@/lib/hooks";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ConclusionBadge({ conclusion }: { conclusion: string | null }) {
  if (!conclusion) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
        Never run
      </span>
    );
  }
  const styles: Record<string, string> = {
    success: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    failure: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    skipped: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    cancelled: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  };
  const style = styles[conclusion] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style}`}>
      {conclusion}
    </span>
  );
}

function WorkflowRow({ workflow }: { workflow: TlmWorkflowStatus }) {
  const lastRunAgo = workflow.lastRunAt
    ? relativeTime(workflow.lastRunAt)
    : "\u2014";
  const successPct =
    workflow.successRate !== null
      ? `${Math.round(workflow.successRate * 100)}%`
      : "\u2014";
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2 pr-4 text-sm font-medium text-foreground whitespace-nowrap">
        {workflow.name}
      </td>
      <td className="py-2 pr-4">
        <ConclusionBadge conclusion={workflow.lastConclusion} />
      </td>
      <td className="py-2 pr-4 text-sm text-muted-foreground whitespace-nowrap">
        {lastRunAgo}
      </td>
      <td className="py-2 pr-4 text-sm text-muted-foreground text-right">
        {workflow.totalRuns}
      </td>
      <td className="py-2 text-sm text-muted-foreground text-right">{successPct}</td>
    </tr>
  );
}

export function TlmAgentHeartbeat() {
  const { data, error, isLoading } = useTlmAgents();

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-8 bg-muted rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load TLM agent status. Check GitHub API connectivity.
      </p>
    );
  }

  if (!data || data.workflows.length === 0) {
    return <p className="text-sm text-muted-foreground">No workflow data available.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border">
            <th className="pb-2 pr-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Agent
            </th>
            <th className="pb-2 pr-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Last Result
            </th>
            <th className="pb-2 pr-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Last Run
            </th>
            <th className="pb-2 pr-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right">
              Runs
            </th>
            <th className="pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide text-right">
              Success Rate
            </th>
          </tr>
        </thead>
        <tbody>
          {data.workflows.map((wf) => (
            <WorkflowRow key={wf.workflowFile} workflow={wf} />
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground/60">
        Last fetched: {relativeTime(data.fetchedAt)}
      </p>
    </div>
  );
}
