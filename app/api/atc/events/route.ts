import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getATCEvents } from "@/lib/atc";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const limit = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
    const events = await getATCEvents(Math.min(limit, 200));
    return NextResponse.json(events);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
