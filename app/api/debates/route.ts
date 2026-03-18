import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getDebateStats, listDebateSessions } from "@/lib/debate/storage";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const repo = searchParams.get("repo");
    const pr = searchParams.get("pr");

    // If repo + pr params provided, return specific sessions
    if (repo && pr) {
      const prNumber = parseInt(pr, 10);
      if (isNaN(prNumber)) {
        return NextResponse.json({ error: "Invalid pr parameter" }, { status: 400 });
      }
      const sessions = await listDebateSessions(repo, prNumber);
      return NextResponse.json(sessions);
    }

    // If only repo provided, return all sessions for that repo
    if (repo) {
      const sessions = await listDebateSessions(repo);
      return NextResponse.json(sessions);
    }

    // Otherwise return aggregate stats
    const stats = await getDebateStats();
    return NextResponse.json(stats);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
