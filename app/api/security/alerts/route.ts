import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSecurityOverview } from "@/lib/security";
import { listRepos } from "@/lib/repos";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const repoIndex = await listRepos();
    const repoNames = repoIndex.map((r) => r.fullName);

    if (repoNames.length === 0) {
      return NextResponse.json({
        repos: [],
        totalAlerts: 0,
        fetchedAt: new Date().toISOString(),
      });
    }

    const overview = await getSecurityOverview(repoNames);
    return NextResponse.json(overview);
  } catch (err) {
    console.error("[GET /api/security/alerts] Error:", err);
    return NextResponse.json(
      { error: "Internal server error", message: String(err) },
      { status: 500 }
    );
  }
}
