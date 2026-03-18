import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { recordCost } from "@/lib/cost-tracking";
import { findWorkItemByBranch, updateWorkItem } from "@/lib/work-items";
import { z } from "zod";

const recordCostSchema = z.object({
  branch: z.string().min(1),
  repo: z.string().min(1),
  agentType: z.string().min(1),
  costUsd: z.number().min(0),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

export async function POST(req: NextRequest) {
  const authError = await validateAuth(req, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  try {
    const body = await req.json();
    const parsed = recordCostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { branch, repo, agentType, costUsd, inputTokens, outputTokens } = parsed.data;

    // Look up the work item by branch
    const workItem = await findWorkItemByBranch(branch);

    // Record cost entry to daily blob storage
    await recordCost({
      workItemId: workItem?.id ?? `unknown-${branch}`,
      agentType,
      repo,
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      estimatedCostUsd: costUsd,
      timestamp: new Date().toISOString(),
    });

    // Update work item's actualCost if found
    if (workItem) {
      const existingCost = workItem.execution?.actualCost ?? 0;
      await updateWorkItem(workItem.id, {
        execution: {
          ...workItem.execution,
          actualCost: existingCost + costUsd,
        },
      });
    }

    return NextResponse.json({
      recorded: true,
      workItemId: workItem?.id ?? null,
      costUsd,
    });
  } catch (err) {
    console.error("[api/costs/record] POST error:", err);
    return NextResponse.json(
      { error: "Failed to record cost" },
      { status: 500 }
    );
  }
}
