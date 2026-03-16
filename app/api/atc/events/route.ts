import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getATCEvents } from "@/lib/atc";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
    const events = await getATCEvents(Math.min(limit, 200));
    return NextResponse.json(events);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
