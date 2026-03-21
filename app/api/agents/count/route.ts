import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { listRepos } from "@/lib/repos";
import { listWorkflowRuns } from "@/lib/github";

// The 4 autonomous cron agents defined in ADR-010
const CRON_AGENTS = [
  "Dispatcher",
  "Health Monitor",
  "Project Manager",
  "Supervisor",
] as const;

// TLM workflow file names present in each data-plane repo
const TLM_WORKFLOW_FILES = [
  "tlm-review.yml",
  "tlm-spec-review.yml",
  "tlm-outcome-tracker.yml",
  "tlm-feedback-compiler.yml",
  "tlm-trace-reviewer.yml",
  "tlm-qa-agent.yml",
] as const;

export interface AgentCountData {
  cronAgents: number;
  tlmAgents: number;
  total: number;
  paAgentsAvailable: boolean;
  feedbackCompilerLastRun: string | null;
  cronAgentNames: readonly string[];
}

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const cronAgentCount = CRON_AGENTS.length;

    let tlmAgentCount = 0;
    let feedbackCompilerLastRun: string | null = null;

    try {
      const repos = await listRepos();
      // Each registered repo can have up to TLM_WORKFLOW_FILES.length TLM agents
      const repoCount = repos.length;
      tlmAgentCount = repoCount * TLM_WORKFLOW_FILES.length;

      // Fetch last Feedback Compiler run from GitHub Actions
      const targetRepo = repos[0];
      if (targetRepo) {
        try {
          const data = await listWorkflowRuns(targetRepo.fullName, {
            workflow: "tlm-feedback-compiler.yml",
            status: "completed",
            perPage: 1,
          });
          const lastRun = data.workflow_runs[0];
          if (lastRun && lastRun.conclusion === "success") {
            feedbackCompilerLastRun = lastRun.created_at ?? null;
          }
        } catch {
          // Workflow may not exist yet — leave as null
        }
      }
    } catch {
      // Repo registry unavailable — TLM count stays 0
    }

    // PA agents: check if PA MCP endpoint env var is configured
    const paAgentsAvailable = !!(
      process.env.PA_MCP_ENDPOINT || process.env.PA_AGENT_URL
    );

    const response: AgentCountData = {
      cronAgents: cronAgentCount,
      tlmAgents: tlmAgentCount,
      total: cronAgentCount + tlmAgentCount,
      paAgentsAvailable,
      feedbackCompilerLastRun,
      cronAgentNames: CRON_AGENTS,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("[agents/count] Error fetching agent count:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent count" },
      { status: 500 }
    );
  }
}
