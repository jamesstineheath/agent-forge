import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listProjects } from "@/lib/projects";
import { decomposeProject } from "@/lib/decomposer";

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { projectId } = body;

    if (!projectId || typeof projectId !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid projectId" },
        { status: 400 },
      );
    }

    // Find the project by projectId (e.g. "PRD-1") or Notion page ID
    const projects = await listProjects();
    const project = projects.find(
      (p) => p.projectId === projectId || p.id === projectId,
    );

    if (!project) {
      return NextResponse.json(
        { error: `Project not found: ${projectId}` },
        { status: 404 },
      );
    }

    const result = await decomposeProject(project);

    // Build the response, always including backward-compat fields
    const responseBody: Record<string, unknown> = {
      items: result.workItems,
      totalItems: result.workItems.length,
      wasDecomposedIntoPhases: result.phaseBreakdown != null,
    };

    // Only include phases when sub-phases were used
    if (result.phaseBreakdown) {
      responseBody.phases = result.phaseBreakdown.phases.map((p) => ({
        id: p.id,
        name: p.name,
        itemCount: p.itemCount,
      }));
    }

    return NextResponse.json(responseBody, { status: 200 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
