import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getATCState, getATCEvents } from "@/lib/atc";

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [state, events] = await Promise.all([getATCState(), getATCEvents(20)]);
    return NextResponse.json({ ...state, recentEvents: events });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
