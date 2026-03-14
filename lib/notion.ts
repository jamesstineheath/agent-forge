import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
import type {
  Project,
  ProjectStatus,
  ProjectPriority,
  ProjectComplexity,
  ProjectRiskLevel,
  ProjectTargetRepo,
} from "./types";

let _client: Client | null = null;

function getClient(): Client | null {
  if (_client) return _client;
  const token = process.env.NOTION_API_KEY;
  if (!token) return null;
  _client = new Client({ auth: token });
  return _client;
}

function getDataSourceId(): string | null {
  return process.env.NOTION_PROJECTS_DB_ID ?? null;
}

function extractSelect<T extends string>(
  page: PageObjectResponse,
  prop: string,
): T | null {
  const p = page.properties[prop];
  if (p?.type === "select" && p.select) return p.select.name as T;
  return null;
}

function extractTitle(page: PageObjectResponse, prop: string): string {
  const p = page.properties[prop];
  if (p?.type === "title" && p.title.length > 0) return p.title[0].plain_text;
  return "";
}

function extractUrl(page: PageObjectResponse, prop: string): string | null {
  const p = page.properties[prop];
  if (p?.type === "url") return p.url;
  return null;
}

function extractUniqueId(page: PageObjectResponse, prop: string): string {
  const p = page.properties[prop];
  if (p?.type === "unique_id" && p.unique_id) {
    const prefix = p.unique_id.prefix ?? "PRJ";
    return `${prefix}-${p.unique_id.number}`;
  }
  return page.id;
}

function pageToProject(page: PageObjectResponse): Project {
  return {
    id: page.id,
    projectId: extractUniqueId(page, "Project ID"),
    title: extractTitle(page, "Project"),
    planUrl: extractUrl(page, "Plan URL"),
    targetRepo: extractSelect<ProjectTargetRepo>(page, "Target Repo"),
    status: extractSelect<ProjectStatus>(page, "Status") ?? "Draft",
    priority: extractSelect<ProjectPriority>(page, "Priority"),
    complexity: extractSelect<ProjectComplexity>(page, "Complexity"),
    riskLevel: extractSelect<ProjectRiskLevel>(page, "Risk Level"),
    createdAt: page.created_time,
  };
}

export async function queryProjects(statusFilter?: ProjectStatus): Promise<Project[]> {
  const client = getClient();
  const dsId = getDataSourceId();
  if (!client || !dsId) return [];

  try {
    const filter = statusFilter
      ? { property: "Status", select: { equals: statusFilter } }
      : undefined;

    const response = await client.dataSources.query({
      data_source_id: dsId,
      filter,
      sorts: [{ property: "Created", direction: "descending" as const }],
    });

    return response.results
      .filter((p): p is PageObjectResponse => "properties" in p)
      .map(pageToProject);
  } catch (err) {
    console.error("[notion] Failed to query projects:", err);
    return [];
  }
}

export async function updateProjectStatus(
  pageId: string,
  status: ProjectStatus,
): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    await client.pages.update({
      page_id: pageId,
      properties: {
        Status: { select: { name: status } },
      },
    });
    return true;
  } catch (err) {
    console.error("[notion] Failed to update project status:", err);
    return false;
  }
}
