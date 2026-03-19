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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-forge",
    version: "2.0.0",
  });

  registerPipelineTools(server);
  registerWorkItemTools(server);
  registerTLMTools(server);
  registerHandoffTools(server);
  registerPMTools(server);

  return server;
}
