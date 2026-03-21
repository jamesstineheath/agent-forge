/**
 * Pipeline v2: Plan Management MCP tools.
 * Replace work item dispatch with plan-based dispatch.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listPlans,
  getPlan,
  updatePlanStatus,
  getActivePlansForRepo,
} from "@/lib/plans";
import type { PlanStatus } from "@/lib/types";

export function registerPlanTools(server: McpServer) {
  server.tool(
    "list_plans",
    "List plans from the Agent Forge store. Filter by status (ready, dispatching, executing, reviewing, complete, failed, timed_out, budget_exceeded, needs_review), target repo, or PRD ID.",
    {
      status: z.string().optional().describe("Filter by status"),
      target_repo: z.string().optional().describe("Filter by target repository"),
      prd_id: z.string().optional().describe("Filter by PRD ID (e.g., PRD-65)"),
    },
    async (params) => {
      const plans = await listPlans({
        status: params.status as PlanStatus | undefined,
        targetRepo: params.target_repo,
        prdId: params.prd_id,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(
            plans.map(p => ({
              id: p.id,
              prdId: p.prdId,
              prdTitle: p.prdTitle,
              targetRepo: p.targetRepo,
              branchName: p.branchName,
              status: p.status,
              estimatedBudget: p.estimatedBudget,
              actualCost: p.actualCost,
              maxDurationMinutes: p.maxDurationMinutes,
              prNumber: p.prNumber,
              prUrl: p.prUrl,
              retryCount: p.retryCount,
              createdAt: p.createdAt,
            })),
            null,
            2
          ),
        }],
      };
    }
  );

  server.tool(
    "get_plan",
    "Get full details of a specific plan by ID.",
    {
      id: z.string().describe("Plan ID"),
    },
    async (params) => {
      const plan = await getPlan(params.id);
      if (!plan) {
        return { content: [{ type: "text" as const, text: "Plan not found" }] };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }],
      };
    }
  );

  server.tool(
    "dispatch_plan",
    "Manually dispatch a plan for execution. The plan must be in 'ready' or 'needs_review' status.",
    {
      plan_id: z.string().describe("Plan ID to dispatch"),
    },
    async (params) => {
      const plan = await getPlan(params.plan_id);
      if (!plan) {
        return { content: [{ type: "text" as const, text: "Plan not found" }] };
      }

      if (plan.status !== "ready" && plan.status !== "needs_review") {
        return {
          content: [{
            type: "text" as const,
            text: `Plan is in "${plan.status}" status. Must be "ready" or "needs_review" to dispatch.`,
          }],
        };
      }

      // Check for active plans in same repo
      const activePlans = await getActivePlansForRepo(plan.targetRepo);
      if (activePlans.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: `Cannot dispatch: ${activePlans.length} active plan(s) in ${plan.targetRepo}. Active: ${activePlans.map(p => p.prdTitle).join(", ")}`,
          }],
        };
      }

      await updatePlanStatus(params.plan_id, "dispatching");

      // Trigger via workflow dispatch
      const { triggerWorkflow } = await import("@/lib/github");
      const repoFullName = plan.targetRepo.includes("/")
        ? plan.targetRepo
        : `jamesstineheath/${plan.targetRepo}`;

      await triggerWorkflow(repoFullName, "execute-handoff.yml", plan.branchName, {
        plan_id: plan.id,
        max_budget: String(plan.estimatedBudget ?? 10),
        max_duration_minutes: String(plan.maxDurationMinutes ?? 60),
      });

      return {
        content: [{
          type: "text" as const,
          text: `Dispatched plan ${plan.id} ("${plan.prdTitle}") to ${repoFullName} on branch ${plan.branchName}`,
        }],
      };
    }
  );

  server.tool(
    "retrigger_plan",
    "Reset a failed, timed_out, or budget_exceeded plan to ready for re-dispatch.",
    {
      plan_id: z.string().describe("Plan ID to retrigger"),
    },
    async (params) => {
      const plan = await getPlan(params.plan_id);
      if (!plan) {
        return { content: [{ type: "text" as const, text: "Plan not found" }] };
      }

      const retriggerable = new Set(["failed", "timed_out", "budget_exceeded"]);
      if (!retriggerable.has(plan.status)) {
        return {
          content: [{
            type: "text" as const,
            text: `Plan is in "${plan.status}" status, not retriggerable. Must be: failed, timed_out, or budget_exceeded.`,
          }],
        };
      }

      const updated = await updatePlanStatus(params.plan_id, "ready", {
        retryCount: plan.retryCount + 1,
      });

      return {
        content: [{
          type: "text" as const,
          text: `Plan ${plan.id} reset to "ready" (retry #${(updated?.retryCount ?? 0)}). Next dispatcher cycle will pick it up.`,
        }],
      };
    }
  );

  server.tool(
    "get_plan_progress",
    "Get the focused progress snapshot for a specific plan — criteria completion, current state, issues, decisions, and commits. Returns structured data from the plan record (updated by Health Monitor every 15 minutes).",
    {
      plan_id: z.string().describe("Plan ID"),
    },
    async (params) => {
      const plan = await getPlan(params.plan_id);
      if (!plan) {
        return { content: [{ type: "text" as const, text: "Plan not found" }] };
      }

      if (!plan.progress) {
        const msg = plan.status === "executing"
          ? "Executing — waiting for first checkpoint. Progress will appear after the agent commits PLAN_STATUS.md and the Health Monitor polls it."
          : `Plan is in "${plan.status}" status. No progress data available.`;
        return { content: [{ type: "text" as const, text: msg }] };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            planId: plan.id,
            prdId: plan.prdId,
            status: plan.status,
            ...plan.progress,
          }, null, 2),
        }],
      };
    }
  );
}
