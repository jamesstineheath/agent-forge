"use client";

import { useWorkItems, useTLMMemory } from "@/lib/hooks";
import { CostSummary } from "@/components/cost-summary";
import { TLMAgentCard } from "@/components/tlm-agent-card";
import { PAAgentRow } from "@/components/pa-agent-row";

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

  const codeReviewerRate =
    tlmMemory && tlmMemory.stats.totalAssessed > 0
      ? (tlmMemory.stats.correct / tlmMemory.stats.totalAssessed) * 100
      : null;

  // Spec Reviewer: items where spec-reviewed handoffs didn't lead to caused_issues
  const specReviewerRate =
    tlmMemory && tlmMemory.stats.totalAssessed > 0
      ? ((tlmMemory.stats.totalAssessed - tlmMemory.stats.causedIssues) /
          tlmMemory.stats.totalAssessed) *
        100
      : null;

  // Outcome Tracker: always 100% since it classifies, doesn't decide
  const outcomeTrackerRate = tlmMemory ? 100 : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Agents</h1>
        <p className="text-muted-foreground">
          Performance, cost, and quality monitoring for all agents.
        </p>
      </div>

      {/* Cost Overview */}
      <section>
        {workItemsLoading ? (
          <div className="rounded-lg border bg-card p-4 animate-pulse">
            <div className="h-6 w-32 bg-muted rounded mb-4" />
            <div className="grid grid-cols-4 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-12 bg-muted rounded" />
              ))}
            </div>
          </div>
        ) : (
          <CostSummary workItems={workItems ?? []} />
        )}
      </section>

      {/* TLM Agents */}
      <section>
        <h2 className="text-lg font-semibold mb-4">TLM Agents</h2>
        {tlmLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border bg-card p-4 animate-pulse">
                <div className="flex items-center gap-4">
                  <div className="h-16 w-16 bg-muted rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 bg-muted rounded" />
                    <div className="h-3 w-48 bg-muted rounded" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : tlmError ? (
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              Unable to load TLM memory data. The API may be unavailable or the memory file
              may not exist yet.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
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
              name="Feedback Compiler"
              stats={null}
              hotPatterns={[]}
              recentOutcomes={[]}
              successRate={null}
              lastRun={null}
              status="in-pipeline"
            />
          </div>
        )}
      </section>

      {/* PA Agents */}
      <section>
        <h2 className="text-lg font-semibold mb-4">PA Agents</h2>
        <div className="space-y-2">
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
      </section>

      {/* Self-improvement loop */}
      <section>
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-lg font-semibold mb-2">Self-Improvement Loop</h2>
          <p className="text-sm text-muted-foreground mb-3">
            Agent Forge uses a three-layer evaluation framework: Action Ledger for logging
            consequential actions, Outcome Assessment for classifying results, and Agent Memory
            for per-agent learning.
          </p>
          <div className="rounded-md bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
              Feedback Compiler (ADR-009) &mdash; In Pipeline
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              The Feedback Compiler will analyze outcome patterns from the Outcome Tracker and
              propose prompt changes via PR, closing the observation-to-adaptation loop. Currently
              in design phase.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
