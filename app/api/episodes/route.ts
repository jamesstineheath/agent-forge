import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { BlobEpisodeStore } from "@/lib/episodes";
import type { EpisodeOutcome, EpisodeSearchParams } from "@/lib/episodes";

export async function GET(request: NextRequest) {
  // Auth: session (dashboard UI) or CRON_SECRET bearer token (programmatic)
  const session = await auth();
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isBearerAuthed =
    cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!session && !isBearerAuthed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  // Parse and validate query params
  const q = searchParams.get("q") ?? undefined;
  const from = searchParams.get("from") ?? undefined;
  const to = searchParams.get("to") ?? undefined;
  const outcomeParam = searchParams.get("outcome") ?? undefined;
  const cursor = searchParams.get("cursor") ?? undefined;

  const limitParam = searchParams.get("limit");
  const limitParsed = limitParam ? parseInt(limitParam, 10) : 20;
  const limit = isNaN(limitParsed)
    ? 20
    : Math.min(Math.max(limitParsed, 1), 100);

  // Validate outcome if present
  const validOutcomes: EpisodeOutcome[] = ["success", "failure", "partial"];
  const outcome: EpisodeOutcome | undefined =
    outcomeParam && validOutcomes.includes(outcomeParam as EpisodeOutcome)
      ? (outcomeParam as EpisodeOutcome)
      : undefined;

  const params: EpisodeSearchParams = {
    ...(q && { q }),
    ...(from && { from }),
    ...(to && { to }),
    ...(outcome && { outcome }),
    ...(cursor && { cursor }),
    limit,
  };

  try {
    const result = await BlobEpisodeStore.search(params);

    return NextResponse.json({
      episodes: result.episodes,
      ...(result.nextCursor && { nextCursor: result.nextCursor }),
    });
  } catch (err) {
    console.error("[GET /api/episodes] Error:", err);
    return NextResponse.json(
      { error: "Internal server error", message: String(err) },
      { status: 500 }
    );
  }
}
