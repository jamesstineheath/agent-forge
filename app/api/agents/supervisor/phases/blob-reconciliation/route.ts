import { NextRequest, NextResponse } from "next/server";
import { runPhaseHandler } from "@/lib/atc/supervisor-phase-utils";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return runPhaseHandler(req, async () => {
    return {
      durationMs: 0,
      decisions: ["Blob reconciliation: removed (no-op since Neon migration)"],
    };
  });
}
