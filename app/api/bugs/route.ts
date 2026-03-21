import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import type { Bug } from "@/lib/types";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

export const dynamic = "force-dynamic";

const BUGS_DB_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

function extractSelect(page: PageObjectResponse, prop: string): string | null {
  const p = page.properties[prop];
  if (p?.type === "select" && p.select) return p.select.name;
  if (p?.type === "status" && p.status) return p.status.name;
  return null;
}

function extractTitle(page: PageObjectResponse): string {
  const props = page.properties;
  const titleProp =
    (props["Name"]?.type === "title" ? props["Name"].title : undefined) ??
    (props["Title"]?.type === "title" ? props["Title"].title : undefined) ??
    [];
  return titleProp.map((t) => t.plain_text).join("") || "(untitled)";
}

function extractRichText(page: PageObjectResponse, prop: string): string | null {
  const p = page.properties[prop];
  if (p?.type === "rich_text" && p.rich_text.length > 0) {
    return p.rich_text.map((t) => t.plain_text).join("");
  }
  return null;
}

function extractUrl(page: PageObjectResponse, prop: string): string | null {
  const p = page.properties[prop];
  if (p?.type === "url") return p.url;
  return null;
}

function pageToBug(page: PageObjectResponse): Bug {
  return {
    bug_id: page.id,
    title: extractTitle(page),
    status: extractSelect(page, "Status") ?? "Unknown",
    severity: extractSelect(page, "Severity") ?? "Unknown",
    target_repo: extractSelect(page, "Target Repo") ?? "",
    created_time: page.created_time,
    work_item_id: extractRichText(page, "Work Item ID") ?? undefined,
    fix_pr_url: extractUrl(page, "Fix PR URL") ?? extractUrl(page, "Fix PR") ?? undefined,
  };
}

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) {
    return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  }

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 50,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[bugs API] Notion query failed:", text);
      return NextResponse.json({ error: "Failed to query Notion" }, { status: 500 });
    }

    const data = await res.json();
    const bugs: Bug[] = (data.results as PageObjectResponse[])
      .filter((p): p is PageObjectResponse => "properties" in p)
      .map(pageToBug);

    return NextResponse.json({ bugs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("[bugs API] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
