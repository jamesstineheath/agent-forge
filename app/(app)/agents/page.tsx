"use client";

import { cn } from "@/lib/utils";
import { RefreshCw, Bot } from "lucide-react";
import { useWorkItems, useTlmAgents } from "@/lib/hooks";
import type { TlmWorkflowStatus } from "@/lib/hooks";
import { PAAgentRow } from "@/components/pa-agent-row";
import { AgentDashboard } from "@/components/agent-dashboard";
import { AgentTraceViewer } from "@/components/agent-trace-viewer";
import { EvaluationMetricsPanel } from "@/components/evaluation-metrics-panel";
import { AgentTriggerButton } from "@/components/agent-trigger-button";
import { SupervisorPhaseLog } from "@/components/supervisor-phase-log";

const PA_AGENTS = [
  { name: "Inbox Triage", tier: "Tier 1", assessmentTier: "Weekly", status: "active" as const },
  { name: "Calendar Triage", tier: "Tier 1", assessmentTier: "Weekly", status: "active" as const },
  { name: "Realestate Scout", tier: "Tier 2", assessmentTier: "Monthly", status: "idle" as const },
  { name: "Funding Scanner", tier: "Tier 2", assessmentTier: "Monthly", status: "idle" as const },
  { name: "Family Sync", tier: "Tier 2", assessmentTier: "Monthly", status: "idle" as const },
  { name: "Gift Concierge", tier: "Tier 3", assessmentTier: "Quarterly", status: "idle" as const },
  { name: "Kids Activities", tier: "Tier 3", assessmentTier: "Quarterly", status: "idle" as const },
  { name: "Date Planner", tier: "Tier 3", assessmentTier: "Quarterly", status: "idle" as const },
];

// --- TLM Agent Heartbeat (same visual format as AgentDashboard rows) ---

type TlmHealth = "healthy" | "stale" | "error";

const healthColor: Record<TlmHealth, string> = {
  healthy: "text-status-merged bg-status-merged/10 border-status-merged/30",
  stale: "text-status-reviewing bg-status-reviewing/10 border-status-reviewing/30",
  error: "text-status-blocked bg-status-blocked/10 border-status-blocked/30",
};

const healthDot: Record<TlmHealth, string> = {
  healthy: "bg-status-merged",
  stale: "bg-status-reviewing",
  error: "bg-status-blocked",
};

const healthLabel: Record<TlmHealth, string> = {
  healthy: "Healthy",
  stale: "Stale",
  error: "Error",
};

function timeAgo(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function getTlmHealth(wf: TlmWorkflowStatus): TlmHealth {
  if (!wf.lastConclusion) return "stale";
  if (wf.lastConclusion === "failure") return "error";
  if (wf.lastRunAt) {
    const hoursSinceRun = (Date.now() - new Date(wf.lastRunAt).getTime()) / 3_600_000;
    if (hoursSinceRun > 48) return "stale";
  }
  return "healthy";
}

function TlmRunHistoryDots({ wf }: { wf: TlmWorkflowStatus }) {
  // Show success rate as visual dots (filled = success proportion)
  const total = wf.totalRuns;
  if (total === 0) return <span className="text-[10px] text-muted-foreground/40">no runs</span>;
  const successCount = wf.successRate !== null ? Math.round(wf.successRate * total) : 0;
  const failCount = total - successCount;
  const dots = Math.min(total, 15); // cap at 15 dots
  const successDots = Math.round((successCount / total) * dots);
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: dots }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "h-2.5 w-2.5 rounded-sm",
            i < successDots ? "bg-status-merged/70" : "bg-status-blocked/70"
          )}
        />
      ))}
    </div>
  );
}

function TlmAgentRow({ wf }: { wf: TlmWorkflowStatus }) {
  const health = getTlmHealth(wf);
  const successPct = wf.successRate !== null ? `${Math.round(wf.successRate * 100)}%` : null;

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{wf.name}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-semibold",
              healthColor[health]
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", healthDot[health])} />
            {healthLabel[health]}
          </span>
          <span className="text-[10px] text-muted-foreground/50">GitHub Actions</span>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[11px] text-muted-foreground">
            {wf.lastRunAt ? `Last run ${timeAgo(wf.lastRunAt)}` : "Never run"}
          </span>
          {wf.totalRuns > 0 && (
            <>
              <span className="text-[10px] text-muted-foreground/40">|</span>
              <span className="text-[11px] text-muted-foreground">
                {successPct} success rate ({wf.totalRuns} runs)
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex-shrink-0">
        <TlmRunHistoryDots wf={wf} />
      </div>
    </div>
  );
}

function TlmAgentsSection() {
  const { data, error, isLoading } = useTlmAgents();

  if (isLoading) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4 animate-pulse">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 bg-muted rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data || data.workflows.length === 0) {
    return (
      <div className="rounded-xl card-elevated bg-surface-1 p-4">
        <p className="text-sm text-muted-foreground/60">
          {error ? "Failed to load TLM agent status." : "No workflow data available."}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl card-elevated bg-surface-1 divide-y divide-border">
      {data.workflows.map((wf) => (
        <TlmAgentRow key={wf.workflowFile} wf={wf} />
      ))}
    </div>
  );
}

// --- Main Page ---

export default function AgentsPage() {
  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Agents</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Performance, quality, and cost across all agent types
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1 font-medium text-muted-foreground ring-1 ring-border">
              <Bot className="h-3 w-3" />
              {PA_AGENTS.filter(a => a.status === "active").length + 5} agents
            </span>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          {/* Agent Heartbeat Dashboard */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Agent Heartbeat
              </p>
              <span className="text-[10px] text-muted-foreground/40">(real-time health)</span>
            </div>
            <AgentDashboard />
            {/* Digest agent trigger (not in heartbeat dashboard but is a cron agent) */}
            <div className="rounded-xl card-elevated bg-surface-1 px-4 py-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">Digest</span>
                    <span className="text-[10px] text-muted-foreground/50">daily cron</span>
                  </div>
                  <span className="text-[11px] text-muted-foreground">Daily summary email (8 AM UTC)</span>
                </div>
                <AgentTriggerButton agentKey="digest" agentName="Digest" />
              </div>
            </div>
          </div>

          {/* Agent Traces */}
          <AgentTraceViewer />

          {/* Supervisor Phase Log */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Supervisor Phase Log
              </p>
              <span className="text-[10px] text-muted-foreground/40">(last cycle execution)</span>
            </div>
            <SupervisorPhaseLog />
          </div>

          {/* TLM Agents */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                TLM Agents
              </p>
              <span className="text-[10px] text-muted-foreground/40">(GitHub Actions pipeline)</span>
            </div>
            <TlmAgentsSection />
          </div>

          {/* PA Agents */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                PA Agents
              </p>
              <span className="text-[10px] text-muted-foreground/40">(personal-assistant)</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Evaluation framework (ADR-007) active for Tier 1 agents. Tier 2/3
              agents collect actions but lack assessment signal.
            </p>
            <div className="rounded-xl card-elevated bg-surface-1 divide-y divide-border">
              {PA_AGENTS.map((agent) => (
                <PAAgentRow
                  key={agent.name}
                  name={agent.name}
                  tier={agent.tier}
                  assessmentTier={agent.assessmentTier}
                  status={agent.status}
                />
              ))}
            </div>
          </div>

          {/* Evaluation Metrics */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Evaluation Metrics
              </p>
              <span className="text-[10px] text-muted-foreground/40">(quality, cost, drift)</span>
            </div>
            <EvaluationMetricsPanel />
          </div>

          {/* Self-improvement loop */}
          <div className="rounded-xl card-elevated bg-surface-1 p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <RefreshCw size={12} className="text-muted-foreground/60" />
              <span className="text-xs font-display font-bold text-foreground">
                Self-improvement loop
              </span>
            </div>
            <div className="text-[12px] text-muted-foreground leading-relaxed">
              The Feedback Compiler (ADR-009) analyzes outcome patterns weekly
              and proposes prompt changes via PR, closing the loop between
              observation (Outcome Tracker) and adaptation (prompt/config changes),
              with human approval as the gate.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
