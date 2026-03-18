import { NextResponse } from "next/server";

export async function GET() {
  // Stub endpoint — replace with real data source when QA Agent ledger is wired up
  return NextResponse.json({
    runs: [],
    summary: {
      totalRuns: 0,
      passRate: 0,
      avgDurationMs: 0,
      failureCategories: {},
      byRepo: [],
      graduation: {
        runsCompleted: 0,
        runsRequired: 20,
        falseNegativeRate: 0,
      },
    },
  });
}
