import { NextRequest } from "next/server";
import { runPhaseHandler } from "@/lib/atc/supervisor-phase-utils";
import { runDriftDetection } from "@/lib/atc/supervisor";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return runPhaseHandler(req, async () => {
    const start = Date.now();
    const result = await runDriftDetection();
    return {
      durationMs: Date.now() - start,
      decisions: result.decisions,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  });
}
