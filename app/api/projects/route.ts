import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listProjects } from "@/lib/projects";
import type { ProjectStatus } from "@/lib/types";

const VALID_STATUSES: ProjectStatus[] = [
  "Draft", "Ready", "Execute", "Executing", "Complete", "Failed",
];

export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const statusParam = searchParams.get("status");
    const status =
      statusParam && VALID_STATUSES.includes(statusParam as ProjectStatus)
        ? (statusParam as ProjectStatus)
        : undefined;

    const projects = await listProjects(status);
    return NextResponse.json(projects);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
