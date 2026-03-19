import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listWorkflowRuns } from "@/lib/github";

const REPO = "jamesstineheath/agent-forge";

const TLM_WORKFLOWS = [
  { name: "TLM Code Reviewer", file: "tlm-review.yml" },
  { name: "TLM Spec Reviewer", file: "tlm-spec-review.yml" },
  { name: "TLM Outcome Tracker", file: "tlm-outcome-tracker.yml" },
  { name: "TLM Feedback Compiler", file: "tlm-feedback-compiler.yml" },
  { name: "TLM Trace Reviewer", file: "tlm-trace-reviewer.yml" },
  { name: "TLM QA Agent", file: "tlm-qa-agent.yml" },
];

export interface TlmWorkflowStatus {
  name: string;
  workflowFile: string;
  lastRunAt: string | null;
  lastConclusion: string | null;
  totalRuns: number;
  successRate: number | null;
}

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const results = await Promise.all(
    TLM_WORKFLOWS.map(async (workflow): Promise<TlmWorkflowStatus> => {
      try {
        const data = await listWorkflowRuns(REPO, {
          workflow: workflow.file,
          perPage: 10,
        });
        const runs = data.workflow_runs;
        const completedRuns = runs.filter((r) => r.conclusion !== null);
        const successCount = completedRuns.filter(
          (r) => r.conclusion === "success"
        ).length;
        const lastRun = runs[0] ?? null;
        return {
          name: workflow.name,
          workflowFile: workflow.file,
          lastRunAt: lastRun?.created_at ?? null,
          lastConclusion: lastRun?.conclusion ?? null,
          totalRuns: runs.length,
          successRate:
            completedRuns.length > 0
              ? successCount / completedRuns.length
              : null,
        };
      } catch (err) {
        console.error(`Failed to fetch runs for ${workflow.file}:`, err);
        return {
          name: workflow.name,
          workflowFile: workflow.file,
          lastRunAt: null,
          lastConclusion: null,
          totalRuns: 0,
          successRate: null,
        };
      }
    })
  );

  return NextResponse.json({
    workflows: results,
    fetchedAt: new Date().toISOString(),
  });
}
