import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getATCState, getATCEvents } from "@/lib/atc";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const [state, events] = await Promise.all([getATCState(), getATCEvents(20)]);
    return NextResponse.json({ ...state, recentEvents: events });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
