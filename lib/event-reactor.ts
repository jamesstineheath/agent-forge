/**
 * Event Reactor: Maps GitHub webhook events to immediate pipeline actions.
 *
 * Instead of waiting for cron-based polling (5-15 min cycles), the reactor
 * triggers state transitions within seconds of the event occurring.
 * Cron agents remain as reconciliation fallback.
 */

import type { WebhookEvent } from "./event-bus-types";
import { findWorkItemByBranch, findWorkItemByPR, updateWorkItem } from "./work-items";
import { findPlanByBranch, findPlanByPR, updatePlanStatus } from "./plans";
import { triggerWorkflow, deleteBranch, mergePR } from "./github";
import { dispatchUnblockedItems } from "./atc/dispatcher";
import { MAX_RETRIES } from "./atc/types";

const LOG_PREFIX = "[event-reactor]";

/**
 * React to a batch of webhook events. Called by the webhook handler
 * after storing events. Each event is processed independently —
 * failures in one don't block others.
 */
export async function reactToEvents(events: WebhookEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await reactToEvent(event);
    } catch (err) {
      console.error(`${LOG_PREFIX} error processing ${event.type}:`, err);
    }
  }
}

async function reactToEvent(event: WebhookEvent): Promise<void> {
  switch (event.type) {
    case "github.ci.passed":
      await handleCIPassed(event);
      break;
    case "github.ci.failed":
      await handleCIFailed(event);
      break;
    case "github.pr.opened":
      await handlePROpened(event);
      break;
    case "github.pr.merged":
      await handlePRMerged(event);
      break;
    case "github.pr.closed":
      await handlePRClosed(event);
      break;
    case "github.pr.review_submitted":
      await handleReviewSubmitted(event);
      break;
    case "github.workflow.completed":
      await handleWorkflowCompleted(event);
      break;
    default:
      break;
  }
}

/**
 * CI passed → transition to reviewing + trigger TLM Code Review.
 */
async function handleCIPassed(event: WebhookEvent): Promise<void> {
  const { branch, workflowName } = event.payload;
  if (!branch || branch === "main") return;

  // Only react to the CI workflow, not to TLM reviews or other workflows
  if (workflowName && workflowName !== "CI") return;

  const item = await findWorkItemByBranch(branch);
  if (!item) return;

  if (item.status !== "executing") return;

  console.log(`${LOG_PREFIX} CI passed for ${item.id} (branch: ${branch}), transitioning to reviewing`);

  await updateWorkItem(item.id, { status: "reviewing" });

  // Trigger TLM Code Review via workflow_dispatch so it skips CI polling
  try {
    const prNumber = item.execution?.prNumber;
    if (prNumber) {
      await triggerWorkflow(item.targetRepo, "tlm-review.yml", branch, {
        pr_number: String(prNumber),
      });
      console.log(`${LOG_PREFIX} triggered TLM Code Review for PR #${prNumber}`);
    }
  } catch (err) {
    // Non-fatal: the check_suite trigger will pick this up as fallback
    console.warn(`${LOG_PREFIX} failed to trigger TLM Code Review:`, err);
  }
}

/**
 * CI failed → classify and handle immediately.
 */
async function handleCIFailed(event: WebhookEvent): Promise<void> {
  const { branch, workflowName } = event.payload;
  if (!branch || branch === "main") return;

  if (workflowName && workflowName !== "CI") return;

  const item = await findWorkItemByBranch(branch);
  if (!item) return;

  if (item.status !== "executing" && item.status !== "reviewing") return;

  console.log(`${LOG_PREFIX} CI failed for ${item.id} (branch: ${branch})`);

  const retryCount = item.execution?.retryCount ?? 0;
  const maxRetries = MAX_RETRIES;

  if (retryCount < maxRetries) {
    console.log(`${LOG_PREFIX} retrying ${item.id} (attempt ${retryCount + 1}/${maxRetries})`);
    await updateWorkItem(item.id, {
      status: "retrying",
      failureCategory: "transient",
      execution: {
        ...item.execution,
        retryCount: retryCount + 1,
      },
    });

    try {
      await triggerWorkflow(item.targetRepo, "execute-handoff.yml", "main", {
        branch: branch,
        handoff_path: item.handoff?.branch ? `handoffs/awaiting_handoff/${item.handoff.branch}.md` : "",
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to trigger retry for ${item.id}:`, err);
    }
  } else {
    console.log(`${LOG_PREFIX} ${item.id} exhausted retries, marking failed`);
    await updateWorkItem(item.id, {
      status: "failed",
      failureCategory: "execution",
      execution: {
        ...item.execution,
        completedAt: new Date().toISOString(),
        outcome: "failed",
      },
    });
  }
}

/**
 * PR opened → link PR to plan record so dashboard shows the PR link.
 */
async function handlePROpened(event: WebhookEvent): Promise<void> {
  const { prNumber, branch } = event.payload;
  if (!prNumber || !branch || branch === "main") return;

  // Link PR to plan (if this branch belongs to a plan)
  const plan = await findPlanByBranch(branch);
  if (!plan) return;

  // Only update if plan doesn't already have a PR linked
  if (plan.prNumber) return;

  const prUrl = `https://github.com/${event.repo}/pull/${prNumber}`;
  console.log(`${LOG_PREFIX} [plan] PR #${prNumber} opened for plan ${plan.id}, linking`);

  await updatePlanStatus(plan.id, plan.status, {
    prNumber,
    prUrl,
  });
}

/**
 * PR merged → transition work item to merged + transition plan to complete.
 */
async function handlePRMerged(event: WebhookEvent): Promise<void> {
  const { prNumber, branch } = event.payload;
  if (!prNumber) return;

  // Pipeline v2: Check if this PR belongs to a plan
  await handlePlanPRMerged(event.repo, prNumber, branch);

  // Legacy: Check if this PR belongs to a work item
  let item = await findWorkItemByPR(event.repo, prNumber);
  if (!item && branch) {
    item = await findWorkItemByBranch(branch);
    if (item) {
      console.log(`${LOG_PREFIX} findWorkItemByPR missed PR #${prNumber}, found via branch fallback: ${item.id}`);
    }
  }
  if (!item) return;

  if (item.status === "merged") return;

  console.log(`${LOG_PREFIX} PR #${prNumber} merged for ${item.id}`);

  await updateWorkItem(item.id, {
    status: "merged",
    execution: {
      ...item.execution,
      completedAt: new Date().toISOString(),
      outcome: "merged",
    },
  });

  // Auto-close associated Notion bug if this work item originated from a bug report
  if (item.source?.type === "bug") {
    try {
      const prUrl = `https://github.com/${event.repo}/pull/${prNumber}`;
      const { findAndCloseBug } = await import("./bug-closer");
      await findAndCloseBug(item.id, prUrl);
      console.log(`${LOG_PREFIX} closed Notion bug for work item ${item.id}`);
    } catch (err) {
      console.error(`${LOG_PREFIX} failed to close Notion bug for work item ${item.id}:`, err);
    }
  }

  // Immediately dispatch any items that were blocked on this one
  try {
    const result = await dispatchUnblockedItems(item.id, item.targetRepo);
    if (result.dispatched.length > 0) {
      console.log(`${LOG_PREFIX} dispatched ${result.dispatched.length} unblocked item(s) after ${item.id} merged`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} failed to dispatch unblocked items:`, err);
  }
}

/**
 * PR closed (not merged) → retry or mark failed.
 */
async function handlePRClosed(event: WebhookEvent): Promise<void> {
  const { prNumber, branch } = event.payload;
  if (!prNumber) return;

  const item = await findWorkItemByPR(event.repo, prNumber);
  if (!item) return;

  if (item.status !== "executing" && item.status !== "reviewing") return;

  console.log(`${LOG_PREFIX} PR #${prNumber} closed without merge for ${item.id}`);

  const retryCount = item.execution?.retryCount ?? 0;
  const maxRetries = MAX_RETRIES;

  if (retryCount < maxRetries) {
    if (branch) {
      try {
        await deleteBranch(item.targetRepo, branch);
      } catch {
        // Branch may already be deleted
      }
    }

    console.log(`${LOG_PREFIX} resetting ${item.id} to ready for retry (attempt ${retryCount + 1})`);
    await updateWorkItem(item.id, {
      status: "ready",
      failureCategory: "transient",
      execution: {
        ...item.execution,
        retryCount: retryCount + 1,
        prNumber: undefined,
        prUrl: undefined,
        completedAt: undefined,
        outcome: undefined,
      },
    });
  } else {
    console.log(`${LOG_PREFIX} ${item.id} exhausted retries, marking failed`);
    await updateWorkItem(item.id, {
      status: "failed",
      failureCategory: "execution",
      execution: {
        ...item.execution,
        completedAt: new Date().toISOString(),
        outcome: "failed",
      },
    });
  }
}

/**
 * Human review submitted → auto-merge on approval.
 * When a non-bot user approves a PR whose work item is blocked/reviewing
 * (FLAG_FOR_HUMAN state), merge the PR and transition to merged.
 */
async function handleReviewSubmitted(event: WebhookEvent): Promise<void> {
  const { prNumber, reviewState } = event.payload;

  // Only act on approvals — ignore comments and change requests
  if (reviewState !== "approved") return;
  if (!prNumber) return;

  const item = await findWorkItemByPR(event.repo, prNumber);
  if (!item) return;

  if (item.status !== "blocked" && item.status !== "reviewing") return;

  console.log(`${LOG_PREFIX} human approved PR #${prNumber} — auto-merging`);

  const result = await mergePR(event.repo, prNumber);
  if (!result.merged) {
    console.error(`${LOG_PREFIX} failed to merge PR #${prNumber}: ${result.error}`);
    return;
  }

  await updateWorkItem(item.id, {
    status: "merged",
    execution: {
      ...item.execution,
      completedAt: new Date().toISOString(),
      outcome: "merged",
    },
  });

  // Dispatch any items that were blocked on this one
  try {
    const dispatchResult = await dispatchUnblockedItems(item.id, item.targetRepo);
    if (dispatchResult.dispatched.length > 0) {
      console.log(`${LOG_PREFIX} dispatched ${dispatchResult.dispatched.length} unblocked item(s) after ${item.id} merged`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} failed to dispatch unblocked items:`, err);
  }
}

/**
 * Workflow completed → detect execute-handoff completion.
 */
async function handleWorkflowCompleted(event: WebhookEvent): Promise<void> {
  const { workflowName, branch, conclusion } = event.payload;

  if (workflowName !== "Execute Handoff") return;
  if (!branch || branch === "main") return;

  const item = await findWorkItemByBranch(branch);
  if (!item) return;

  if (item.status !== "executing") return;

  if (conclusion === "success") {
    console.log(`${LOG_PREFIX} execute-handoff completed for ${item.id}, transitioning to reviewing`);
    await updateWorkItem(item.id, { status: "reviewing" });
  } else if (conclusion === "failure") {
    console.log(`${LOG_PREFIX} execute-handoff failed for ${item.id}`);
    await updateWorkItem(item.id, {
      status: "failed",
      failureCategory: "execution",
      execution: {
        ...item.execution,
        completedAt: new Date().toISOString(),
        outcome: "failed",
      },
    });
  }
}

// ── Pipeline v2: Plan lifecycle transitions ────────────────────────────────

/**
 * When a PR is merged, find any plan associated with its branch and
 * transition it to "complete". Links the PR to the plan record.
 */
async function handlePlanPRMerged(
  repo: string,
  prNumber: number,
  branch?: string,
): Promise<void> {
  let plan = await findPlanByPR(repo, prNumber);
  if (!plan && branch) {
    plan = await findPlanByBranch(branch);
    if (plan) {
      console.log(`${LOG_PREFIX} [plan] findPlanByPR missed PR #${prNumber}, found via branch: ${plan.id}`);
    }
  }
  if (!plan) return;

  if (plan.status === "complete") return;

  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
  console.log(`${LOG_PREFIX} [plan] PR #${prNumber} merged for plan ${plan.id} ("${plan.prdTitle}")`);

  await updatePlanStatus(plan.id, "complete", {
    prNumber,
    prUrl,
    completedAt: new Date().toISOString(),
  });
}
