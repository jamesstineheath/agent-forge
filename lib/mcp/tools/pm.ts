/**
 * PM (Product Manager) MCP tools.
 * Provides PM context, PRD database access, project status, and pipeline health
 * for the HITL PM chat session on claude.ai.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listWorkItems, getWorkItem } from "@/lib/work-items";
import { listPlans } from "@/lib/plans";
import type { WorkItem, PlanStatus } from "@/lib/types";
import { loadJson } from "@/lib/storage";

// Notion page IDs for PM memory
const PM_MEMORY_PAGES = {
  masterSession: "30c041760b7081b88df2f1ce7fb30c19",
  agentForgeSession: "323041760b7081cda23bddb9f8650108",
  workingNorms: "31f041760b70813e8199d4d2ee7a384c",
};

const PRD_DATABASE_ID = "2a61cc49-73c5-41bf-981c-37ef1ab2f77b";

async function notionFetch(path: string, method = "GET", body?: unknown) {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("NOTION_API_KEY not configured");

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`https://api.notion.com/v1${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

function richTextToPlain(richText: Array<{ plain_text?: string }>): string {
  return richText.map((t) => t.plain_text || "").join("");
}

function blocksToText(blocks: Array<{ type: string; [key: string]: unknown }>): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const content = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
    if (content?.rich_text) {
      const text = richTextToPlain(content.rich_text);
      if (text.trim()) lines.push(text);
    }
  }
  return lines.join("\n");
}

async function getPageContent(pageId: string): Promise<string> {
  const blocks: Array<{ type: string; [key: string]: unknown }> = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : "";
    const data = await notionFetch(`/blocks/${pageId}/children${params}`);
    blocks.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return blocksToText(blocks);
}

export function registerPMTools(server: McpServer) {
  server.tool(
    "get_pm_context",
    "Read the PM's shared memory pages from Notion. Returns content from Master Session Memory, AF Session Memory, and Claude Working Norms. Use this at the start of a session to get full PM context.",
    {
      pages: z.array(z.enum(["master_session", "agent_forge_session", "working_norms"]))
        .optional()
        .describe("Which memory pages to read. Defaults to all three."),
    },
    async (params) => {
      const pagesToRead = params.pages || ["master_session", "agent_forge_session", "working_norms"];
      const results: Record<string, string> = {};

      for (const page of pagesToRead) {
        let pageId: string;
        switch (page) {
          case "master_session":
            pageId = PM_MEMORY_PAGES.masterSession;
            break;
          case "agent_forge_session":
            pageId = PM_MEMORY_PAGES.agentForgeSession;
            break;
          case "working_norms":
            pageId = PM_MEMORY_PAGES.workingNorms;
            break;
          default:
            continue;
        }
        try {
          results[page] = await getPageContent(pageId);
        } catch (err) {
          results[page] = `Error reading page: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    "get_project_status",
    "Get live execution status for a project. Shows work item progress, cost, merged/failed/executing counts.",
    {
      project_id: z.string().describe("Project ID prefix to filter by (e.g., 'PRD-43')"),
    },
    async (params) => {
      const allItems = await listWorkItems({});
      const projectItems = allItems.filter((item) => {
        const wi = item as WorkItem;
        return wi.source?.sourceId?.includes(params.project_id) ||
               wi.title?.includes(params.project_id);
      });

      // Get full details for each
      const details = await Promise.all(
        projectItems.slice(0, 50).map(async (item) => {
          const full = await getWorkItem(item.id);
          if (!full) return null;

          // Check if all dependencies are resolved
          let depsResolved = true;
          if (full.dependencies?.length) {
            const deps = await Promise.all(full.dependencies.map((d) => getWorkItem(d)));
            depsResolved = deps.every((d) => d !== null && (d.status === "merged" || d.status === "cancelled"));
          }

          return {
            id: item.id,
            title: full.title,
            status: full.status,
            blockedReason: full.blockedReason,
            depsResolved,
            hasExecution: !!full.execution?.startedAt,
            cost: full.execution?.actualCost,
            prNumber: full.execution?.prNumber,
            branch: full.handoff?.branch,
          };
        })
      );

      const items = details.filter(Boolean);
      const byStatus: Record<string, number> = {};
      let totalCost = 0;
      for (const item of items) {
        if (!item) continue;
        byStatus[item.status] = (byStatus[item.status] || 0) + 1;
        if (item.cost) totalCost += item.cost;
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            projectId: params.project_id,
            totalItems: items.length,
            byStatus,
            totalCost: `$${totalCost.toFixed(2)}`,
            items,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_pipeline_health",
    "Get a health overview of the pipeline. Shows agent status, recent errors, success rates, and stuck items.",
    {},
    async () => {
      // Read ATC state
      const atcState = await loadJson("atc/state");

      // Read recent agent traces for health summary
      const agents = ["dispatcher", "health-monitor", "project-manager", "supervisor"];
      const agentHealth: Record<string, unknown> = {};

      for (const agent of agents) {
        try {
          const { list } = await import("@vercel/blob");
          const token = process.env.BLOB_READ_WRITE_TOKEN;
          if (!token) continue;

          const { blobs } = await list({
            prefix: `af-data/agent-traces/${agent}/`,
            token,
            limit: 5,
          });

          const recentStatuses = blobs
            .sort((a, b) => b.pathname.localeCompare(a.pathname))
            .slice(0, 5)
            .map((b) => b.pathname);

          agentHealth[agent] = {
            recentTraceCount: blobs.length,
            latestTrace: recentStatuses[0] || "none",
          };
        } catch {
          agentHealth[agent] = { error: "Could not read traces" };
        }
      }

      // Count work items by status (legacy)
      const statuses = ["executing", "failed", "ready", "queued", "merged"] as const;
      const workItemCounts: Record<string, number> = {};
      for (const status of statuses) {
        const items = await listWorkItems({ status });
        workItemCounts[status] = items.length;
      }

      // Pipeline v2: count plans by status
      const planStatuses: PlanStatus[] = ["ready", "dispatching", "executing", "reviewing", "complete", "failed", "timed_out", "budget_exceeded", "needs_review"];
      const planCounts: Record<string, number> = {};
      for (const status of planStatuses) {
        const plans = await listPlans({ status });
        planCounts[status] = plans.length;
      }

      // Pipeline metrics (7-day window)
      let pipelineMetrics: unknown = null;
      try {
        const { computePipelineMetrics } = await import("@/lib/pipeline-metrics");
        pipelineMetrics = await computePipelineMetrics(7);
      } catch {
        pipelineMetrics = { error: "Could not compute pipeline metrics" };
      }

      // Cost summary (7-day window)
      let costSummary: unknown = null;
      try {
        const { getCostsForPeriod, aggregateCosts } = await import("@/lib/cost-tracking");
        const endDate = new Date().toISOString().slice(0, 10);
        const startDateObj = new Date();
        startDateObj.setUTCDate(startDateObj.getUTCDate() - 7);
        const entries = await getCostsForPeriod(startDateObj.toISOString().slice(0, 10), endDate);
        costSummary = aggregateCosts(entries);
      } catch {
        costSummary = { error: "Could not compute cost summary" };
      }

      // Supervisor phase execution log
      let supervisorPhaseLog: unknown = null;
      try {
        const execLog = await loadJson("af-data/supervisor/execution-log");
        if (execLog) {
          supervisorPhaseLog = execLog;
        }
      } catch {
        supervisorPhaseLog = { error: "Could not read supervisor execution log" };
      }

      // Knowledge graph stats
      let knowledgeGraphStats: unknown = null;
      try {
        const { loadRepoSnapshot } = await import("@/lib/knowledge-graph/storage");
        const { listRepos, getRepo } = await import("@/lib/repos");
        const allRepos = await listRepos();
        const repoStats = [];
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

        for (const entry of allRepos) {
          const repo = await getRepo(entry.id);
          if (!repo) continue;
          const snapshot = await loadRepoSnapshot(repo.fullName);
          const now = Date.now();
          let staleness: "fresh" | "stale" | "missing" = "missing";
          if (snapshot?.indexedAt) {
            const age = now - new Date(snapshot.indexedAt).getTime();
            staleness = age > SEVEN_DAYS_MS ? "stale" : "fresh";
          }
          repoStats.push({
            repo: repo.fullName,
            entityCount: snapshot?.entityCount ?? 0,
            relationshipCount: snapshot?.relationshipCount ?? 0,
            lastIndexedAt: snapshot?.indexedAt ?? null,
            staleness,
          });
        }
        knowledgeGraphStats = { repos: repoStats };
      } catch {
        knowledgeGraphStats = { error: "Could not load knowledge graph stats" };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            atcState,
            agentHealth,
            planCounts,
            workItemCounts,
            pipelineMetrics,
            costSummary7d: costSummary,
            supervisorPhaseLog,
            knowledgeGraph: knowledgeGraphStats,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "get_prd_list",
    "Query the PRDs & Acceptance Criteria database. Returns PRD titles, status, priority, rank, estimated cost, and criteria progress.",
    {
      status: z.enum(["Idea", "Draft", "In Review", "Approved", "Executing", "Complete", "Paused"])
        .optional()
        .describe("Filter by status"),
    },
    async (params) => {
      const filter = params.status
        ? { property: "Status", select: { equals: params.status } }
        : undefined;

      const body: Record<string, unknown> = {
        sorts: [{ property: "Rank", direction: "ascending" }],
        page_size: 50,
      };
      if (filter) body.filter = filter;

      const data = await notionFetch(`/databases/${PRD_DATABASE_ID}/query`, "POST", body);

      interface NotionPage {
        id: string;
        properties: {
          "PRD Title"?: { title?: Array<{ plain_text?: string }> };
          Status?: { select?: { name?: string } };
          Priority?: { select?: { name?: string } };
          Rank?: { number?: number | null };
          "Estimated Cost"?: { number?: number | null };
          "Criteria Count"?: { number?: number | null };
          "Criteria Passed"?: { number?: number | null };
          "Target Repo"?: { select?: { name?: string } };
          "AF Project ID"?: { rich_text?: Array<{ plain_text?: string }> };
        };
      }

      const prds = (data.results as NotionPage[]).map((page) => ({
        id: page.id,
        title: page.properties?.["PRD Title"]?.title?.[0]?.plain_text || "Untitled",
        status: page.properties?.Status?.select?.name,
        priority: page.properties?.Priority?.select?.name,
        rank: page.properties?.Rank?.number,
        estimatedCost: page.properties?.["Estimated Cost"]?.number,
        criteriaCount: page.properties?.["Criteria Count"]?.number,
        criteriaPassed: page.properties?.["Criteria Passed"]?.number,
        targetRepo: page.properties?.["Target Repo"]?.select?.name,
        projectId: page.properties?.["AF Project ID"]?.rich_text?.[0]?.plain_text,
      }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ total: prds.length, prds }, null, 2),
        }],
      };
    }
  );
}
