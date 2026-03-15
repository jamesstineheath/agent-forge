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

function getDatabaseId(): string | null {
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
  const dsId = getDatabaseId();
  if (!dsId || !process.env.NOTION_API_KEY) return [];

  try {
    const filter = statusFilter
      ? { property: "Status", select: { equals: statusFilter } }
      : undefined;

    const response = await fetch(`https://api.notion.com/v1/databases/${dsId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...(filter ? { filter } : {}),
        sorts: [{ property: "Created", direction: "descending" }],
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? `Notion query failed: ${response.status}`);

    return (data.results as PageObjectResponse[])
      .filter((p): p is PageObjectResponse => "properties" in p)
      .map(pageToProject);
  } catch (err) {
    console.error("[notion] Failed to query projects:", err);
    return [];
  }
}

// --- Block-to-markdown helpers ---

/* eslint-disable @typescript-eslint/no-explicit-any */
function richTextToMarkdown(richText: any[]): string {
  return richText.map((t: any) => t.plain_text ?? "").join("");
}

function blockToMarkdown(block: any): string {
  const type: string = block.type;
  switch (type) {
    case "heading_1":
      return `# ${richTextToMarkdown(block.heading_1.rich_text)}`;
    case "heading_2":
      return `## ${richTextToMarkdown(block.heading_2.rich_text)}`;
    case "heading_3":
      return `### ${richTextToMarkdown(block.heading_3.rich_text)}`;
    case "paragraph":
      return richTextToMarkdown(block.paragraph.rich_text);
    case "bulleted_list_item":
      return `- ${richTextToMarkdown(block.bulleted_list_item.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToMarkdown(block.numbered_list_item.rich_text)}`;
    case "code":
      return `\`\`\`${block.code.language ?? ""}\n${richTextToMarkdown(block.code.rich_text)}\n\`\`\``;
    case "toggle": {
      const title = richTextToMarkdown(block.toggle.rich_text);
      // Children are fetched separately and appended by fetchPageContent
      return `<details><summary>${title}</summary>`;
    }
    case "callout": {
      const icon = block.callout.icon?.emoji ?? "💡";
      return `> ${icon} ${richTextToMarkdown(block.callout.rich_text)}`;
    }
    case "divider":
      return "---";
    case "quote":
      return `> ${richTextToMarkdown(block.quote.rich_text)}`;
    default:
      return "";
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Fetch all block children of a Notion page, handling pagination.
 */
async function fetchAllBlocks(
  client: Client,
  blockId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];
  let cursor: string | undefined;
  do {
    const response = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return blocks;
}

/**
 * Fetch a Notion page's block children and convert them to a markdown string.
 * Handles headings (h1-h3), paragraphs, bulleted/numbered lists, code blocks,
 * toggle blocks (recursively fetches children), callouts, quotes, and dividers.
 */
export async function fetchPageContent(pageId: string): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("Notion client not configured (missing NOTION_API_KEY)");

  const blocks = await fetchAllBlocks(client, pageId);
  const lines: string[] = [];

  for (const block of blocks) {
    const md = blockToMarkdown(block);
    if (md !== undefined) lines.push(md);

    // For toggle blocks, recursively fetch and indent children
    if (block.type === "toggle" && block.has_children) {
      const children = await fetchAllBlocks(client, block.id);
      for (const child of children) {
        const childMd = blockToMarkdown(child);
        if (childMd) lines.push(`  ${childMd}`);
      }
      lines.push("</details>");
    }
  }

  return lines.join("\n\n");
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
