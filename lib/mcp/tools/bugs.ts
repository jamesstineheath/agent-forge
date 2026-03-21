/**
 * Bug Tracking MCP tools.
 * Creates, lists, and updates bugs in the Notion Bugs database.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../../notion";

const BUGS_DATABASE_ID = "7f21af359f69490b9370b03c649ee2ed";

export function registerBugTools(server: McpServer) {
  // ── file_bug ──────────────────────────────────────────────────────────────
  server.tool(
    "file_bug",
    "Create a new bug report in the Notion Bugs database. Returns the created page ID and BUG-N unique ID.",
    {
      title: z.string().describe("Short descriptive title for the bug"),
      severity: z
        .enum(["Critical", "High", "Medium", "Low"])
        .describe("Bug severity level"),
      target_repo: z
        .string()
        .describe(
          "The repository where this bug was observed (e.g. jamesstineheath/agent-forge)",
        ),
      context: z
        .string()
        .describe(
          "Detailed description of the bug, steps to reproduce, observed vs expected behavior",
        ),
      affected_files: z
        .string()
        .optional()
        .describe("Optional comma-separated list of affected file paths"),
    },
    async (params) => {
      try {
        const notion = getClient();
        if (!notion) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Notion client not configured (missing NOTION_API_KEY)",
                }),
              },
            ],
            isError: true,
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const properties: Record<string, any> = {
          "Bug Title": {
            title: [{ text: { content: params.title } }],
          },
          Status: {
            select: { name: "Triaged" },
          },
          Severity: {
            select: { name: params.severity },
          },
          "Target Repo": {
            select: { name: params.target_repo },
          },
          Source: {
            select: { name: "Manual" },
          },
          Context: {
            rich_text: [{ text: { content: params.context } }],
          },
        };

        if (params.affected_files) {
          properties["Affected Files"] = {
            rich_text: [{ text: { content: params.affected_files } }],
          };
        }

        const page = await notion.pages.create({
          parent: { database_id: BUGS_DATABASE_ID },
          properties,
        });

        // Extract the Bug ID (unique_id) from the created page
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bugIdProp = (page as any).properties?.["Bug ID"];
        const bugId = bugIdProp?.unique_id
          ? `BUG-${bugIdProp.unique_id.number}`
          : "BUG-?";

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                page_id: page.id,
                bug_id: bugId,
                message: `Bug filed successfully as ${bugId}`,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── list_bugs ─────────────────────────────────────────────────────────────
  server.tool(
    "list_bugs",
    "List bugs from the Notion Bugs database. Excludes Fixed and Won't Fix by default. Optionally filter by severity and/or target repo.",
    {
      severity: z
        .enum(["Critical", "High", "Medium", "Low"])
        .optional()
        .describe("Optional: filter by severity"),
      target_repo: z
        .string()
        .optional()
        .describe("Optional: filter by target repository"),
    },
    async (params) => {
      try {
        if (!process.env.NOTION_API_KEY) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Notion client not configured (missing NOTION_API_KEY)",
                }),
              },
            ],
            isError: true,
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const andFilters: any[] = [
          {
            property: "Status",
            select: { does_not_equal: "Fixed" },
          },
          {
            property: "Status",
            select: { does_not_equal: "Won't Fix" },
          },
        ];

        if (params.severity) {
          andFilters.push({
            property: "Severity",
            select: { equals: params.severity },
          });
        }

        if (params.target_repo) {
          andFilters.push({
            property: "Target Repo",
            select: { equals: params.target_repo },
          });
        }

        const notionApiKey = process.env.NOTION_API_KEY;
        const res = await fetch(
          `https://api.notion.com/v1/databases/${BUGS_DATABASE_ID}/query`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${notionApiKey}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filter: { and: andFilters },
              sorts: [{ timestamp: "created_time", direction: "descending" }],
              page_size: 50,
            }),
          },
        );

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Notion query failed: ${res.status} ${body}`);
        }

        const data = await res.json();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bugs = (data.results ?? []).map((page: any) => {
          const props = page.properties ?? {};
          const titleArr = props["Bug Title"]?.title ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const title = titleArr.map((t: any) => t.plain_text).join("");
          const status = props.Status?.select?.name ?? null;
          const severity = props.Severity?.select?.name ?? null;
          const repo = props["Target Repo"]?.select?.name ?? null;
          const bugIdProp = props["Bug ID"]?.unique_id;
          const bugId = bugIdProp ? `BUG-${bugIdProp.number}` : null;

          return {
            page_id: page.id,
            bug_id: bugId,
            title,
            status,
            severity,
            target_repo: repo,
            created_time: page.created_time,
          };
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, count: bugs.length, bugs }),
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── update_bug_status ─────────────────────────────────────────────────────
  server.tool(
    "update_bug_status",
    "Update the status of a bug in the Notion Bugs database. Optionally set the Fix PR URL when marking as Fixed.",
    {
      page_id: z
        .string()
        .describe("The Notion page ID of the bug to update"),
      status: z
        .enum([
          "Open",
          "Triaged",
          "In Progress",
          "Fixed",
          "Won't Fix",
          "Reopened",
        ])
        .describe("New status for the bug"),
      fix_pr_url: z
        .string()
        .optional()
        .describe(
          "Optional: URL of the PR that fixes this bug (populates Fix PR URL field)",
        ),
    },
    async (params) => {
      try {
        const notion = getClient();
        if (!notion) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error: "Notion client not configured (missing NOTION_API_KEY)",
                }),
              },
            ],
            isError: true,
          };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const properties: Record<string, any> = {
          Status: {
            select: { name: params.status },
          },
        };

        if (params.fix_pr_url) {
          properties["Fix PR URL"] = {
            url: params.fix_pr_url,
          };
        }

        await notion.pages.update({
          page_id: params.page_id,
          properties,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                page_id: params.page_id,
                status: params.status,
                message: `Bug status updated to "${params.status}"`,
              }),
            },
          ],
        };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: message }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
