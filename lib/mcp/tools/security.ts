/**
 * Security MCP tools.
 * Query open security alerts across registered repos.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveRepo } from "../util";
import { getSecurityAlerts, getSecurityOverview } from "@/lib/security";
import { listRepos } from "@/lib/repos";

export function registerSecurityTools(server: McpServer) {
  server.tool(
    "get_security_alerts",
    "Get open security alerts (Dependabot, CodeQL, secret scanning) for a specific repo or all registered repos. Returns alert counts grouped by severity.",
    {
      repo: z.string().optional().describe("Repo name (e.g., 'agent-forge'). Omit to get alerts for all registered repos."),
    },
    async (params) => {
      if (params.repo) {
        const fullRepo = resolveRepo(params.repo);
        const summary = await getSecurityAlerts(fullRepo);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      }

      const repoIndex = await listRepos();
      const repoNames = repoIndex.map((r) => r.fullName);
      if (repoNames.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No repos registered." }],
        };
      }

      const overview = await getSecurityOverview(repoNames);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(overview, null, 2) }],
      };
    }
  );
}
