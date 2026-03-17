"use client";

import { RefreshCw } from "lucide-react";
import { useWorkItems, useTLMMemory, useATCMetrics, useFeedbackCompiler } from "@/lib/hooks";
import { CostSummary } from "@/components/cost-summary";
import { TLMAgentCard } from "@/components/tlm-agent-card";
import { ATCAgentCard } from "@/components/atc-agent-card";
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
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100 mb-1">Agents</h1>
        <div className="text-xs text-zinc-500">
          Performance, quality, and cost across all agent types
        </div>
      </div>

      {/* Cost Overview */}
      <section>
        {workItemsLoading ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse">
            <div className="h-6 w-32 bg-zinc-800 rounded mb-4" />
            <div className="grid grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 bg-zinc-800 rounded" />
              ))}
            </div>
          </div>
        ) : (
          <CostSummary workItems={workItems ?? []} />
        )}
      </section>

      {/* Control Plane */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            Control Plane
          </div>
          <div className="text-[10px] text-zinc-600">(orchestration)</div>
        </div>
        <ATCAgentCard
          metrics={atcMetrics ?? null}
          isLoading={atcLoading}
          error={atcError}
        />
      </div>

      {/* TLM Agents */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            TLM Agents
          </div>
          <div className="text-[10px] text-zinc-600">(agent-forge pipeline)</div>
        </div>
        {tlmLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse"
              >
                <div className="flex items-center gap-4">
                  <div className="h-12 w-12 bg-zinc-800 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-32 bg-zinc-800 rounded" />
                    <div className="h-3 w-48 bg-zinc-800 rounded" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : tlmError ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-500">
              Unable to load TLM memory data. The API may be unavailable or the
              memory file may not exist yet.
            </p>
          </div>
        ) : (
          <>
            <div className="text-xs text-zinc-500 mb-1">
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
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
            PA Agents
          </div>
          <div className="text-[10px] text-zinc-600">(personal-assistant)</div>
        </div>
        <div className="text-xs text-zinc-500 mb-1">
          Evaluation framework (ADR-007) active for Tier 1 agents. Tier 2/3
          agents collect actions but lack assessment signal.
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800/50">
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
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <RefreshCw size={12} className="text-zinc-500" />
          <span className="text-xs font-medium text-zinc-400">
            Self-improvement loop
          </span>
        </div>
        <div className="text-xs text-zinc-500">
          The Feedback Compiler (ADR-009) analyzes outcome patterns weekly
          and proposes prompt changes via PR, closing the loop between
          observation (Outcome Tracker) and adaptation (prompt/config changes),
          with human approval as the gate.
        </div>
      </div>
    </div>
  );
}
