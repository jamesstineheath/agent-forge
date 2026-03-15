import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  HandoffState,
  HandoffLifecycle,
  TriggerEvent,
  applyTransition,
  createLifecycle,
  isTerminal,
  getStateLabel,
} from "./state";

const LIFECYCLE_COMMENT_MARKER = "<!-- HANDOFF-LIFECYCLE-STATE -->";
const ARTIFACT_PREFIX = "handoff-lifecycle-";

type Octokit = ReturnType<typeof github.getOctokit>;

async function loadState(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<HandoffLifecycle | null> {
  const artifactName = `${ARTIFACT_PREFIX}${branch}`;

  try {
    // List artifacts for this repo, filtered by name
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

    // Download the artifact
    const { data: downloadData } = await octokit.rest.actions.downloadArtifact({
      owner,
      repo,
      artifact_id: artifact.id,
      archive_format: "zip",
    });

    // The download returns a zip - we need to extract it
    // In GitHub Actions, we can use the @actions/artifact package instead
    // For simplicity, parse from the redirect URL or use the artifact API
    const zipBuffer = Buffer.from(downloadData as ArrayBuffer);

    // Use a simple approach: look for JSON content in the zip
    // The zip format stores filenames and content - find the JSON
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
  // Simple zip extraction - look for JSON content between local file headers
  // ZIP local file header signature: 0x04034b50
  const str = buffer.toString("utf-8");
  const jsonStart = str.indexOf("{");
  const jsonEnd = str.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const candidate = str.substring(jsonStart, jsonEnd + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not valid JSON
    }
  }
  return null;
}

async function saveState(
  lifecycle: HandoffLifecycle
): Promise<void> {
  const fs = await import("fs");
  const path = await import("path");

  // Write state to a file that will be uploaded as an artifact
  const stateDir = path.join(
    process.env.GITHUB_WORKSPACE || process.cwd(),
    ".handoff-state"
  );
  fs.mkdirSync(stateDir, { recursive: true });

  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify(lifecycle, null, 2));

  // Use @actions/artifact to upload
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
      // Current step
      status = "In Progress";
    } else if (transition) {
      // Completed step
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

  // Find failure reason if failed
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
  // Look for existing lifecycle comment
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
      // Code review workflow completed - we need to determine the decision
      // from the PR comments since the workflow_run event doesn't carry it
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

  // Look for TLM-CODE-REVIEW-METADATA comment (most recent)
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

  // Fetch CI failure logs
  let ciFailureContext = "";
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
      ciFailureContext += `\n### Failed check: ${run.name}\n`;
      ciFailureContext += run.output?.summary || "No summary available";
      ciFailureContext += "\n";
    }
  } catch (error) {
    core.warning(`Could not fetch CI failure logs: ${error}`);
    ciFailureContext = "Could not fetch CI failure details.";
  }

  // Trigger execute-handoff workflow with the retry context
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
      // Manual dispatch or unrecognized event - try to report current state
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

    // Load existing state or create new
    let lifecycle = await loadState(octokit, owner, repo, branch);

    if (!lifecycle) {
      // Determine handoff file from branch
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

    // Apply the transition
    try {
      lifecycle = applyTransition(lifecycle, event, details);
      core.info(`Transitioned to: ${lifecycle.state}`);
    } catch (error) {
      core.warning(`State transition failed: ${error}`);
      // Log but don't fail the workflow - the orchestrator is observational
      return;
    }

    // Handle retry logic for CI failures
    if (lifecycle.state === HandoffState.CIFailed && lifecycle.retryCount < 1) {
      lifecycle = applyTransition(
        lifecycle,
        { type: "retry_triggered" },
        "Auto-retry after CI failure"
      );
      await triggerRetry(octokit, owner, repo, lifecycle);
    } else if (lifecycle.state === HandoffState.CIFailed && lifecycle.retryCount >= 1) {
      lifecycle = applyTransition(
        lifecycle,
        { type: "pr_closed" },
        "CI failed after retry, max retries reached"
      );
    }

    // Handle execution failure retry
    if (lifecycle.state === HandoffState.ExecutionFailed && lifecycle.retryCount < 1) {
      lifecycle = applyTransition(
        lifecycle,
        { type: "retry_triggered" },
        "Auto-retry after execution failure"
      );
      await triggerRetry(octokit, owner, repo, lifecycle);
    } else if (lifecycle.state === HandoffState.ExecutionFailed && lifecycle.retryCount >= 1) {
      lifecycle = applyTransition(
        lifecycle,
        { type: "pr_closed" },
        "Execution failed after retry, max retries reached"
      );
    }

    // Parse execution cost from PR comments if available
    const prNumber = await findPRForBranch(octokit, owner, repo, branch);
    if (prNumber) {
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
          // Re-apply with the correct decision if it differs
          // The workflow_run event doesn't carry the review decision
          // so we may need to correct the transition
          core.info(`Code review decision from metadata: ${decision}`);
        }
      }

      // Update PR comment
      const commentBody = buildLifecycleComment(lifecycle);
      await findOrCreateComment(octokit, owner, repo, prNumber, commentBody);
    }

    // Save state
    await saveState(lifecycle);

    // Set outputs
    core.setOutput("state", lifecycle.state);
    core.setOutput("branch", branch);
    core.setOutput("retry-count", lifecycle.retryCount.toString());
  } catch (error) {
    core.setFailed(`Handoff orchestrator failed: ${error}`);
  }
}

run();
