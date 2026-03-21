import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { loadJson } from "@/lib/storage";
import type { PhaseExecutionLog } from "@/lib/atc/supervisor-manifest";

const EXECUTION_LOG_KEY = "af-data/supervisor/execution-log";
const EXECUTION_LOG_HISTORY_KEY = "af-data/supervisor/execution-log-history";

export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    let latest: PhaseExecutionLog | null = null;
    let history: PhaseExecutionLog[] = [];

    try {
      latest = await loadJson<PhaseExecutionLog>(EXECUTION_LOG_KEY);
    } catch {
      // Not yet written
    }

    try {
      const raw = await loadJson<PhaseExecutionLog[]>(EXECUTION_LOG_HISTORY_KEY);
      if (raw) history = raw;
    } catch {
      // Not yet written
    }

    return NextResponse.json({ latest, history });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
