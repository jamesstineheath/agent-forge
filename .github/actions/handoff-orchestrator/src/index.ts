import * as core from "@actions/core";
import * as github from "@actions/github";
import AdmZip from "adm-zip";
import {
  HandoffState,
  HandoffLifecycle,
  TriggerEvent,
  applyTransitionResilient,
  createLifecycle,
  isTerminal,
  getStateLabel,
} from "./state";

const LIFECYCLE_COMMENT_MARKER = "<!-- HANDOFF-LIFECYCLE-STATE -->";
const STATE_JSON_MARKER_START = "<!-- LIFECYCLE-JSON:";
const STATE_JSON_MARKER_END = ":LIFECYCLE-JSON -->";
const ARTIFACT_PREFIX = "handoff-lifecycle-";

type Octokit = ReturnType<typeof github.getOctokit>;

/**
 * Load state from PR comment (preferred) or artifact (fallback).
 * PR comments are more reliable than artifacts since they don't require
 * zip extraction and persist across workflow runs naturally.
 */
async function loadState(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  prNumber: number | null
): Promise<HandoffLifecycle | null> {
  // Try PR comment first (more reliable)
  if (prNumber) {
    const stateFromComment = await loadStateFromComment(octokit, owner, repo, prNumber);
    if (stateFromComment) {
      core.info(`Loaded state from PR #${prNumber} comment`);
      return stateFromComment;
    }
  }

  // Fall back to artifacts
  return loadStateFromArtifact(octokit, owner, repo, branch);
}

async function loadStateFromComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<HandoffLifecycle | null> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    const lifecycleComment = comments.find(
      (c) => c.body?.includes(LIFECYCLE_COMMENT_MARKER)
    );

    if (!lifecycleComment?.body) return null;

    const jsonStart = lifecycleComment.body.indexOf(STATE_JSON_MARKER_START);
    const jsonEnd = lifecycleComment.body.indexOf(STATE_JSON_MARKER_END);
    if (jsonStart === -1 || jsonEnd === -1) return null;

    const jsonStr = lifecycleComment.body.substring(
      jsonStart + STATE_JSON_MARKER_START.length,
      jsonEnd
    );
    return JSON.parse(jsonStr) as HandoffLifecycle;
  } catch (error) {
    core.info(`Could not load state from PR comment: ${error}`);
    return null;
  }
}

async function loadStateFromArtifact(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<HandoffLifecycle | null> {
  const artifactName = `${ARTIFACT_PREFIX}${branch}`;

  try {
    const { data } = await octokit.rest.actions.listArtifactsForRepo({
      owner,
      repo,
      name: artifactName,
      per_page: 1,
    });

    if (data.artifacts.length === 0) {
      core.info(`No existing state artifact found for branch: ${branch}`);
      return null;
    }

    const artifact = data.artifacts[0];

    const { data: downloadData } = await octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: "zip",
    });

    const zipBuffer = Buffer.from(downloadData as ArrayBuffer);
    const content = extractJsonFromZip(zipBuffer);
    if (content) {
      return JSON.parse(content) as HandoffLifecycle;
    }

    core.warning("Could not extract state from artifact zip");
    return null;
  } catch (error) {
    core.info(`Could not load state artifact: ${error}`);
    return null;
  }
}

function extractJsonFromZip(buffer: Buffer): string | null {
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.endsWith(".json")) {
        return entry.getData().toString("utf-8");
      }
    }
    // If no .json entry found, try the first text entry
    for (const entry of entries) {
      if (!entry.isDirectory) {
        const text = entry.getData().toString("utf-8");
        try {
          JSON.parse(text);
          return text;
        } catch {
          // Not JSON, skip
        }
      }
    }
    return null;
  } catch (error) {
    core.warning(`Failed to extract JSON from zip: ${error}`);
    return null;
  }
}

async function saveState(
  lifecycle: HandoffLifecycle
): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");

  const stateDir = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    ".handoff-state"
  );
  fs.mkdirSync(stateDir, { recursive: true });

  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(lifecycle, null, 2));

  const { DefaultArtifactClient } = await import("@actions/artifact");
  const artifactClient = new DefaultArtifactClient();
  const artifactName = `${ARTIFACT_PREFIX}${lifecycle.branch}`;

  await artifactClient.uploadArtifact(artifactName, [stateFile], stateDir);
  core.info(`State artifact uploaded: ${artifactName}`);
}

function buildLifecycleComment(lifecycle: HandoffLifecycle): string {
  const steps = [
    { name: "Spec Review", states: [HandoffState.SpecReview, HandoffState.SpecReviewComplete] },
    { name: "Execution", states: [HandoffState.Executing, HandoffState.ExecutionComplete, HandoffState.ExecutionFailed, HandoffState.RetryingExecution] },
    { name: "CI", states: [HandoffState.CIRunning, HandoffState.CIPassed, HandoffState.CIFailed] },
    { name: "Code Review", states: [HandoffState.CodeReview, HandoffState.CodeReviewComplete, HandoffState.RequestedChanges, HandoffState.NeedsHumanReview] },
    { name: "Merge", states: [HandoffState.Merged] },
  ];

  const rows: string[] = [];
  for (const step of steps) {
    const transition = lifecycle.transitions
      .filter((t) => step.states.includes(t.to))
      .pop();

    let status: string;
    let duration = "-";
    let details = "-";

    if (step.states.includes(lifecycle.state)) {
      status = "In Progress";
    } else if (transition) {
      const prevTransition = lifecycle.transitions.find(
        (t) => step.states.includes(t.from) || step.states.includes(t.to)
      );
      if (prevTransition && transition) {
        const start = new Date(prevTransition.timestamp).getTime();
        const end = new Date(transition.timestamp).getTime();
        const durationMs = end - start;
        if (durationMs > 0) {
          duration = formatDuration(durationMs);
        }
      }

      if (lifecycle.state === HandoffState.Failed && step.states.includes(HandoffState.CIFailed)) {
        status = "Failed";
      } else if (lifecycle.state === HandoffState.Failed && step.states.includes(HandoffState.ExecutionFailed)) {
        status = "Failed";
      } else {
        status = "Passed";
      }
      details = transition.details || "-";
    } else {
      status = "Pending";
    }

    rows.push(`| ${step.name} | ${status} | ${duration} | ${details} |`);
  }

  // Embed state JSON as hidden HTML comment for reliable persistence
  const stateJson = JSON.stringify(lifecycle);

  const lines = [
    LIFECYCLE_COMMENT_MARKER,
    "## Handoff Lifecycle",
    "",
    `**Current state:** ${getStateLabel(lifecycle.state)}`,
    `**Retries:** ${lifecycle.retryCount}/1`,
    "",
    "| Step | Status | Duration | Details |",
    "|------|--------|----------|---------|",
    ...rows,
  ];

  if (isTerminal(lifecycle.state)) {
    lines.push("");
    lines.push("---");
    lines.push(buildEndSummary(lifecycle));
  }

  // Append hidden state JSON for persistence
  lines.push("");
  lines.push(`${STATE_JSON_MARKER_START}${stateJson}${STATE_JSON_MARKER_END}`);

  return lines.join("\n");
}

function buildEndSummary(lifecycle: HandoffLifecycle): string {
  const startTime = new Date(lifecycle.startedAt).getTime();
  const endTime = lifecycle.completedAt
    ? new Date(lifecycle.completedAt).getTime()
    : Date.now();
  const totalDuration = formatDuration(endTime - startTime);

  const lines = [
    `### End-State Summary`,
    "",
    `- **Final state:** ${getStateLabel(lifecycle.state)}`,
    `- **Total duration:** ${totalDuration}`,
    `- **Total cost:** ${lifecycle.totalCost !== null ? `$${lifecycle.totalCost.toFixed(2)}` : "unknown"}`,
    `- **Retries:** ${lifecycle.retryCount}`,
  ];

  if (lifecycle.state === HandoffState.Failed) {
    const lastTransition = lifecycle.transitions[lifecycle.transitions.length - 1];
    if (lastTransition?.details) {
      lines.push(`- **Failure reason:** ${lastTransition.details}`);
    }
  }

  return lines.join("\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

async function findOrCreateComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const existing = comments.find(
    (c) => c.body?.includes(LIFECYCLE_COMMENT_MARKER)
  );

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated lifecycle comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    core.info(`Created lifecycle comment on PR #${prNumber}`);
  }
}

async function findPRForBranch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<number | null> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "all",
    per_page: 1,
  });

  return prs.length > 0 ? prs[0].number : null;
}

function parseExecutionCost(comments: Array<{ body?: string }>): number | null {
  for (const comment of comments) {
    if (!comment.body) continue;
    const costMatch = comment.body.match(
      /\*\*Actual cost:\*\*\s*\$?([\d.]+)/
    );
    if (costMatch) {
      return parseFloat(costMatch[1]);
    }
  }
  return null;
}

function determineEvent(context: typeof github.context): {
  event: TriggerEvent;
  branch: string;
  details?: string;
} | null {
  const eventName = context.eventName;
  const payload = context.payload;

  if (eventName === "workflow_run") {
    const workflowRun = payload.workflow_run;
    if (!workflowRun) return null;

    const workflowName = workflowRun.name as string;
    const conclusion = workflowRun.conclusion as string;
    const branch = workflowRun.head_branch as string;

    if (workflowName === "TLM Spec Review") {
      return {
        event: {
          type: "spec_review_completed",
          conclusion: conclusion === "success" ? "success" : "failure",
        },
        branch,
        details: `Conclusion: ${conclusion}`,
      };
    }

    if (workflowName === "Execute Handoff") {
      return {
        event: {
          type: "execution_completed",
          conclusion: conclusion === "success" ? "success" : "failure",
        },
        branch,
        details: `Conclusion: ${conclusion}`,
      };
    }

    if (workflowName === "CI") {
      return {
        event: {
          type: "ci_completed",
          conclusion: conclusion === "success" ? "success" : "failure",
        },
        branch,
        details: `Conclusion: ${conclusion}`,
      };
    }

    if (workflowName === "TLM Code Review") {
      return {
        event: {
          type: "code_review_completed",
          decision: conclusion === "success" ? "approve" : "flag_for_human",
        },
        branch,
        details: `Conclusion: ${conclusion}`,
      };
    }

    return null;
  }

  if (eventName === "pull_request") {
    const pr = payload.pull_request;
    if (!pr) return null;

    const branch = pr.head?.ref as string;
    const action = payload.action as string;

    if (action === "closed" && pr.merged) {
      return {
        event: { type: "pr_merged" },
        branch,
        details: "PR merged",
      };
    }

    if (action === "closed" && !pr.merged) {
      return {
        event: { type: "pr_closed" },
        branch,
        details: "PR closed without merge",
      };
    }

    return null;
  }

  if (eventName === "workflow_dispatch") {
    core.info("Manual dispatch - reporting current state only");
    return null;
  }

  return null;
}

async function parseCodeReviewDecision(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<"approve" | "request_changes" | "flag_for_human" | null> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 50,
  });

  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i].body || "";
    const match = body.match(
      /<!--\s*TLM-CODE-REVIEW-METADATA\s*\n[\s\S]*?decision:\s*(approve|request_changes|flag_for_human)/
    );
    if (match) {
      return match[1] as "approve" | "request_changes" | "flag_for_human";
    }
  }
  return null;
}

async function triggerRetry(
  octokit: Octokit,
  owner: string,
  repo: string,
  lifecycle: HandoffLifecycle
): Promise<void> {
  core.info(`Triggering retry for branch ${lifecycle.branch}...`);

  try {
    const { data: checkRuns } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: lifecycle.branch,
      status: "completed",
      per_page: 10,
    });

    const failedRuns = checkRuns.check_runs.filter(
      (r) => r.conclusion === "failure"
    );

    for (const run of failedRuns.slice(0, 3)) {
      core.info(`Failed check: ${run.name} - ${run.output?.summary || "No summary"}`);
    }
  } catch (error) {
    core.warning(`Could not fetch CI failure logs: ${error}`);
  }

  await octokit.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: "execute-handoff.yml",
    ref: lifecycle.branch,
    inputs: {
      branch: lifecycle.branch,
      handoff_file: lifecycle.handoffFile,
    },
  });

  core.info("Retry workflow dispatch triggered successfully");
}

async function run(): Promise<void> {
  try {
    const githubToken = core.getInput("github-token", { required: true });
    const octokit = github.getOctokit(githubToken);
    const context = github.context;
    const { owner, repo } = context.repo;

    // Determine what event triggered us
    const eventInfo = determineEvent(context);

    if (!eventInfo) {
      core.info("No actionable event detected. Checking for manual dispatch state query.");
      return;
    }

    const { event, branch, details } = eventInfo;
    core.info(`Event: ${event.type} on branch: ${branch}`);

    // Skip main/master branches
    if (branch === "main" || branch === "master") {
      core.info("Skipping orchestrator for main/master branch");
      return;
    }

    // Find PR early - needed for state loading from comments
    let prNumber: number | null = null;
    try {
      prNumber = await findPRForBranch(octokit, owner, repo, branch);
    } catch (error) {
      core.warning(`Could not find PR for branch: ${error}`);
    }

    // Load existing state or create new
    let lifecycle = await loadState(octokit, owner, repo, branch, prNumber);

    if (!lifecycle) {
      let handoffFile = "unknown";
      try {
        const { data: files } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: "handoffs/awaiting_handoff",
          ref: branch,
        });
        if (Array.isArray(files)) {
          const mdFile = files.find(
            (f) => f.name.endsWith(".md") && f.name !== "README.md"
          );
          if (mdFile) {
            handoffFile = `handoffs/awaiting_handoff/${mdFile.name}`;
          }
        }
      } catch {
        core.info("Could not auto-detect handoff file");
      }

      lifecycle = createLifecycle(branch, handoffFile);
      core.info(`Created new lifecycle for branch: ${branch}`);
    }

    // Skip if already in terminal state
    if (isTerminal(lifecycle.state)) {
      core.info(`Lifecycle already in terminal state: ${lifecycle.state}`);
      return;
    }

    // Apply the transition using resilient handler (handles out-of-order events)
    try {
      lifecycle = applyTransitionResilient(lifecycle, event, details);
      core.info(`Transitioned to: ${lifecycle.state}`);
    } catch (error) {
      core.warning(`State transition failed: ${error}`);
      // Log but don't fail the workflow - the orchestrator is observational
      return;
    }

    // Handle retry logic for CI failures
    try {
      if (lifecycle.state === HandoffState.CIFailed && lifecycle.retryCount < 1) {
        lifecycle = applyTransitionResilient(
          lifecycle,
          { type: "retry_triggered" },
          "Auto-retry after CI failure"
        );
        await triggerRetry(octokit, owner, repo, lifecycle);
      } else if (lifecycle.state === HandoffState.CIFailed && lifecycle.retryCount >= 1) {
        lifecycle = applyTransitionResilient(
          lifecycle,
          { type: "pr_closed" },
          "CI failed after retry, max retries reached"
        );
      }
    } catch (error) {
      core.warning(`CI retry handling failed: ${error}`);
    }

    // Handle execution failure retry
    try {
      if (lifecycle.state === HandoffState.ExecutionFailed && lifecycle.retryCount < 1) {
        lifecycle = applyTransitionResilient(
          lifecycle,
          { type: "retry_triggered" },
          "Auto-retry after execution failure"
        );
        await triggerRetry(octokit, owner, repo, lifecycle);
      } else if (lifecycle.state === HandoffState.ExecutionFailed && lifecycle.retryCount >= 1) {
        lifecycle = applyTransitionResilient(
          lifecycle,
          { type: "pr_closed" },
          "Execution failed after retry, max retries reached"
        );
      }
    } catch (error) {
      core.warning(`Execution retry handling failed: ${error}`);
    }

    // Parse execution cost from PR comments if available
    if (prNumber) {
      try {
        const { data: comments } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: prNumber,
          per_page: 50,
        });

        const cost = parseExecutionCost(comments);
        if (cost !== null) {
          lifecycle.totalCost = cost;
        }

        // If code review completed, parse the actual decision from comments
        if (event.type === "code_review_completed") {
          const decision = await parseCodeReviewDecision(
            octokit,
            owner,
            repo,
            prNumber
          );
          if (decision && decision !== "approve") {
            core.info(`Code review decision from metadata: ${decision}`);
          }
        }
      } catch (error) {
        core.warning(`Could not parse PR comments: ${error}`);
      }

      // Update PR comment with lifecycle status (also persists state)
      try {
        const commentBody = buildLifecycleComment(lifecycle);
        await findOrCreateComment(octokit, owner, repo, prNumber, commentBody);
      } catch (error) {
        core.warning(`Could not update lifecycle comment: ${error}`);
      }
    }

    // Save state to artifact (secondary persistence)
    try {
      await saveState(lifecycle);
    } catch (error) {
      core.warning(`Could not save state artifact: ${error}`);
      // Non-fatal: state is also persisted in PR comment
    }

    // Set outputs
    core.setOutput("state", lifecycle.state);
    core.setOutput("branch", branch);
    core.setOutput("retry-count", lifecycle.retryCount.toString());
  } catch (error) {
    // The orchestrator is observational - it should never fail the pipeline
    core.warning(`Handoff orchestrator encountered an error: ${error}`);
  }
}

run();
