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

  // Migration 4: spike_metadata column
  try {
    await sql`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS spike_metadata JSONB`;
    results.push({ name: "add-spike-metadata-column", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "add-spike-metadata-column", status: "failed", error: message });
  }

  // Migration 5: plans table (Pipeline v2)
  try {
    await sql`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      prd_id TEXT NOT NULL,
      prd_title TEXT NOT NULL,
      target_repo TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      acceptance_criteria TEXT NOT NULL,
      kg_context JSONB,
      affected_files JSONB,
      estimated_budget REAL,
      actual_cost REAL,
      max_duration_minutes INTEGER DEFAULT 60,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      error_log TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      workflow_run_id TEXT,
      retry_count INTEGER DEFAULT 0,
      prd_rank INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    results.push({ name: "create-plans-table", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "create-plans-table", status: "failed", error: message });
  }

  // Migration 6: plans table indexes
  try {
    await sql`CREATE INDEX IF NOT EXISTS idx_plans_status ON plans (status)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_plans_target_repo ON plans (target_repo)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_plans_prd_id ON plans (prd_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_plans_status_target_repo ON plans (status, target_repo)`;
    results.push({ name: "create-plans-indexes", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "create-plans-indexes", status: "failed", error: message });
  }

  // Migration 7: plans.progress column (PRD-66)
  try {
    await sql`ALTER TABLE plans ADD COLUMN IF NOT EXISTS progress JSONB`;
    results.push({ name: "add-plans-progress-column", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "add-plans-progress-column", status: "failed", error: message });
  }

  // Migration 8: plans.review_feedback column (Pipeline v2 retrigger)
  try {
    await sql`ALTER TABLE plans ADD COLUMN IF NOT EXISTS review_feedback TEXT`;
    results.push({ name: "add-plans-review-feedback-column", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "add-plans-review-feedback-column", status: "failed", error: message });
  }

  // Migration 9: cost_records plan_id column
  try {
    await sql`ALTER TABLE cost_records ADD COLUMN IF NOT EXISTS plan_id TEXT`;
    results.push({ name: "add-cost-records-plan-id", status: "applied" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // cost_records may not exist yet — non-fatal
    results.push({ name: "add-cost-records-plan-id", status: "skipped", error: message });
  }

  const allSucceeded = results.every((r) => r.status === "applied" || r.status === "skipped");

  return NextResponse.json(
    {
      success: allSucceeded,
      migrations: results,
      appliedAt: new Date().toISOString(),
    },
    { status: allSucceeded ? 200 : 207 }
  );
}
