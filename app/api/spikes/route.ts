import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { createPlan, listPlans } from "@/lib/plans";
import { generateBranchName } from "@/lib/plans";
import type { SpikeMetadata } from "@/lib/types";

/**
 * POST /api/spikes — Initiate a spike investigation.
 *
 * Creates a spike plan that will be picked up by the dispatcher.
 * Can be called by:
 * 1. James approving a PM Agent recommendation (via UI or webhook)
 * 2. James manually requesting "spike this" on a PRD
 *
 * Body:
 * {
 *   prdId: string;           // Parent PRD ID (e.g. "PRD-42")
 *   prdTitle: string;        // PRD title (used for branch naming)
 *   technicalQuestion: string; // The question to investigate
 *   scope: string;           // Investigation scope (1-2 sentences)
 *   targetRepo: string;      // Target repo for investigation
 *   recommendedBy?: "pm-agent" | "manual"; // Who recommended the spike
 * }
 */
export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  let body: {
    prdId?: string;
    prdTitle?: string;
    technicalQuestion?: string;
    scope?: string;
    targetRepo?: string;
    recommendedBy?: "pm-agent" | "manual";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { prdId, prdTitle, technicalQuestion, scope, targetRepo, recommendedBy } = body;

  if (!prdId || !technicalQuestion || !scope || !targetRepo) {
    return NextResponse.json(
      { error: "Missing required fields: prdId, technicalQuestion, scope, targetRepo" },
      { status: 400 },
    );
  }

  // Idempotency: check if a spike plan already exists for this PRD
  const existingPlans = await listPlans({ prdId });
  const existingSpike = existingPlans.find(p => p.prdType === "spike");
  if (existingSpike) {
    return NextResponse.json(
      { error: `Spike plan already exists for ${prdId}`, plan: existingSpike },
      { status: 409 },
    );
  }

  const spikeMetadata: SpikeMetadata = {
    parentPrdId: prdId,
    technicalQuestion,
    scope,
    recommendedBy: recommendedBy ?? "manual",
  };

  const title = prdTitle ?? `Spike: ${technicalQuestion.slice(0, 80)}`;
  const branchName = `spike/${prdId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

  const plan = await createPlan({
    prdId,
    prdTitle: title,
    prdType: "spike",
    targetRepo,
    branchName,
    acceptanceCriteria: `Investigate: ${technicalQuestion}\n\nScope: ${scope}`,
    estimatedBudget: 3,
    maxDurationMinutes: 60,
    status: "ready",
    spikeMetadata,
  });

  console.log(`[spikes-api] Created spike plan ${plan.id} for ${prdId}: "${technicalQuestion}"`);

  return NextResponse.json({ plan }, { status: 201 });
}

/**
 * GET /api/spikes — List spike plans.
 */
export async function GET(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  const allPlans = await listPlans();
  const spikePlans = allPlans.filter(p => p.prdType === "spike");

  return NextResponse.json({ plans: spikePlans });
}
