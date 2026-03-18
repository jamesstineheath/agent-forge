"use client";

import { cn } from "@/lib/utils";
import { RefreshCw, Bot } from "lucide-react";
import { useWorkItems, useTLMMemory, useATCMetrics, useFeedbackCompiler } from "@/lib/hooks";
import { CostSummary } from "@/components/cost-summary";
import { TLMAgentCard } from "@/components/tlm-agent-card";
import { ATCAgentCard } from "@/components/atc-agent-card";
import { PAAgentRow } from "@/components/pa-agent-row";
import { AgentDashboard } from "@/components/agent-dashboard";
import { AgentTraceViewer } from "@/components/agent-trace-viewer";

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

export default function AgentsPage() {
  const { data: workItems, isLoading: workItemsLoading } = useWorkItems();
  const { data: tlmMemory, isLoading: tlmLoading, error: tlmError } = useTLMMemory();
  const { data: atcMetrics, isLoading: atcLoading, error: atcError } = useATCMetrics();
  const { data: feedbackCompiler } = useFeedbackCompiler();

  const codeReviewerRate =
    tlmMemory && tlmMemory.stats.totalAssessed > 0
      ? (tlmMemory.stats.correct / tlmMemory.stats.totalAssessed) * 100
      : null;

  const specReviewerRate =
    tlmMemory && tlmMemory.stats.totalAssessed > 0
      ? ((tlmMemory.stats.totalAssessed - tlmMemory.stats.causedIssues) /
          tlmMemory.stats.totalAssessed) *
        100
      : null;

  const outcomeTrackerRate = tlmMemory ? 100 : null;

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
          {/* Cost Overview */}
          <section>
            {workItemsLoading ? (
              <div className="rounded-xl card-elevated bg-surface-1 p-4 animate-pulse">
                <div className="h-6 w-32 bg-muted rounded mb-4" />
                <div className="grid grid-cols-3 gap-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-12 bg-muted rounded" />
                  ))}
                </div>
              </div>
            ) : (
              <CostSummary workItems={workItems ?? []} />
            )}
          </section>

          {/* Agent Heartbeat Dashboard */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Agent Heartbeat
              </p>
              <span className="text-[10px] text-muted-foreground/40">(real-time health)</span>
            </div>
            <AgentDashboard />
          </div>

          {/* Agent Traces */}
          <AgentTraceViewer />

          {/* Control Plane */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                Control Plane
              </p>
              <span className="text-[10px] text-muted-foreground/40">(orchestration)</span>
            </div>
            <ATCAgentCard
              metrics={atcMetrics ?? null}
              isLoading={atcLoading}
              error={atcError}
            />
          </div>

          {/* TLM Agents */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                TLM Agents
              </p>
              <span className="text-[10px] text-muted-foreground/40">(agent-forge pipeline)</span>
            </div>
            {tlmLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-xl card-elevated bg-surface-1 p-4 animate-pulse"
                  >
                    <div className="flex items-center gap-4">
                      <div className="h-12 w-12 bg-muted rounded-full" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-32 bg-muted rounded" />
                        <div className="h-3 w-48 bg-muted rounded" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : tlmError ? (
              <div className="rounded-xl card-elevated bg-surface-1 p-4">
                <p className="text-sm text-muted-foreground/60">
                  Unable to load TLM memory data. The API may be unavailable or the
                  memory file may not exist yet.
                </p>
              </div>
            ) : (
              <>
                <div className="text-xs text-muted-foreground mb-1">
                  Overall quality:{" "}
                  {codeReviewerRate != null
                    ? `${Math.round(codeReviewerRate)}% correct rate`
                    : "no data yet"}
                  {tlmMemory &&
                    `. ${tlmMemory.stats.causedIssues} caused downstream issues.`}
                </div>
                <div className="space-y-2">
                  <TLMAgentCard
                    name="Code Reviewer"
                    stats={tlmMemory?.stats ?? null}
                    hotPatterns={tlmMemory?.hotPatterns ?? []}
                    recentOutcomes={tlmMemory?.recentOutcomes ?? []}
                    successRate={codeReviewerRate}
                    lastRun={tlmMemory?.stats.lastAssessment ?? null}
                    status="active"
                  />
                  <TLMAgentCard
                    name="Spec Reviewer"
                    stats={tlmMemory?.stats ?? null}
                    hotPatterns={[]}
                    recentOutcomes={[]}
                    successRate={specReviewerRate}
                    lastRun={tlmMemory?.stats.lastAssessment ?? null}
                    status="active"
                  />
                  <TLMAgentCard
                    name="Outcome Tracker"
                    stats={tlmMemory?.stats ?? null}
                    hotPatterns={[]}
                    recentOutcomes={[]}
                    successRate={outcomeTrackerRate}
                    lastRun={tlmMemory?.stats.lastAssessment ?? null}
                    status="active"
                  />
                  <TLMAgentCard
                    name="QA Agent"
                    stats={null}
                    hotPatterns={[]}
                    recentOutcomes={[]}
                    successRate={null}
                    lastRun={null}
                    status="active"
                    subtitle="Post-deployment verification — advisory mode"
                  />
                  <TLMAgentCard
                    name="Feedback Compiler"
                    stats={null}
                    hotPatterns={[]}
                    recentOutcomes={[]}
                    successRate={null}
                    lastRun={feedbackCompiler?.lastRun ?? null}
                    status={feedbackCompiler?.status ?? "idle"}
                    subtitle={
                      feedbackCompiler?.lastRun
                        ? `${feedbackCompiler.patternsDetected} patterns detected · ${feedbackCompiler.changesProposed} changes proposed · last run ${new Date(feedbackCompiler.lastRun).toLocaleDateString()}`
                        : "No runs yet"
                    }
                  />
                </div>
              </>
            )}
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
