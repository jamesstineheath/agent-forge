import type { WorkItem } from "./types";

const BUGS_DB_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

/**
 * Map work item source types to Bugs DB Source select values.
 */
const SOURCE_MAP: Record<string, string> = {
  "feedback-compiler": "Feedback Compiler",
  "code-reviewer": "Code Reviewer",
  "qa-agent": "QA Agent",
  "outcome-tracker": "Outcome Tracker",
};

function mapSource(source: WorkItem["source"]): string {
  // Try matching sourceId (e.g. "feedback-compiler", "code-reviewer")
  if (source.sourceId && SOURCE_MAP[source.sourceId]) {
    return SOURCE_MAP[source.sourceId];
  }
  // Try matching source type
  if (SOURCE_MAP[source.type]) {
    return SOURCE_MAP[source.type];
  }
  return "Outcome Tracker";
}

/**
 * Write-through: create a corresponding Notion Bugs DB page for a bugfix work item.
 * Fire-and-forget — failures are logged but never thrown to the caller.
 */
export async function writeBugRecord(item: WorkItem): Promise<void> {
  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    console.error("[work-items] Bugs DB write-through failed: NOTION_API_KEY not set");
    return;
  }

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionApiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: BUGS_DB_ID },
        properties: {
          Name: {
            title: [{ type: "text", text: { content: item.title } }],
          },
          Status: {
            status: { name: "In Progress" },
          },
          Severity: {
            select: { name: "Medium" },
          },
          "Target Repo": {
            select: { name: item.targetRepo },
          },
          Source: {
            select: { name: mapSource(item.source) },
          },
          "Work Item ID": {
            rich_text: [{ type: "text", text: { content: item.id } }],
          },
          Context: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: (item.description || "").slice(0, 2000),
                },
              },
            ],
          },
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        "[work-items] Bugs DB write-through failed:",
        `HTTP ${response.status} — ${body}`
      );
    }
  } catch (err) {
    console.error("[work-items] Bugs DB write-through failed:", err);
  }
}
