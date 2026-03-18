/**
 * Work Item Management MCP tools.
 * Direct library calls — no HTTP hop, no auth layer.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listWorkItems,
  getWorkItem,
  createWorkItem,
  updateWorkItem,
} from "@/lib/work-items";
import { getATCState } from "@/lib/atc";
import { dispatchWorkItem } from "@/lib/orchestrator";
import {
  listEscalations as listEscalationsLib,
  resolveEscalation as resolveEscalationLib,
} from "@/lib/escalation";

export function registerWorkItemTools(server: McpServer) {
  server.tool(
    "list_work_items",
    "List work items from the Agent Forge store. Filter by status (filed, ready, queued, generating, executing, reviewing, merged, failed, parked, blocked, cancelled), target repo, or priority.",
    {
      status: z.string().optional().describe("Filter by status (e.g., 'executing', 'failed', 'queued')"),
      target_repo: z.string().optional().describe("Filter by target repository"),
      priority: z.string().optional().describe("Filter by priority (critical, high, medium, low)"),
    },
    async (params) => {
      const items = await listWorkItems({
        status: params.status as Parameters<typeof listWorkItems>[0] extends undefined ? never : NonNullable<Parameters<typeof listWorkItems>[0]>["status"],
        targetRepo: params.target_repo,
        priority: params.priority as "high" | "medium" | "low" | undefined,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }],
      };
    }
  );

  server.tool(
    "get_work_item",
    "Get full details of a specific work item by ID. Includes status, handoff content, execution tracking, escalation info, and dependencies.",
    {
      id: z.string().describe("Work item ID"),
    },
    async (params) => {
      const result = await getWorkItem(params.id);
      if (!result) {
        return {
          content: [{ type: "text" as const, text: `Work item not found: ${params.id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_work_item",
    "Create a new work item in Agent Forge. This files a task for autonomous execution. The orchestrator will handle dispatch, handoff generation, and pipeline execution.",
    {
      title: z.string().describe("Short title for the work item"),
      description: z.string().describe("Detailed description of what needs to be done"),
      type: z.enum(["feature", "bugfix", "refactor", "test", "docs", "chore"]),
      priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
      target_repo: z.string().optional().describe("Target repo (default: agent-forge)"),
      risk_level: z.enum(["low", "medium", "high"]).optional(),
      complexity: z.enum(["simple", "moderate", "complex"]).optional(),
    },
    async (params) => {
      const input: Record<string, unknown> = {
        title: params.title,
        description: params.description,
        targetRepo: params.target_repo ?? "jamesstineheath/agent-forge",
        source: { type: "direct" as const },
        priority: params.priority === "critical" ? "high" : params.priority,
      };
      if (params.risk_level) input.riskLevel = params.risk_level;
      if (params.complexity) input.complexity = params.complexity;

      const result = await createWorkItem(input as Parameters<typeof createWorkItem>[0]);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: result.id, status: result.status, title: result.title }, null, 2) }],
      };
    }
  );

  server.tool(
    "update_work_item",
    "Update a work item's status or fields. Use this to manually transition items (e.g., mark as parked, unblock, cancel).",
    {
      id: z.string().describe("Work item ID"),
      status: z.string().optional().describe("New status"),
      priority: z.string().optional(),
      description: z.string().optional(),
      target_repo: z.string().optional().describe("Target repository (short or full name)"),
      notes: z.string().optional().describe("Add execution notes"),
    },
    async (params) => {
      const patch: Record<string, unknown> = {};
      if (params.status) patch.status = params.status;
      if (params.priority) patch.priority = params.priority;
      if (params.description) patch.description = params.description;
      if (params.target_repo) patch.targetRepo = params.target_repo;
      if (params.notes) patch.notes = params.notes;

      const result = await updateWorkItem(params.id, patch);
      if (!result) {
        return {
          content: [{ type: "text" as const, text: `Work item not found: ${params.id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ id: result.id, status: result.status }, null, 2) }],
      };
    }
  );

  server.tool(
    "get_atc_state",
    "Get the current Air Traffic Controller state. Shows active executions, queued items, and recent events. This is the central dispatch coordination layer.",
    {},
    async () => {
      const result = await getATCState();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "dispatch_work_item",
    "Manually dispatch a work item for execution. Triggers the orchestrator to generate a handoff and start the pipeline. The work item must be in 'ready' or 'queued' status.",
    {
      work_item_id: z.string().describe("Work item ID to dispatch"),
    },
    async (params) => {
      const result = await dispatchWorkItem(params.work_item_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_escalations",
    "List all escalations. Escalations are raised when pipeline agents encounter issues that need human decision-making.",
    {},
    async () => {
      const result = await listEscalationsLib();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "resolve_escalation",
    "Resolve an escalation with a resolution message. This unblocks the associated work item.",
    {
      id: z.string().describe("Escalation ID"),
      resolution: z.string().describe("Resolution message describing the decision or fix"),
    },
    async (params) => {
      const result = await resolveEscalationLib(params.id, params.resolution);
      if (!result) {
        return {
          content: [{ type: "text" as const, text: `Escalation not found: ${params.id}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
