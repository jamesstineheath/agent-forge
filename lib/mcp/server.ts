/**
 * Agent Forge MCP Server factory.
 * Creates an MCP server with all 26 tools registered.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPipelineTools } from "./tools/pipeline";
import { registerWorkItemTools } from "./tools/work-items";
import { registerTLMTools } from "./tools/tlm";
import { registerHandoffTools } from "./tools/handoffs";
import { registerPMTools } from "./tools/pm";
import { registerGitHubReadTools } from "./tools/github-read";
import { registerBugTools } from "./tools/bugs";
import { registerPlanTools } from "./tools/plans";
import { registerSecurityTools } from "./tools/security";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-forge",
    version: "3.0.0",
  });

  registerPipelineTools(server);
  registerWorkItemTools(server); // Legacy: kept for historical data access
  registerPlanTools(server);     // Pipeline v2: plan-based execution
  registerTLMTools(server);
  registerHandoffTools(server);
  registerPMTools(server);
  registerGitHubReadTools(server);
  registerBugTools(server);
  registerSecurityTools(server);

  return server;
}
