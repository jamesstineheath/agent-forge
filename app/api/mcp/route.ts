import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextRequest, NextResponse } from "next/server";
import {
  createFastLaneItemSchema,
  getItemStatusSchema,
  listRecentItemsSchema,
  handleCreateFastLaneItem,
  handleGetItemStatus,
  handleListRecentItems,
} from "@/lib/mcp-tools";

function checkAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  const secret = process.env.AGENT_FORGE_API_SECRET;
  if (!secret) return false;
  return authHeader === `Bearer ${secret}`;
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-forge",
    version: "1.0.0",
  });

  server.registerTool("create_fast_lane_item", {
    description:
      "Create a fast-lane work item in Agent Forge. Use this to queue dev tasks for autonomous execution.",
    inputSchema: createFastLaneItemSchema,
  }, async (input) => {
    const result = await handleCreateFastLaneItem(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  server.registerTool("get_item_status", {
    description:
      "Get the current status, PR number, and TLM verdict for a work item.",
    inputSchema: getItemStatusSchema,
  }, async (input) => {
    const result = await handleGetItemStatus(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  server.registerTool("list_recent_items", {
    description: "List recent work items, optionally filtered by status.",
    inputSchema: listRecentItemsSchema,
  }, async (input) => {
    const result = await handleListRecentItems(input);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,
    });

    await server.connect(transport);

    const response = await transport.handleRequest(request);

    return response;
  } catch (error) {
    console.error("[MCP] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: "Use POST for MCP requests" },
    { status: 405 },
  );
}

export async function DELETE(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
