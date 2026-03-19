import { NextRequest, NextResponse } from "next/server";
import { computePipelineMetrics } from "@/lib/pipeline-metrics";

export async function GET(req: NextRequest) {
  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10);
  const period = Math.min(Math.max(days, 1), 90);

  try {
    const metrics = await computePipelineMetrics(period);
    return NextResponse.json(metrics);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
