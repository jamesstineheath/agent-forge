/**
 * Handoff Dispatch MCP tools.
 * Generate, push, and monitor handoff files through the pipeline.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepo, GITHUB_OWNER } from "../util";
import {
  createBranch,
  pushFile,
  listWorkflowRuns,
  listPullRequests,
} from "@/lib/github";

export function registerHandoffTools(server: McpServer) {
  server.tool(
    "generate_handoff",
    "Generate a v3 handoff file from a description. Returns the markdown content without pushing it. Use push_handoff to actually dispatch it.",
    {
      number: z.number().describe("Handoff number (e.g., 33)"),
      title: z.string().describe("Short kebab-case title (e.g., 'add-retry-logic')"),
      branch: z.string().describe("Branch name (e.g., 'feat/add-retry-logic')"),
      context: z.string().describe("Problem statement and background"),
      steps: z.array(z.string()).describe("Ordered list of implementation steps (Step 0 is auto-generated)"),
      preflight_checks: z.array(z.string()).optional().describe("Pre-flight self-check items"),
      priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
      type: z.enum(["feature", "bugfix", "refactor", "test", "docs", "chore"]).default("feature"),
      risk_level: z.enum(["low", "medium", "high"]).default("low"),
      complexity: z.enum(["simple", "moderate", "complex"]).default("moderate"),
      max_budget: z.number().default(5).optional().describe("Max budget in USD (default: $5)"),
      depends_on: z.string().optional().describe("Comma-separated dependency IDs or 'None'"),
      target_repo: z.string().optional().describe("Target repo (default: agent-forge)"),
      post_merge_note: z.string().optional(),
    },
    async (params) => {
      const date = new Date().toISOString().split("T")[0];

      const preflight = params.preflight_checks?.length
        ? params.preflight_checks.map((c) => `- [ ] ${c}`).join("\n")
        : `- [ ] Branch \`${params.branch}\` does not already exist\n- [ ] No conflicting PRs open for the same area`;

      const steps = params.steps
        .map((s, i) => `## Step ${i + 1}: ${s}`)
        .join("\n\n");

      const handoff = `# Handoff ${params.number}: ${params.title}

## Metadata
- Branch: \`${params.branch}\`
- Priority: ${params.priority}
- Model: opus
- Type: ${params.type}
- Max Budget: $${params.max_budget ?? 5}
- Risk Level: ${params.risk_level}
- Complexity: ${params.complexity}
- Depends On: ${params.depends_on ?? "None"}
- Date: ${date}
- Executor: Claude Code (GitHub Actions)

## Context

${params.context}

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

${preflight}

## Step 0: Branch, commit handoff, push

Create branch \`${params.branch}\` from \`main\`. Commit this handoff file. Push.

${steps}

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: \`git add -A && git commit -m "wip: ${params.title} (incomplete)"\`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
\`\`\`json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "${params.branch}",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
\`\`\`
${params.post_merge_note ? `\n## Post-merge Note\n\n${params.post_merge_note}\n` : ""}`;

      return {
        content: [{ type: "text" as const, text: handoff }],
      };
    }
  );

  server.tool(
    "push_handoff",
    "Push a handoff file to a branch in the repo, triggering the TLM Spec Review pipeline. This creates the branch if needed, commits the handoff file, and the push event fires the spec review workflow. Note: GitHub API pushes may not always trigger workflow events. If the spec review doesn't fire within a few minutes, use retrigger_workflow with 'tlm-spec-review.yml'.",
    {
      filename: z.string().describe("Handoff filename (e.g., '33-add-retry-logic.md')"),
      content: z.string().describe("Full handoff markdown content"),
      branch: z.string().describe("Branch to push to"),
      directory: z.string().default("handoffs/awaiting_handoff").optional(),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const filePath = `${params.directory ?? "handoffs/awaiting_handoff"}/${params.filename}`;

      // Create branch from main
      try {
        await createBranch(repo, params.branch);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("Reference already exists")) {
          throw e;
        }
      }

      // Push the handoff file
      const result = await pushFile(repo, params.branch, filePath, params.content,
        `handoff: ${params.filename.replace(".md", "")}`
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            pushed: result.pushed,
            path: filePath,
            branch: params.branch,
            next: `TLM Spec Review should trigger automatically. If it doesn't fire within 2-3 minutes, use retrigger_workflow with workflow='tlm-spec-review.yml' and ref='${params.branch}'`,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "monitor_handoff",
    "Check the end-to-end lifecycle status of a handoff by branch name. Looks at workflow runs, PRs, and checks to determine where in the pipeline (spec review -> execute -> CI -> code review -> merge) a handoff currently is.",
    {
      branch: z.string().describe("Branch name to check"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);

      const [specReview, execute, codeReview, prs] = await Promise.allSettled([
        listWorkflowRuns(repo, { workflow: "tlm-spec-review.yml", branch: params.branch, perPage: 3 }),
        listWorkflowRuns(repo, { workflow: "execute-handoff.yml", branch: params.branch, perPage: 3 }),
        listWorkflowRuns(repo, { workflow: "tlm-review.yml", branch: params.branch, perPage: 3 }),
        listPullRequests(repo, { state: "all", head: `${GITHUB_OWNER}:${params.branch}` }),
      ]);

      const extractRuns = (result: PromiseSettledResult<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; created_at: string; url: string }> }>) => {
        if (result.status === "fulfilled") return result.value.workflow_runs;
        return [];
      };

      const specRuns = extractRuns(specReview as PromiseSettledResult<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; created_at: string; url: string }> }>);
      const execRuns = extractRuns(execute as PromiseSettledResult<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; created_at: string; url: string }> }>);
      const reviewRuns = extractRuns(codeReview as PromiseSettledResult<{ workflow_runs: Array<{ id: number; status: string; conclusion: string | null; created_at: string; url: string }> }>);
      const prList = prs.status === "fulfilled" ? prs.value : [];

      let stage = "unknown";
      if (prList.some((p) => p.state === "closed" && p.merged_at)) {
        stage = "merged";
      } else if (reviewRuns.some((r) => r.status === "in_progress")) {
        stage = "code_review";
      } else if (reviewRuns.some((r) => r.conclusion === "success")) {
        stage = "review_complete";
      } else if (prList.length > 0) {
        stage = "pr_open";
      } else if (execRuns.some((r) => r.status === "in_progress")) {
        stage = "executing";
      } else if (execRuns.some((r) => r.conclusion === "success")) {
        stage = "executed";
      } else if (specRuns.some((r) => r.status === "in_progress")) {
        stage = "spec_review";
      } else if (specRuns.some((r) => r.conclusion === "success")) {
        stage = "spec_reviewed";
      } else if (specRuns.length === 0 && execRuns.length === 0) {
        stage = "not_started";
      } else {
        const anyFailed = [...specRuns, ...execRuns, ...reviewRuns].some((r) => r.conclusion === "failure");
        stage = anyFailed ? "failed" : "unknown";
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            branch: params.branch,
            stage,
            spec_review: specRuns,
            execute: execRuns,
            code_review: reviewRuns,
            pull_requests: prList,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "list_active_handoffs",
    "List all currently in-flight handoffs by checking for open PRs and running workflows. Gives a birds-eye view of what the pipeline is working on.",
    {
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);

      const [openPRs, runningWorkflows] = await Promise.all([
        listPullRequests(repo, { state: "open", perPage: 20 }),
        listWorkflowRuns(repo, { status: "in_progress", perPage: 20 }),
      ]);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            open_prs: openPRs,
            running_workflows: runningWorkflows.workflow_runs,
          }, null, 2),
        }],
      };
    }
  );
}
