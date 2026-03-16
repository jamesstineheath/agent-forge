import { z } from "zod";
import { createWorkItem, getWorkItem, listWorkItems } from "./work-items";
import { createWorkItemSchema } from "./types";
import type { ComplexityHint } from "./types";
import {
  FAST_LANE_BUDGET_SIMPLE,
  FAST_LANE_BUDGET_MODERATE,
} from "./types";
import { checkDailyCap, incrementDailyCount } from "./daily-cap";

// --- Tool Schemas (zod shapes for MCP registerTool) ---

export const createFastLaneItemSchema = {
  description: z.string().describe("What needs to be built or fixed"),
  targetRepo: z
    .string()
    .describe("Target repository, e.g. 'jamesstineheath/agent-forge'"),
  budget: z.number().optional().describe("Max spend in USD (default: 5)"),
  complexity: z
    .enum(["simple", "moderate"])
    .optional()
    .describe("Task complexity hint"),
  triggeredBy: z
    .string()
    .optional()
    .describe("Who triggered this (default: 'james')"),
};

export const getItemStatusSchema = {
  workItemId: z.string().describe("The work item ID to look up"),
};

export const listRecentItemsSchema = {
  limit: z
    .number()
    .optional()
    .describe("Max number of items to return (default: 10)"),
  status: z
    .string()
    .optional()
    .describe("Filter by status (e.g. 'executing', 'merged')"),
};

// --- Tool Handlers ---

const BUDGET_DEFAULTS: Record<ComplexityHint, number> = {
  simple: FAST_LANE_BUDGET_SIMPLE,
  moderate: FAST_LANE_BUDGET_MODERATE,
};
const DEFAULT_BUDGET = FAST_LANE_BUDGET_MODERATE;

export async function handleCreateFastLaneItem(input: {
  description: string;
  targetRepo: string;
  budget?: number;
  complexity?: "simple" | "moderate";
  triggeredBy?: string;
}) {
  const {
    description,
    targetRepo,
    budget: budgetOverride,
    complexity,
    triggeredBy = "james",
  } = input;

  // Daily cap check for non-human producers
  const capResult = await checkDailyCap(triggeredBy);
  if (!capResult.allowed) {
    throw new Error(`daily cap exceeded (0 remaining of ${capResult.limit})`);
  }

  const resolvedBudget =
    typeof budgetOverride === "number"
      ? budgetOverride
      : complexity
        ? BUDGET_DEFAULTS[complexity]
        : DEFAULT_BUDGET;

  const parsed = createWorkItemSchema.parse({
    title: description.trim(),
    description: description.trim(),
    targetRepo: targetRepo.trim(),
    source: { type: "direct" },
    triggeredBy: triggeredBy.trim() || "james",
    ...(complexity ? { complexityHint: complexity } : {}),
  });
  const workItem = await createWorkItem(parsed);

  // Increment daily cap count after successful creation
  await incrementDailyCount(triggeredBy);

  return {
    workItemId: workItem.id,
    status: workItem.status,
    budget: resolvedBudget,
  };
}

export async function handleGetItemStatus(input: { workItemId: string }) {
  const workItem = await getWorkItem(input.workItemId);

  if (!workItem) {
    throw new Error(`Work item not found: ${input.workItemId}`);
  }

  return {
    status: workItem.status,
    prNumber: workItem.execution?.prNumber ?? undefined,
    description: workItem.description,
    targetRepo: workItem.targetRepo,
    createdAt: workItem.createdAt,
  };
}

export async function handleListRecentItems(input: {
  limit?: number;
  status?: string;
}) {
  const { limit = 10, status } = input;

  const filters = status
    ? { status: status as "filed" | "ready" | "queued" | "executing" | "reviewing" | "merged" | "failed" | "parked" | "blocked" | "cancelled" | "escalated" | "generating" }
    : undefined;

  const items = await listWorkItems(filters);

  return items
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      targetRepo: item.targetRepo,
      updatedAt: item.updatedAt,
    }));
}
