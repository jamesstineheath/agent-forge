import { NextResponse } from "next/server";
import { listRepos, createRepo } from "@/lib/repos";

/**
 * Temporary unauthenticated endpoint to seed repos into Vercel Blob.
 * DELETE THIS AFTER DEBUGGING.
 *
 * GET /api/debug/seed-repos — list current repos
 * POST /api/debug/seed-repos — seed all repos (idempotent)
 */

const REPOS = [
  {
    fullName: "jamesstineheath/personal-assistant",
    shortName: "pa",
    claudeMdPath: "CLAUDE.md",
    systemMapPath: "docs/SYSTEM_MAP.md",
    adrPath: "docs/adr",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 2,
    defaultBudget: 8,
  },
  {
    fullName: "jamesstineheath/rez-sniper",
    shortName: "rez-sniper",
    claudeMdPath: "CLAUDE.md",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 1,
    defaultBudget: 5,
  },
  {
    fullName: "jamesstineheath/agent-forge",
    shortName: "agent-forge",
    claudeMdPath: "CLAUDE.md",
    systemMapPath: "docs/SYSTEM_MAP.md",
    adrPath: "docs/adr",
    handoffDir: "handoffs/",
    executeWorkflow: "execute-handoff.yml",
    concurrencyLimit: 2,
    defaultBudget: 5,
  },
];

export async function GET() {
  try {
    const repos = await listRepos();
    return NextResponse.json({ count: repos.length, repos });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const existing = await listRepos();
    const existingNames = new Set(existing.map((r) => r.fullName));
    const results: Array<{ fullName: string; action: string; id?: string }> = [];

    for (const repo of REPOS) {
      if (existingNames.has(repo.fullName)) {
        results.push({ fullName: repo.fullName, action: "skipped (already exists)" });
        continue;
      }
      const created = await createRepo(repo);
      results.push({ fullName: repo.fullName, action: "created", id: created.id });
    }

    const finalRepos = await listRepos();
    return NextResponse.json({
      results,
      totalRepos: finalRepos.length,
      repos: finalRepos,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
