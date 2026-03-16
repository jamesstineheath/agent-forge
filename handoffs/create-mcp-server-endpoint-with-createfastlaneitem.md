# Agent Forge -- Create MCP Server Endpoint with create_fast_lane_item Tool

## Metadata
- **Branch:** `feat/mcp-server-endpoint`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** app/api/mcp/route.ts, lib/mcp-tools.ts

## Context

Agent Forge already has a `/api/fast-lane` POST endpoint (see `app/api/fast-lane/route.ts`) that creates work items with `source='direct'`. We now need an MCP server endpoint so that Claude Chat, PA agents, and other MCP-connected surfaces can invoke Agent Forge tools over the Model Context Protocol.

The MCP server uses the Streamable HTTP transport pattern (single endpoint, handles GET/POST/DELETE). Auth is Bearer token via `AGENT_FORGE_API_SECRET` env var — same pattern as `/api/fast-lane`.

Relevant existing patterns:
- `app/api/fast-lane/route.ts` — createWorkItem call with source='direct', Bearer auth
- `lib/work-items.ts` — `createWorkItem`, `getWorkItem`, `listWorkItems` functions
- `lib/types.ts` — WorkItem type, source types including 'direct'

The MCP SDK to use is `@modelcontextprotocol/sdk` (already available in the JS/TS ecosystem). Use the `McpServer` class with `StreamableHTTPServerTransport`.

## Requirements

1. `lib/mcp-tools.ts` defines tool schemas and handler logic for `create_fast_lane_item`, `get_item_status`, and `list_recent_items`
2. `app/api/mcp/route.ts` implements an MCP server using Streamable HTTP transport, registered at `/api/mcp`
3. All requests to `/api/mcp` must include `Authorization: Bearer <AGENT_FORGE_API_SECRET>` or receive a 401 response
4. `create_fast_lane_item` accepts `{ description, targetRepo, budget?, complexity?, triggeredBy? }`, creates a work item with `source='direct'`, defaults `triggeredBy='james'`, returns `{ workItemId, status, budget }`
5. `get_item_status` accepts `{ workItemId }`, returns `{ status, prNumber?, tlmVerdict?, description, targetRepo, createdAt }`
6. `list_recent_items` accepts `{ limit?, status? }`, returns array of work item summaries (id, description, status, targetRepo, createdAt)
7. TypeScript compiles with no errors (`npx tsc --noEmit`)
8. The `@modelcontextprotocol/sdk` package is installed if not already present

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/mcp-server-endpoint
```

### Step 1: Install MCP SDK if not present

Check if `@modelcontextprotocol/sdk` is already in `package.json`. If not, install it:

```bash
grep -q "@modelcontextprotocol/sdk" package.json || npm install @modelcontextprotocol/sdk
```

### Step 2: Inspect existing fast-lane and work-items code

Read the following files to understand exact function signatures before implementing:

```bash
cat app/api/fast-lane/route.ts
cat lib/work-items.ts
cat lib/types.ts
```

Pay attention to:
- How `createWorkItem` is called in the fast-lane route
- The shape of the `WorkItem` type (especially `status`, `prNumber`, `tlmVerdict`, `description`, `targetRepo`, `createdAt`, `budget`)
- How `listWorkItems` works and what it returns

### Step 3: Create `lib/mcp-tools.ts`

Create this file with tool definitions and handler logic. The handlers import from `lib/work-items.ts` directly.

```typescript
// lib/mcp-tools.ts
import { z } from "zod";
import { createWorkItem, getWorkItem, listWorkItems } from "./work-items";

// --- Tool Schemas ---

export const createFastLaneItemSchema = z.object({
  description: z.string().describe("What needs to be built or fixed"),
  targetRepo: z.string().describe("Target repository, e.g. 'jamesstineheath/agent-forge'"),
  budget: z.number().optional().describe("Max spend in USD (default: 5)"),
  complexity: z.enum(["simple", "moderate"]).optional().describe("Task complexity hint"),
  triggeredBy: z.string().optional().describe("Who triggered this (default: 'james')"),
});

export const getItemStatusSchema = z.object({
  workItemId: z.string().describe("The work item ID to look up"),
});

export const listRecentItemsSchema = z.object({
  limit: z.number().optional().describe("Max number of items to return (default: 10)"),
  status: z.string().optional().describe("Filter by status (e.g. 'executing', 'merged')"),
});

// --- Tool Handlers ---

export async function handleCreateFastLaneItem(
  input: z.infer<typeof createFastLaneItemSchema>
) {
  const { description, targetRepo, budget = 5, complexity, triggeredBy = "james" } = input;

  const workItem = await createWorkItem({
    title: description.slice(0, 100),
    description,
    targetRepo,
    source: "direct",
    priority: "high",
    status: "ready",
    budget,
    complexity,
    triggeredBy,
  });

  return {
    workItemId: workItem.id,
    status: workItem.status,
    budget: workItem.budget ?? budget,
  };
}

export async function handleGetItemStatus(
  input: z.infer<typeof getItemStatusSchema>
) {
  const workItem = await getWorkItem(input.workItemId);

  if (!workItem) {
    throw new Error(`Work item not found: ${input.workItemId}`);
  }

  return {
    status: workItem.status,
    prNumber: workItem.prNumber ?? undefined,
    tlmVerdict: workItem.tlmVerdict ?? undefined,
    description: workItem.description,
    targetRepo: workItem.targetRepo,
    createdAt: workItem.createdAt,
  };
}

export async function handleListRecentItems(
  input: z.infer<typeof listRecentItemsSchema>
) {
  const { limit = 10, status } = input;

  const items = await listWorkItems();

  const filtered = status
    ? items.filter((item) => item.status === status)
    : items;

  return filtered
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      description: item.description,
      status: item.status,
      targetRepo: item.targetRepo,
      createdAt: item.createdAt,
    }));
}
```

> **Note:** If the `WorkItem` type fields differ from what's assumed above (e.g., `prNumber` may be `pr_number`, `tlmVerdict` may be `tlm_verdict`), adjust field names to match the actual type. Check `lib/types.ts` output from Step 2.

> **Note:** If `createWorkItem` doesn't accept all these fields directly, model the call after whatever `/api/fast-lane/route.ts` does — copy that exact call pattern.

### Step 4: Create `app/api/mcp/route.ts`

```typescript
// app/api/mcp/route.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

  server.tool(
    "create_fast_lane_item",
    "Create a fast-lane work item in Agent Forge. Use this to queue dev tasks for autonomous execution.",
    createFastLaneItemSchema.shape,
    async (input) => {
      const result = await handleCreateFastLaneItem(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "get_item_status",
    "Get the current status, PR number, and TLM verdict for a work item.",
    getItemStatusSchema.shape,
    async (input) => {
      const result = await handleGetItemStatus(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_recent_items",
    "List recent work items, optionally filtered by status.",
    listRecentItemsSchema.shape,
    async (input) => {
      const result = await handleListRecentItems(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}

export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const body = await request.json();

    let responseBody: unknown;
    let responseStatus = 200;

    // Wire up the response capture
    const response = await new Promise<{ status: number; body: unknown }>(
      (resolve, reject) => {
        transport.handleRequest(
          {
            method: "POST",
            headers: Object.fromEntries(request.headers.entries()),
            body,
          },
          {
            status: (code: number) => { responseStatus = code; },
            setHeader: () => {},
            json: (data: unknown) => resolve({ status: responseStatus, body: data }),
            end: (data?: string) => resolve({ status: responseStatus, body: data ? JSON.parse(data) : null }),
            on: () => {},
          }
        ).catch(reject);

        server.connect(transport).catch(reject);
      }
    );

    return NextResponse.json(response.body, { status: response.status });
  } catch (error) {
    console.error("[MCP] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // SSE / GET not used in stateless mode; return method info
  return NextResponse.json(
    { error: "Use POST for MCP requests" },
    { status: 405 }
  );
}

export async function DELETE(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
```

### Step 5: Verify MCP SDK API compatibility

The `@modelcontextprotocol/sdk` API surface has evolved. After writing the files above, check the actual SDK exports:

```bash
cat node_modules/@modelcontextprotocol/sdk/dist/server/mcp.js 2>/dev/null | head -50
ls node_modules/@modelcontextprotocol/sdk/dist/server/
```

If `StreamableHTTPServerTransport` doesn't exist at that path or has a different interface, adapt the route to use the available transport. Common alternatives:
- If only `Server` (not `McpServer`) is exported, use `Server` with `setRequestHandler`
- If `StreamableHTTPServerTransport` has a different constructor or `handleRequest` signature, adapt accordingly
- The key invariant is: stateless POST endpoint that accepts JSON-RPC MCP messages and returns JSON-RPC responses

If the SDK transport integration is too complex for the route handler model, implement a **simplified JSON-RPC dispatcher** directly in `route.ts` instead of using the transport layer:

```typescript
// Fallback: direct JSON-RPC dispatch (no transport needed)
export async function POST(request: NextRequest) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { id, method, params } = body;

  if (method === "tools/list") {
    return NextResponse.json({
      jsonrpc: "2.0", id,
      result: {
        tools: [
          { name: "create_fast_lane_item", description: "...", inputSchema: { ... } },
          { name: "get_item_status", description: "...", inputSchema: { ... } },
          { name: "list_recent_items", description: "...", inputSchema: { ... } },
        ]
      }
    });
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    // dispatch to handlers...
  }

  return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
}
```

Use this fallback if the SDK transport approach causes TypeScript errors that can't be resolved quickly.

### Step 6: TypeScript check and fix

```bash
npx tsc --noEmit 2>&1 | head -60
```

Fix any type errors. Common issues:
- WorkItem field names don't match — check `lib/types.ts` and update `mcp-tools.ts` accordingly
- `createWorkItem` parameter shape — match exactly what the fast-lane route passes
- MCP SDK type issues — add `// @ts-ignore` sparingly if SDK types are incomplete, or use the JSON-RPC fallback from Step 5

### Step 7: Build check

```bash
npm run build 2>&1 | tail -30
```

Fix any build errors. If `@modelcontextprotocol/sdk` has ESM/CJS issues with Next.js, add to `next.config.ts` (or `next.config.js`):

```typescript
// In transpilePackages or serverExternalPackages as needed
transpilePackages: ['@modelcontextprotocol/sdk']
// OR
experimental: { serverExternalPackages: ['@modelcontextprotocol/sdk'] }
```

### Step 8: Verification

```bash
npx tsc --noEmit
npm run build
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add MCP server endpoint with create_fast_lane_item, get_item_status, list_recent_items tools"
git push origin feat/mcp-server-endpoint
gh pr create \
  --title "feat: MCP server endpoint at /api/mcp with fast-lane tools" \
  --body "## Summary
Implements the Agent Forge MCP server endpoint so Claude Chat, PA agents, and other MCP-connected surfaces can create and monitor work items.

## Changes
- \`app/api/mcp/route.ts\` — MCP server using Streamable HTTP transport (or JSON-RPC fallback), Bearer token auth via AGENT_FORGE_API_SECRET
- \`lib/mcp-tools.ts\` — Tool definitions and handlers for three tools

## Tools
- \`create_fast_lane_item\` — Creates a work item with source='direct', returns workItemId/status/budget
- \`get_item_status\` — Returns status, prNumber, tlmVerdict for a given workItemId
- \`list_recent_items\` — Returns recent items with optional status filter

## Auth
All requests require \`Authorization: Bearer \$AGENT_FORGE_API_SECRET\` — unauthenticated requests get 401.

## Testing
\`\`\`bash
# List tools
curl -X POST /api/mcp \
  -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'

# Create item
curl -X POST /api/mcp \
  -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"create_fast_lane_item\",\"arguments\":{\"description\":\"Test item\",\"targetRepo\":\"jamesstineheath/agent-forge\"}}}'
\`\`\`"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/mcp-server-endpoint
FILES CHANGED: [list what was actually created/modified]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., SDK transport API incompatible with Next.js route handlers]
NEXT STEPS: [e.g., "Use JSON-RPC fallback pattern in route.ts instead of SDK transport"]
```

## Escalation

If blocked on:
- MCP SDK transport API being fundamentally incompatible with Next.js App Router (not fixable with JSON-RPC fallback)
- `createWorkItem` / `listWorkItems` having a completely different signature requiring architectural changes
- Missing environment variables needed for tests

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["app/api/mcp/route.ts", "lib/mcp-tools.ts"]
    }
  }'
```