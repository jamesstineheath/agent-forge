/**
 * GitHub Read MCP tools.
 * Read repo files, list PRs, and get PR diffs without leaving Claude.ai.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepo } from "../util";
import {
  readRepoFile,
  listPullRequests,
  getPRByNumber,
  getPRFilesDetailed,
} from "@/lib/github";

export function registerGitHubReadTools(server: McpServer) {
  server.tool(
    "get_repo_file",
    "Read a single file from a GitHub repo. Use this to check STATUS.md, CLAUDE.md, system maps, or any other file without leaving the conversation.",
    {
      repo: z.string().describe("Repo name (e.g., 'agent-forge', 'personal-assistant'). Owner is always jamesstineheath."),
      path: z.string().describe("File path relative to repo root (e.g., 'STATUS.md', 'docs/SYSTEM_MAP.md')"),
      branch: z.string().optional().describe("Branch to read from (default: main)"),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const content = await readRepoFile(repo, params.path, params.branch);
      if (!content) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${params.path} in ${repo}${params.branch ? ` (branch: ${params.branch})` : ""}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "get_recent_prs",
    "List recent pull requests for a repo. Use this to confirm PRs merged, check what's open, or review recent activity.",
    {
      repo: z.string().describe("Repo name (e.g., 'agent-forge', 'personal-assistant')"),
      state: z.enum(["open", "closed", "all"]).optional().describe("Filter by PR state (default: all)"),
      limit: z.number().optional().describe("Max results to return (default: 5, max: 20)"),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const limit = Math.min(params.limit ?? 5, 20);
      const prs = await listPullRequests(repo, {
        state: params.state ?? "all",
        perPage: limit,
      });
      const result = prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        merged: pr.merged_at !== null,
        branch: pr.head,
        updated_at: pr.updated_at,
        html_url: pr.url,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_pr_diff",
    "Get the diff summary for a specific PR — changed files, additions, deletions. No full file contents, just the overview.",
    {
      repo: z.string().describe("Repo name (e.g., 'agent-forge', 'personal-assistant')"),
      pr_number: z.number().describe("PR number"),
    },
    async (params) => {
      const repo = resolveRepo(params.repo);
      const [pr, files] = await Promise.all([
        getPRByNumber(repo, params.pr_number),
        getPRFilesDetailed(repo, params.pr_number),
      ]);
      if (!pr) {
        return {
          content: [{ type: "text" as const, text: `PR #${params.pr_number} not found in ${repo}` }],
          isError: true,
        };
      }
      const result = {
        title: pr.title,
        state: pr.state,
        merged: pr.mergedAt !== null,
        changed_files: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        files,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );
}
