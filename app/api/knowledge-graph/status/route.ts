import { NextResponse } from "next/server";

// Stub: returns empty statuses until the knowledge graph indexer
// populates actual snapshot data.
export async function GET() {
  return NextResponse.json({ statuses: [] });
}
