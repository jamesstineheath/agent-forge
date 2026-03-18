/**
 * TLM Observability MCP tools.
 * Read TLM memory, action ledger, handoffs, ADRs, system map, workflows, scorecard.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepo } from "../util";
import {
  readRepoFile,
  listDirectory,
  listWorkflowRuns,
  getPipelineHealth,
} from "@/lib/github";

export function registerTLMTools(server: McpServer) {
  server.tool(
    "read_tlm_memory",
    "Read the TLM shared memory file (docs/tlm-memory.md). This is the rolling context shared across all TLM agents (Spec Reviewer, Code Reviewer, Outcome Tracker). Contains recent decisions, patterns, and accumulated knowledge.",
    {
      repo: z.string().optional().describe("Repo to read from (default: agent-forge). Use 'personal-assistant' for PA TLM memory."),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const content = await readRepoFile(repo, "docs/tlm-memory.md");
      if (!content) {
        return { content: [{ type: "text" as const, text: "TLM memory file not found" }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "read_action_ledger",
    "Read the TLM Action Ledger (docs/tlm-action-ledger.json). This is the persistent, never-pruned history of all TLM agent actions and their outcomes. Use this to analyze patterns in agent behavior, success rates, and failure modes.",
    {
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const content = await readRepoFile(repo, "docs/tlm-action-ledger.json");
      if (!content) {
        return { content: [{ type: "text" as const, text: "Action ledger not found" }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "read_handoff_file",
    "Read a specific handoff file from the repo. Handoffs live in handoffs/ directory and follow v3 format with metadata, steps, pre-flight checks, and abort protocols.",
    {
      path: z.string().describe("Path to handoff file (e.g., 'handoffs/awaiting_handoff/15-feedback-compiler-v1.md')"),
      ref: z.string().optional().describe("Branch or commit ref (default: main)"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const content = await readRepoFile(repo, params.path, params.ref);
      if (!content) {
        return { content: [{ type: "text" as const, text: `Handoff not found: ${params.path}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "list_handoff_files",
    "List handoff files in the repository. Shows files in handoffs/ directory tree.",
    {
      subdirectory: z.string().optional().describe("Subdirectory within handoffs/ (e.g., 'awaiting_handoff', 'completed')"),
      ref: z.string().optional(),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const path = params.subdirectory ? `handoffs/${params.subdirectory}` : "handoffs";
      const files = await listDirectory(repo, path, params.ref);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(files, null, 2) }],
      };
    }
  );

  server.tool(
    "read_system_map",
    "Read docs/SYSTEM_MAP.md for a high-level overview of the Agent Forge architecture, file layout, and component relationships.",
    {
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const content = await readRepoFile(repo, "docs/SYSTEM_MAP.md");
      if (!content) {
        return { content: [{ type: "text" as const, text: "System map not found" }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "read_adr",
    "Read an Architecture Decision Record. ADRs document key architectural choices in the project.",
    {
      number: z.number().describe("ADR number (e.g., 5 for ADR-005)"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const padded = String(params.number).padStart(3, "0");
      const content = await readRepoFile(repo, `docs/adr/ADR-${padded}.md`);
      if (!content) {
        return { content: [{ type: "text" as const, text: `ADR-${padded} not found` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "read_workflow",
    "Read a GitHub Actions workflow YAML file. Useful for understanding trigger conditions, inputs, and steps when debugging pipeline behavior.",
    {
      workflow: z.string().describe("Workflow filename (e.g., 'execute-handoff.yml')"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const content = await readRepoFile(repo, `.github/workflows/${params.workflow}`);
      if (!content) {
        return { content: [{ type: "text" as const, text: `Workflow not found: ${params.workflow}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "pipeline_scorecard",
    "Generate a scorecard of pipeline performance. Analyzes recent workflow runs across all pipeline workflows to compute success rates, average durations, and failure patterns.",
    {
      days: z.number().min(1).max(30).default(7).optional().describe("Look-back period in days"),
      repo: z.string().optional(),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const health = await getPipelineHealth(repo);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - (params.days ?? 7));

      const scorecard = health.map((wf) => {
        const recentRuns = wf.recent.filter((r) => new Date(r.created_at) >= cutoff);
        const total = recentRuns.length;
        const successes = recentRuns.filter((r) => r.conclusion === "success").length;
        const failures = recentRuns.filter((r) => r.conclusion === "failure").length;

        return {
          workflow: wf.workflow,
          runs: total,
          successes,
          failures,
          success_rate: total > 0 ? `${Math.round((successes / total) * 100)}%` : "N/A",
          latest_conclusion: recentRuns[0]?.conclusion ?? "none",
        };
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(scorecard, null, 2) }],
      };
    }
  );
}
