import { NextRequest } from "next/server";
import { setGlobalDispatcher, Agent } from "undici";
import { runPhaseHandler } from "@/lib/atc/supervisor-phase-utils";
import { runDecomposition } from "@/lib/atc/supervisor";

// Raise undici's default headersTimeout (300s) so long-running Anthropic API
// calls made by the AI SDK don't get killed before the phase route's own
// maxDuration fires.  Each Vercel phase route runs in its own function, so
// this only affects outbound fetches from this route.
setGlobalDispatcher(new Agent({ headersTimeout: 800_000, bodyTimeout: 800_000 }));

export const maxDuration = 800;

export async function POST(req: NextRequest) {
  return runPhaseHandler(req, async () => {
    const start = Date.now();
    const result = await runDecomposition();
    return {
      durationMs: Date.now() - start,
      decisions: result.decisions,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  });
}
