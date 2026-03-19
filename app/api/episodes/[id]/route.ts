import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { BlobEpisodeStore } from "@/lib/episodes";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth: session (dashboard UI) or CRON_SECRET bearer token (programmatic)
  const session = await auth();
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isBearerAuthed =
    cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!session && !isBearerAuthed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const episode = await BlobEpisodeStore.get(id);

    if (!episode) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(episode);
  } catch (err) {
    console.error(`[GET /api/episodes/${id}] Error:`, err);
    return NextResponse.json(
      { error: "Internal server error", message: String(err) },
      { status: 500 }
    );
  }
}
