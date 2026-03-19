/**
 * Event Reactor: Maps GitHub webhook events to immediate pipeline actions.
 *
 * Instead of waiting for cron-based polling (5-15 min cycles), the reactor
 * triggers state transitions within seconds of the event occurring.
 * Cron agents remain as reconciliation fallback.
 */

import type { WebhookEvent } from "./event-bus-types";
import { findWorkItemByBranch, findWorkItemByPR, updateWorkItem } from "./work-items";
import { triggerWorkflow, deleteBranch, mergePR } from "./github";
import { dispatchUnblockedItems } from "./atc/dispatcher";

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
    case "github.pr.merged":
      await handlePRMerged(event);
      break;
    case "github.pr.closed":
      await handlePRClosed(event);
      break;
    case "github.pr.review_submitted":
      await handleReviewSubmitted(event);
      break;
    case "github.pr.comment":
      await handleHumanFeedback(event);
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
  const maxRetries = 2;

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
 * PR merged → transition to merged + dispatch unblocked items.
 */
async function handlePRMerged(event: WebhookEvent): Promise<void> {
  const { prNumber } = event.payload;
  if (!prNumber) return;

  const item = await findWorkItemByPR(event.repo, prNumber);
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
  const maxRetries = 2;

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
 * Human comment on a flagged PR → re-trigger execution with feedback.
 * When the repo owner comments on a PR whose work item is blocked
 * (FLAG_FOR_HUMAN state), re-dispatch execution with the comment as context.
 */
async function handleHumanFeedback(event: WebhookEvent): Promise<void> {
  const { prNumber, commentBody } = event.payload;
  if (!prNumber) return;

  const item = await findWorkItemByPR(event.repo, prNumber);
  if (!item) return;

  // Only act on blocked items (FLAG_FOR_HUMAN state)
  if (item.status !== "blocked") return;

  const branch = item.handoff?.branch;
  if (!branch) return;

  console.log(`${LOG_PREFIX} human feedback on PR #${prNumber} — re-triggering execution`);

  // Re-trigger execute-handoff workflow with feedback context
  try {
    await triggerWorkflow(item.targetRepo, "execute-handoff.yml", branch, {
      branch,
      human_feedback: commentBody ?? "",
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to re-trigger execution for PR #${prNumber}:`, err);
    return;
  }

  // Transition back to executing
  await updateWorkItem(item.id, {
    status: "executing",
    execution: {
      ...item.execution,
      outcome: undefined,
    },
  });
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
