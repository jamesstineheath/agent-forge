import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { queryProjects, updateProjectStatus } from "@/lib/notion";

function isAuthorized(request: NextRequest): boolean {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  return (
    token === process.env.AGENT_FORGE_API_SECRET ||
    token === process.env.ESCALATION_SECRET
  );
}

export async function POST(request: NextRequest) {
  // Support both session auth and Bearer token auth
  const session = await auth();
  if (!session && !isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  }

  try {
    // 1. Find PRD-9 via existing queryProjects
    const allProjects = await queryProjects();
    const prj9 = allProjects.find(
      (p) => p.projectId === "PRD-9" || p.title.includes("Real Estate Agent v2")
    );

    if (!prj9) {
      return NextResponse.json({
        error: "PRD-9 not found in Notion DB",
        hint: "Check NOTION_PROJECTS_DB_ID env var",
        totalProjects: allProjects.length,
        projectIds: allProjects.map((p) => p.projectId),
      }, { status: 404 });
    }

    // 2. Fetch the page's blocks to inspect plan content
    const blocksResponse = await fetch(
      `https://api.notion.com/v1/blocks/${prj9.id}/children?page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${notionApiKey}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );
    const blocksData = await blocksResponse.json();
    if (!blocksResponse.ok) {
      return NextResponse.json({
        error: "Failed to fetch blocks",
        details: blocksData,
      }, { status: 500 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = blocksData.results as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blockSummary = blocks.map((b: any) => ({
      type: b.type,
      text: b[b.type]?.rich_text?.[0]?.plain_text
        || b[b.type]?.text?.[0]?.plain_text
        || "",
    }));

    console.log("[recover-prj9] PRD-9 page ID:", prj9.id);
    console.log("[recover-prj9] PRD-9 project ID:", prj9.projectId);
    console.log("[recover-prj9] Block count:", blocks.length);
    console.log("[recover-prj9] Blocks:", JSON.stringify(blockSummary, null, 2));

    // 3. Determine current status
    const currentStatus = prj9.status;
    console.log("[recover-prj9] Current status:", currentStatus);

    // 4. If the page has blocks (potential plan content), reset to Execute
    const hasContent = blocks.length > 0;
    let resetPerformed = false;

    if (hasContent && currentStatus === "Failed") {
      const success = await updateProjectStatus(prj9.id, "Execute");
      resetPerformed = success;
      if (success) {
        console.log("[recover-prj9] Reset PRD-9 status to Execute");
      } else {
        console.error("[recover-prj9] Failed to reset PRD-9 status");
      }
    }

    return NextResponse.json({
      success: true,
      projectPageId: prj9.id,
      projectId: prj9.projectId,
      currentStatus,
      planUrl: prj9.planUrl,
      blockCount: blocks.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blockTypes: [...new Set(blocks.map((b: any) => b.type as string))],
      blockSummary,
      resetPerformed,
      message: resetPerformed
        ? "PRD-9 reset to Execute — ATC will re-decompose on next cycle"
        : hasContent
          ? `PRD-9 has ${blocks.length} blocks but status is "${currentStatus}" — no reset needed`
          : "PRD-9 plan page is empty — manual intervention required to add plan content",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("[recover-prj9] Error:", error);
    return NextResponse.json({
      error: message,
      stack,
    }, { status: 500 });
  }
}
