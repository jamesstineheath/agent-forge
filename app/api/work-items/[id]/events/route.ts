import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { getWorkItemEvents } from "@/lib/atc";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = await validateAuth(req, "WORK_ITEMS_API_KEY");
  if (authError) return authError;

  const { id } = await params;
  try {
    const events = await getWorkItemEvents(id);
    return NextResponse.json(events);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
