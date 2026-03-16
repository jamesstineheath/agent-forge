import { NextRequest, NextResponse } from "next/server";
import { validateAuth } from "@/lib/api-auth";
import { createWorkItem } from "@/lib/work-items";
import { listRepos } from "@/lib/repos";
import type { ComplexityHint } from "@/lib/types";
import {
  createWorkItemSchema,
  FAST_LANE_BUDGET_SIMPLE,
  FAST_LANE_BUDGET_MODERATE,
} from "@/lib/types";

const BUDGET_DEFAULTS: Record<ComplexityHint, number> = {
  simple: FAST_LANE_BUDGET_SIMPLE,
  moderate: FAST_LANE_BUDGET_MODERATE,
};
const DEFAULT_BUDGET = FAST_LANE_BUDGET_MODERATE;

export async function POST(request: NextRequest) {
  // 1. Auth — validate Bearer token against AGENT_FORGE_API_SECRET
  const authError = await validateAuth(request, "AGENT_FORGE_API_SECRET");
  if (authError) return authError;

  // 2. Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    description,
    targetRepo,
    complexity,
    budget: budgetOverride,
    triggeredBy,
  } = body as Record<string, unknown>;

  // 3. Validate description
  if (!description || typeof description !== "string" || description.trim() === "") {
    return NextResponse.json(
      { error: "description is required and must be a non-empty string" },
      { status: 400 },
    );
  }

  // 4. Validate targetRepo
  if (!targetRepo || typeof targetRepo !== "string" || targetRepo.trim() === "") {
    return NextResponse.json(
      { error: "targetRepo is required and must be a non-empty string" },
      { status: 400 },
    );
  }

  // 5. Check targetRepo is registered
  const registeredRepos = await listRepos();
  const repoIsRegistered = registeredRepos.some(
    (r) => r.fullName === targetRepo,
  );
  if (!repoIsRegistered) {
    return NextResponse.json(
      { error: `targetRepo '${targetRepo}' is not a registered repository` },
      { status: 400 },
    );
  }

  // 6. Validate complexity
  if (complexity !== undefined && complexity !== "simple" && complexity !== "moderate") {
    return NextResponse.json(
      { error: "complexity must be 'simple' or 'moderate' if provided" },
      { status: 400 },
    );
  }

  // 7. Validate budget override
  if (budgetOverride !== undefined) {
    if (typeof budgetOverride !== "number" || budgetOverride <= 0) {
      return NextResponse.json(
        { error: "budget must be a positive number if provided" },
        { status: 400 },
      );
    }
  }

  // 8. Resolve final budget
  const resolvedBudget =
    typeof budgetOverride === "number"
      ? budgetOverride
      : complexity
        ? BUDGET_DEFAULTS[complexity as ComplexityHint]
        : DEFAULT_BUDGET;

  // 9. Create work item — parse through zod schema to apply defaults
  const parsed = createWorkItemSchema.parse({
    title: (description as string).trim(),
    description: (description as string).trim(),
    targetRepo: (targetRepo as string).trim(),
    source: { type: "direct" },
    triggeredBy:
      typeof triggeredBy === "string" && triggeredBy.trim() !== ""
        ? triggeredBy.trim()
        : "james",
    ...(complexity ? { complexityHint: complexity as ComplexityHint } : {}),
  });
  const workItem = await createWorkItem(parsed);

  // 10. Return response
  return NextResponse.json(
    {
      workItemId: workItem.id,
      status: "filed",
      budget: resolvedBudget,
    },
    { status: 201 },
  );
}
