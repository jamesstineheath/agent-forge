import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { validateAuth } from "@/lib/api-auth";

/**
 * POST /api/admin/migrate
 *
 * Run schema migrations against the Neon database.
 * Auth-gated with AGENT_FORGE_API_SECRET.
 * All statements use IF NOT EXISTS / IF EXISTS for idempotency.
 */
export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  const sql = neon(process.env.DATABASE_URL);

  const results: Array<{ name: string; status: string; error?: string }> = [];

  // Migration 1: wave_number column
  try {
    await sql`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS wave_number INTEGER`;
    results.push({ name: "add-wave-number-column", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "add-wave-number-column", status: "failed", error: message });
  }

  // Migration 2: prd_id column
  try {
    await sql`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS prd_id TEXT`;
    results.push({ name: "add-prd-id-column", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "add-prd-id-column", status: "failed", error: message });
  }

  // Migration 3: notes column
  try {
    await sql`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS notes TEXT`;
    results.push({ name: "add-notes-column", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "add-notes-column", status: "failed", error: message });
  }

  const allSucceeded = results.every((r) => r.status === "applied");

  return NextResponse.json(
    {
      success: allSucceeded,
      migrations: results,
      appliedAt: new Date().toISOString(),
    },
    { status: allSucceeded ? 200 : 207 }
  );
}
