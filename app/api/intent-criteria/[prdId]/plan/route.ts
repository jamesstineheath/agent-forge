import { NextRequest, NextResponse } from "next/server";
import { getArchitecturePlan, generateArchitecturePlan, planToDecomposerMarkdown } from "@/lib/architecture-planner";
import { getCriteria } from "@/lib/intent-criteria";
import { loadJson, saveJson } from "@/lib/storage";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ prdId: string }> },
) {
  const { prdId } = await params;

  try {
    const plan = await getArchitecturePlan(prdId);
    if (!plan) {
      return NextResponse.json(null, { status: 404 });
    }
    return NextResponse.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * POST triggers architecture plan generation + decomposition for a PRD.
 * Called by the "Generate Plan" button on /projects/[prdId].
 *
 * Query params:
 *   ?decompose=true — also trigger decomposition after plan generation
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ prdId: string }> },
) {
  const { prdId } = await params;
  const decompose = req.nextUrl.searchParams.get("decompose") === "true";

  try {
    const criteria = await getCriteria(prdId);
    if (!criteria) {
      return NextResponse.json({ error: "Criteria not found for this PRD" }, { status: 404 });
    }

    if (criteria.criteria.length === 0) {
      return NextResponse.json({ error: "No acceptance criteria to plan" }, { status: 400 });
    }

    // Generate architecture plan
    console.log(`[plan-api] Generating architecture plan for "${criteria.prdTitle}"`);
    const plan = await generateArchitecturePlan({
      criteria,
      mode: "plan",
    });

    const result: Record<string, unknown> = {
      plan: {
        version: plan.version,
        criterionPlans: plan.criterionPlans.length,
        estimatedWorkItems: plan.estimatedWorkItems,
        totalEstimatedCost: plan.totalEstimatedCost,
        generatedAt: plan.generatedAt,
      },
    };

    // Optionally trigger decomposition
    if (decompose) {
      const dedupKey = `atc/project-decomposed/prd-${prdId}`;
      const alreadyDecomposed = await loadJson<{ decomposedAt: string }>(dedupKey);

      if (alreadyDecomposed) {
        result.decomposition = { skipped: true, reason: "Already decomposed" };
      } else {
        try {
          const { decomposeFromPlan } = await import("@/lib/decomposer");
          const markdown = planToDecomposerMarkdown(plan, criteria.prdTitle);

          await decomposeFromPlan({
            prdId,
            prdTitle: criteria.prdTitle,
            targetRepo: plan.targetRepo,
            planContent: markdown,
            projectId: criteria.projectId,
          });

          await saveJson(dedupKey, { decomposedAt: new Date().toISOString(), planVersion: plan.version });
          result.decomposition = { triggered: true };
        } catch (decompErr) {
          const msg = decompErr instanceof Error ? decompErr.message : String(decompErr);
          console.error(`[plan-api] Decomposition failed:`, msg);
          result.decomposition = { triggered: false, error: msg };
        }
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error(`[plan-api] Plan generation failed:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
