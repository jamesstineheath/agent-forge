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

export function getClient(): Client | null {
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

function extractCheckbox(page: PageObjectResponse, prop: string): boolean {
  const p = page.properties[prop];
  if (p?.type === "checkbox") return p.checkbox === true;
  return false;
}

function extractNumber(page: PageObjectResponse, prop: string): number {
  const p = page.properties[prop];
  if (p?.type === "number" && p.number !== null && p.number !== undefined) return p.number;
  return 0;
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
    retry: extractCheckbox(page, "Retry"),
    retryCount: extractNumber(page, "RetryCount"),
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

export async function queryRetryProjects(): Promise<Project[]> {
  const dsId = getDatabaseId();
  if (!dsId || !process.env.NOTION_API_KEY) return [];

  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${dsId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Retry",
          checkbox: {
            equals: true,
          },
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error(`[notion] queryRetryProjects failed: ${response.status}`, data.message ?? data);
      throw new Error(data.message ?? `Notion query failed: ${response.status}`);
    }

    const results = (data.results as PageObjectResponse[])
      .filter((p): p is PageObjectResponse => "properties" in p);
    console.log(`[notion] queryRetryProjects: ${results.length} results from Notion (dbId: ${dsId?.slice(0, 8)}...)`);
    return results.map(pageToProject);
  } catch (err) {
    console.error("[notion] Failed to query retry projects:", err);
    return [];
  }
}

export async function updateProjectProperties(
  pageId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: Record<string, any>,
): Promise<void> {
  const client = getClient();
  if (!client) throw new Error("Notion client not configured (missing NOTION_API_KEY)");

  await client.pages.update({
    page_id: pageId,
    properties,
  });
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

// --- Markdown-to-Notion block helpers (for appendPageContent) ---

interface NotionRichText {
  type: 'text';
  text: { content: string };
  annotations?: { bold?: boolean };
}

interface NotionBlock {
  object: 'block';
  type: 'heading_2' | 'heading_3' | 'bulleted_list_item' | 'paragraph';
  heading_2?: { rich_text: NotionRichText[] };
  heading_3?: { rich_text: NotionRichText[] };
  bulleted_list_item?: { rich_text: NotionRichText[] };
  paragraph?: { rich_text: NotionRichText[] };
}

function parseInlineMarkdown(text: string): NotionRichText[] {
  const parts: NotionRichText[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: 'text',
        text: { content: text.slice(lastIndex, match.index) },
      });
    }
    parts.push({
      type: 'text',
      text: { content: match[1] },
      annotations: { bold: true },
    });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push({
      type: 'text',
      text: { content: text.slice(lastIndex) },
    });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', text: { content: '' } });
  }

  return parts;
}

function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.split('\n');
  const blocks: NotionBlock[] = [];

  for (const line of lines) {
    if (line.trim() === '') continue;

    if (line.startsWith('## ')) {
      const content = line.slice(3).trim();
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ type: 'text', text: { content } }],
        },
      });
      continue;
    }

    if (line.startsWith('### ')) {
      const content = line.slice(4).trim();
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: {
          rich_text: [{ type: 'text', text: { content } }],
        },
      });
      continue;
    }

    if (line.startsWith('- ')) {
      const content = line.slice(2).trim();
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: parseInlineMarkdown(content),
        },
      });
      continue;
    }

    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: parseInlineMarkdown(line),
      },
    });
  }

  return blocks;
}

export async function appendPageContent(
  pageId: string,
  markdown: string,
): Promise<void> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    throw new Error('NOTION_API_KEY environment variable is not set');
  }

  const blocks = markdownToNotionBlocks(markdown);

  if (blocks.length === 0) {
    return;
  }

  const url = `https://api.notion.com/v1/blocks/${pageId}/children`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${notionApiKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ children: blocks }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Notion API error appending blocks to page ${pageId}: HTTP ${response.status} — ${body}`,
    );
  }
}

// --- Notion Bugs DB ---

const BUGS_DB_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

export interface NotionBug {
  pageId: string;
  title: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  context: string;
  affectedFiles: string[];
  targetRepo: string | null;
  createdTime: string; // ISO 8601
  workItemId: string | null; // existing Work Item ID if any
}

/**
 * Query the Bugs database for pages with status "Triaged".
 */
export async function queryTriagedBugs(): Promise<NotionBug[]> {
  if (!process.env.NOTION_API_KEY) return [];

  const response = await fetch(
    `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Status",
          status: { equals: "Triaged" },
        },
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Notion bugs query failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();

  return (data.results ?? []).map((page: PageObjectResponse) => {
    const props = page.properties;

    const titleArr =
      (props["Name"]?.type === "title" ? props["Name"].title : undefined) ??
      (props["Title"]?.type === "title" ? props["Title"].title : undefined) ??
      [];
    const title = titleArr.map((t) => t.plain_text).join("");

    const severity = (extractSelect<NotionBug["severity"]>(page, "Severity") ?? "Low");

    const contextProp = props["Context"];
    const context =
      contextProp?.type === "rich_text"
        ? contextProp.rich_text.map((t) => t.plain_text).join("")
        : "";

    const affectedFilesProp = props["Affected Files"];
    let affectedFiles: string[] = [];
    if (affectedFilesProp?.type === "rich_text") {
      const raw = affectedFilesProp.rich_text.map((t) => t.plain_text).join("");
      affectedFiles = raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (affectedFilesProp?.type === "multi_select") {
      affectedFiles = affectedFilesProp.multi_select.map((s) => s.name);
    }

    const targetRepo = extractSelect<string>(page, "Target Repo");

    const workItemIdProp = props["Work Item ID"];
    const workItemId =
      workItemIdProp?.type === "rich_text"
        ? workItemIdProp.rich_text.map((t) => t.plain_text).join("") || null
        : null;

    return {
      pageId: page.id,
      title,
      severity,
      context,
      affectedFiles,
      targetRepo,
      createdTime: page.created_time,
      workItemId,
    };
  });
}

/**
 * Write a work item ID to the bug page's "Work Item ID" property.
 */
export async function updateBugWorkItemId(
  pageId: string,
  workItemId: string,
): Promise<void> {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        "Work Item ID": {
          rich_text: [{ type: "text", text: { content: workItemId } }],
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to update bug work item ID: ${response.status} ${await response.text()}`,
    );
  }
}

/**
 * Update the Status property of a bug page.
 */
export async function updateBugStatus(
  pageId: string,
  status: string,
): Promise<void> {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        Status: {
          status: { name: status },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to update bug status: ${response.status} ${await response.text()}`,
    );
  }
}

/**
 * Post a comment on a Notion page using the Notion Comments API.
 */
export async function addCommentToPage(
  pageId: string,
  commentBody: string,
): Promise<void> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    throw new Error("NOTION_API_KEY environment variable is not set");
  }

  const response = await fetch("https://api.notion.com/v1/comments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionApiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: commentBody } }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Notion API error posting comment on page ${pageId}: HTTP ${response.status} — ${body}`,
    );
  }
}

/**
 * Fetch all comments on a Notion page. Returns an array of comment body strings.
 */
export async function getPageComments(pageId: string): Promise<string[]> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) return [];

  try {
    const response = await fetch(
      `https://api.notion.com/v1/comments?block_id=${pageId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          "Notion-Version": "2022-06-28",
        },
      },
    );

    if (!response.ok) return [];

    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data.results ?? []).map((comment: any) =>
      (comment.rich_text ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((rt: any) => rt.plain_text ?? "")
        .join(""),
    );
  } catch {
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
