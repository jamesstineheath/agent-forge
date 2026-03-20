/**
 * Pipeline Operations MCP tools.
 * Workflow status, retrigger, health checks, PR checks.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepo } from "../util";
import {
  listWorkflowRuns,
  getWorkflowRunDetail,
  rerunWorkflow,
  rerunFailedJobs,
  triggerWorkflow,
  getPipelineHealth,
  getPullRequestChecks,
  listPullRequests,
} from "@/lib/github";

export function registerPipelineTools(server: McpServer) {
  server.tool(
    "list_workflow_runs",
    "List recent GitHub Actions workflow runs. Filter by workflow name, branch, or status.",
    {
      workflow: z.string().optional().describe(
        "Workflow filename (e.g., 'ci.yml', 'execute-handoff.yml', 'tlm-review.yml', 'tlm-spec-review.yml', 'handoff-orchestrator.yml')"
      ),
      branch: z.string().optional().describe("Filter by branch name"),
      status: z.enum(["completed", "in_progress", "queued", "requested", "waiting"]).optional(),
      limit: z.number().min(1).max(30).default(10).optional(),
      repo: z.string().optional().describe("Repo name override (default: agent-forge)"),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const data = await listWorkflowRuns(repo, {
        workflow: params.workflow,
        branch: params.branch,
        status: params.status,
        perPage: params.limit,
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ total: data.total_count, runs: data.workflow_runs }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow_run",
    "Get detailed info about a specific workflow run including all jobs and their step-level status. Use this to diagnose exactly where a run failed.",
    {
      run_id: z.coerce.number().describe("The workflow run ID"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const result = await getWorkflowRunDetail(repo, params.run_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "retrigger_workflow",
    "Re-run a failed or completed workflow run. Can re-run the entire run or just the failed jobs. Also supports dispatching a workflow manually with inputs.",
    {
      run_id: z.coerce.number().optional().describe("Run ID to re-run (use this OR workflow, not both)"),
      failed_only: z.boolean().default(false).optional().describe("Only re-run failed jobs"),
      workflow: z.string().optional().describe("Workflow filename to dispatch (e.g., 'tlm-spec-review.yml')"),
      ref: z.string().optional().describe("Branch/ref for workflow_dispatch (default: main)"),
      inputs: z.record(z.string(), z.string()).optional().describe("Inputs for workflow_dispatch"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);

      if (params.run_id) {
        if (params.failed_only) {
          await rerunFailedJobs(repo, params.run_id);
        } else {
          await rerunWorkflow(repo, params.run_id);
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ rerun: true, runId: params.run_id, failedOnly: params.failed_only ?? false }, null, 2) }],
        };
      }

      if (params.workflow) {
        await triggerWorkflow(repo, params.workflow, params.ref ?? "main", params.inputs);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ triggered: true, workflow: params.workflow, ref: params.ref ?? "main" }, null, 2) }],
        };
      }

      return {
        content: [{ type: "text" as const, text: "Provide either run_id (to re-run) or workflow (to dispatch)" }],
        isError: true,
      };
    }
  );

  server.tool(
    "check_pipeline_health",
    "Get a health overview of all Agent Forge pipeline workflows. Shows the 3 most recent runs for each workflow with status/conclusion. Use this as a first diagnostic when something seems wrong.",
    {
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const health = await getPipelineHealth(repo);

      const summary = health.map((wf) => {
        const latest = wf.recent[0];
        const failCount = wf.recent.filter((r) => r.conclusion === "failure").length;
        return {
          workflow: wf.workflow,
          status: latest
            ? latest.conclusion === "failure"
              ? "FAILING"
              : latest.status === "in_progress"
                ? "RUNNING"
                : "OK"
            : "NO RUNS",
          recent_failures: failCount,
          latest: latest ?? null,
          runs: wf.recent,
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  server.tool(
    "get_pr_checks",
    "Get the CI check status for a pull request. Shows all check runs with their status and conclusion. Useful for diagnosing why a PR is blocked.",
    {
      pr_number: z.coerce.number().describe("Pull request number"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const result = await getPullRequestChecks(repo, params.pr_number);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "toggle_kill_switch",
    "Toggle the pipeline kill switch ON (stop all pipeline activity) or OFF (resume). Requires a PIN for safety. Use get_pipeline_health to check current kill switch state before toggling.",
    {
      enabled: z.boolean().describe("true = stop pipeline, false = resume pipeline"),
      pin: z.string().describe("Safety PIN required to toggle the kill switch"),
    },
    async (params) => {
      const { setKillSwitch } = await import("@/lib/atc/kill-switch");

      const expectedPin = process.env.KILL_SWITCH_PIN;
      if (!expectedPin || params.pin !== expectedPin) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Invalid PIN" }, null, 2) }],
          isError: true,
        };
      }

      const state = await setKillSwitch(params.enabled, "mcp");
      console.log(`[kill-switch] Pipeline ${params.enabled ? "STOPPED" : "STARTED"} via MCP at ${state.toggledAt}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            enabled: state.enabled,
            toggledAt: state.toggledAt,
            toggledBy: state.toggledBy,
            message: state.enabled
              ? "Pipeline STOPPED. All cron agents will skip their next cycle."
              : "Pipeline RESUMED. Cron agents will execute on their next cycle.",
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_kill_switch_state",
    "Check the current state of the pipeline kill switch. Returns whether it's enabled, when it was last toggled, and by whom.",
    {},
    async () => {
      const { getKillSwitchState } = await import("@/lib/atc/kill-switch");
      const state = await getKillSwitchState();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
      };
    }
  );

  server.tool(
    "reindex_repo",
    "Trigger a full knowledge graph re-index for a target repo. Returns entity and relationship counts. Use this after significant code changes to keep the graph fresh.",
    {
      repo: z.string().describe("Repo short name (e.g., 'personal-assistant') or full name (e.g., 'jamesstineheath/personal-assistant')"),
    },
    async (params) => {
      const { fullIndex } = await import("@/lib/knowledge-graph/indexer");
      const { listRepos, getRepo } = await import("@/lib/repos");

      // Resolve short name to full name
      let fullName = params.repo;
      if (!params.repo.includes("/")) {
        const repoIndex = await listRepos();
        const entry = repoIndex.find(
          (r) => r.id === params.repo || r.fullName.endsWith(`/${params.repo}`),
        );
        if (entry) fullName = entry.fullName;
        else {
          return {
            content: [{ type: "text" as const, text: `Repo not found: ${params.repo}` }],
            isError: true,
          };
        }
      }

      const start = Date.now();
      const result = await fullIndex(fullName);
      const durationMs = Date.now() - start;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            repo: fullName,
            entityCount: result.entityCount,
            durationMs,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "list_prs",
    "List pull requests. Defaults to open PRs. Shows title, branch, status, and mergeable state.",
    {
      state: z.enum(["open", "closed", "all"]).default("open").optional(),
      limit: z.number().min(1).max(30).default(10).optional(),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const prs = await listPullRequests(repo, {
        state: params.state,
        perPage: params.limit,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(prs, null, 2) }],
      };
    }
  );
}
