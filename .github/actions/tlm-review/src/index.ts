import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import { buildSystemPrompt, buildUserPrompt } from "./review-prompt";

interface ReviewIssue {
  file: string;
  line: number;
  severity: "critical" | "warning" | "info";
  category?: "security" | "bug" | "performance" | "style" | "architecture";
  message: string;
}

interface PatternMatch {
  pattern: string;
  matched: boolean;
  justification: string;
}

interface ReviewResult {
  decision: "approve" | "request_changes" | "flag_for_human";
  summary: string;
  pattern_check?: string;
  pattern_matches?: PatternMatch[];
  issues: ReviewIssue[];
  auto_merge_safe: boolean;
  reasoning: string;
}

async function callClaudeAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<ReviewResult> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Claude API error (${response.status}): ${errorText}`
    );
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("No text response from Claude API");
  }

  // Extract JSON from response (Claude may wrap it in markdown code blocks)
  let jsonStr = textBlock.text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }
  // Also try to find raw JSON object
  if (!jsonStr.startsWith("{")) {
    const rawMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (rawMatch) {
      jsonStr = rawMatch[0];
    }
  }

  try {
    return JSON.parse(jsonStr) as ReviewResult;
  } catch (e) {
    core.warning(`Failed to parse Claude response as JSON: ${jsonStr}`);
    return {
      decision: "flag_for_human",
      summary:
        "TLM could not parse Claude API response. Flagging for human review.",
      issues: [],
      auto_merge_safe: false,
      reasoning: `JSON parse error: ${e}`,
    };
  }
}

// Parsed from TLM-SPEC-REVIEW HTML comment metadata in PR comments
interface SpecReviewMetadata {
  decision: string;
  improved: string;
  changes_summary: string;
  flagged_risks: string;
}

function parseSpecReviewMetadata(
  comments: Array<{ body?: string }>
): string | null {
  for (const comment of comments) {
    if (!comment.body) continue;
    const match = comment.body.match(
      /<!--\s*\nTLM-SPEC-REVIEW\n([\s\S]*?)-->/
    );
    if (!match) continue;

    const lines = match[1].trim().split("\n");
    const metadata: Record<string, string> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        metadata[key] = value;
      }
    }

    if (!metadata.decision) continue;

    const parts: string[] = [];
    parts.push(`Spec Review Decision: ${metadata.decision}`);
    if (metadata.improved === "true") {
      parts.push("The spec was improved by the Spec Reviewer before execution.");
    }
    if (metadata.changes_summary && metadata.changes_summary !== "") {
      parts.push(`Changes: ${metadata.changes_summary}`);
    }
    if (metadata.flagged_risks && metadata.flagged_risks !== "none") {
      parts.push(`Flagged Risks: ${metadata.flagged_risks}`);
    }

    return parts.join("\n");
  }

  return null;
}

function detectStaleness(memoryContent: string | null): string | null {
  if (!memoryContent) return null;

  const lastAssessmentMatch = memoryContent.match(
    /Last Assessment:\s*(\d{4}-\d{2}-\d{2})/
  );
  if (!lastAssessmentMatch) return null;

  const lastDate = new Date(lastAssessmentMatch[1]);
  const now = new Date();
  const daysSince = Math.floor(
    (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysSince > 3) {
    return `The Outcome Tracker has not run in ${daysSince} days (last: ${lastAssessmentMatch[1]}). Review memory may be stale — weigh patterns with lower confidence.`;
  }

  return null;
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    core.info(`Context file not found: ${filePath}`);
    return null;
  }
}

function loadADRSummaries(adrDir: string): string | null {
  try {
    const files = fs
      .readdirSync(adrDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    if (files.length === 0) return null;

    const summaries: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(adrDir, file), "utf-8");
      // Extract title (first # heading) and status
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/i);
      const title = titleMatch ? titleMatch[1] : file.replace(".md", "");
      const status = statusMatch ? statusMatch[1].trim() : "Unknown";
      summaries.push(`- **${title}** — Status: ${status}`);
    }

    return summaries.join("\n");
  } catch {
    core.info(`ADR directory not found: ${adrDir}`);
    return null;
  }
}

function loadCodebaseContext(): {
  systemMap: string | null;
  adrSummaries: string | null;
  reviewMemory: string | null;
} {
  // GitHub Actions checks out the repo to the workspace directory
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

  const systemMap = readFileOrNull(
    path.join(workspace, "docs", "SYSTEM_MAP.md")
  );
  const adrSummaries = loadADRSummaries(path.join(workspace, "docs", "adr"));
  const reviewMemory = readFileOrNull(
    path.join(workspace, "docs", "tlm-memory.md")
  );

  const loaded: string[] = [];
  if (systemMap) loaded.push("system map");
  if (adrSummaries) loaded.push("ADR summaries");
  if (reviewMemory) loaded.push("review memory");

  if (loaded.length > 0) {
    core.info(`Loaded codebase context: ${loaded.join(", ")}`);
  } else {
    core.info("No codebase context files found, using base prompt only.");
  }

  return { systemMap, adrSummaries, reviewMemory };
}

async function hasRecentTLMComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  marker: string,
  withinMinutes: number = 30
): Promise<boolean> {
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const cutoff = Date.now() - withinMinutes * 60 * 1000;
  return reviews.some(
    (r) =>
      r.body?.includes(marker) &&
      new Date(r.submitted_at ?? 0).getTime() > cutoff
  );
}

// Check run names to exclude from CI status — these are TLM's own jobs.
// The review job is named "review" in the workflow YAML.
const SELF_CHECK_NAMES = ["review", "tlm", "code review"];

async function checkCIStatus(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  ref: string,
  prNumber: number
): Promise<"passed" | "failing" | "pending"> {
  // Get check runs (CI uses check runs, not commit statuses)
  const { data: checkRuns } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref,
  });
  const ciChecks = checkRuns.check_runs.filter(
    (cr) => !SELF_CHECK_NAMES.some((name) => cr.name.toLowerCase().includes(name))
  );

  if (ciChecks.length === 0) {
    core.info("No CI check runs found (excluding TLM), proceeding with review.");
    return "passed";
  }

  const failedChecks = ciChecks.filter((cr) => cr.conclusion === "failure");
  if (failedChecks.length > 0) {
    core.info(`CI failing: ${failedChecks.map((c) => c.name).join(", ")}`);

    const alreadyPostedFailing = await hasRecentTLMComment(
      octokit, owner, repo, prNumber, "TLM Review: CI_BLOCKED"
    );
    if (!alreadyPostedFailing) {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: [
          "## TLM Review: CI_BLOCKED",
          "",
          "CI is failing. Code review deferred until CI passes.",
          "",
          "Failing checks:",
          ...failedChecks.map((c) => `- \`${c.name}\`: ${c.conclusion}`),
          "",
          "*Will automatically re-review when CI completes (via check_suite trigger).*",
        ].join("\n"),
        event: "COMMENT",
      });
    } else {
      core.info("Skipping duplicate CI_BLOCKED comment (recent one exists).");
    }
    return "failing";
  }

  const pendingChecks = ciChecks.filter(
    (cr) => cr.status === "in_progress" || cr.status === "queued"
  );
  if (pendingChecks.length > 0) {
    core.info(`CI still running: ${pendingChecks.map((c) => c.name).join(", ")}`);

    const alreadyPostedPending = await hasRecentTLMComment(
      octokit, owner, repo, prNumber, "TLM Review: CI Pending"
    );
    if (!alreadyPostedPending) {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: [
          "## TLM Review: CI Pending",
          "",
          "CI still running. Will review on check_suite completion.",
          "",
          "Pending checks:",
          ...pendingChecks.map((c) => `- \`${c.name}\`: ${c.status}`),
        ].join("\n"),
        event: "COMMENT",
      });
    } else {
      core.info("Skipping duplicate CI Pending comment (recent one exists).");
    }
    return "pending";
  }

  core.info("All CI checks passed, proceeding with review.");
  return "passed";
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("anthropic-api-key", { required: true });
    const githubToken = core.getInput("github-token", { required: true });
    const model = core.getInput("model");
    const autoMerge = core.getInput("auto-merge") === "true";
    const maxDiffLines = parseInt(core.getInput("max-diff-lines"), 10);

    const context = github.context;
    const octokit = github.getOctokit(githubToken);

    // Determine PR number from different event types
    let prNumber: number | undefined;
    // When triggered via workflow_dispatch (by the event reactor), CI already passed.
    const ciAlreadyVerified = context.eventName === "workflow_dispatch";

    if (context.eventName === "workflow_dispatch") {
      // PR number passed as input by the event reactor
      const inputPR = core.getInput("pr_number") || process.env.INPUT_PR_NUMBER;
      if (inputPR) {
        prNumber = parseInt(inputPR, 10);
        core.info(`workflow_dispatch: reviewing PR #${prNumber} (CI pre-verified by reactor)`);
      }
    } else if (context.eventName === "pull_request") {
      prNumber = context.payload.pull_request?.number;
    } else if (context.eventName === "check_suite") {
      // Find PRs associated with this check suite
      const checkSuite = context.payload.check_suite;
      if (checkSuite?.pull_requests?.length > 0) {
        prNumber = checkSuite.pull_requests[0].number;
      }
    }

    // Fallback: query for open PRs matching the check suite's HEAD SHA
    if (!prNumber && context.eventName === "check_suite") {
      const headSha = context.payload.check_suite?.head_sha;
      if (headSha) {
        const { data: pulls } = await octokit.rest.pulls.list({
          owner: context.repo.owner,
          repo: context.repo.repo,
          state: "open",
          sort: "updated",
          direction: "desc",
          per_page: 10,
        });
        const matchingPr = pulls.find((p) => p.head.sha === headSha);
        if (matchingPr) {
          prNumber = matchingPr.number;
          core.info(
            `Found PR #${prNumber} by SHA match for check_suite event`
          );
        }
      }
    }

    if (!prNumber) {
      core.info("No PR associated with this event, skipping review.");
      return;
    }

    const owner = context.repo.owner;
    const repo = context.repo.repo;

    core.info(`Reviewing PR #${prNumber} in ${owner}/${repo}`);

    // Fetch PR details
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Skip draft PRs
    if (pr.draft) {
      core.info("PR is a draft, skipping review.");
      return;
    }

    // Pipeline PRs from github-actions[bot] must be reviewed by TLM.
    // Bot-skip logic removed to allow TLM to review all non-draft PRs.

    // On check_suite, wait briefly for any remaining CI checks to complete.
    // Sometimes check_suite fires before all checks in other suites have concluded.
    if (context.eventName === "check_suite") {
      let checksReady = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        const { data: checkRuns } = await octokit.rest.checks.listForRef({
          owner,
          repo,
          ref: pr.head.sha,
        });

        const ciChecks = checkRuns.check_runs.filter(
          (cr) => !SELF_CHECK_NAMES.some((name) => cr.name.toLowerCase().includes(name))
        );

        const stillRunning = ciChecks.filter(
          (cr) => cr.status === "in_progress" || cr.status === "queued"
        );

        if (stillRunning.length === 0) {
          checksReady = true;
          break;
        }

        if (attempt < 3) {
          core.info(
            `check_suite event but ${stillRunning.length} CI check(s) still running: ${stillRunning.map((c) => c.name).join(", ")}. Polling (${attempt + 1}/4)...`
          );
          await new Promise((resolve) => setTimeout(resolve, 15000));
        } else {
          core.info(
            `check_suite event: ${stillRunning.length} CI check(s) still running after 45s. Proceeding anyway — will check CI status before merge.`
          );
          checksReady = true; // Let checkCIStatus handle it downstream
        }
      }
      if (!checksReady) return;
    }

    // Dedup: skip if TLM already posted a full review for this commit
    if (context.eventName === "check_suite") {
      const { data: existingReviews } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      const hasFullReview = existingReviews.some(
        (r) =>
          r.body?.includes("## TLM Review:") &&
          !r.body?.includes("CI_BLOCKED") &&
          !r.body?.includes("CI Pending") &&
          r.commit_id === pr.head.sha
      );
      if (hasFullReview) {
        core.info(`TLM already posted a full review for commit ${pr.head.sha}, skipping.`);
        return;
      }
    }

    // Fetch the diff
    const { data: diffData } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    const diff = diffData as unknown as string;
    const diffLineCount = diff.split("\n").length;

    // Fetch changed files list
    const { data: filesData } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const changedFiles = filesData.map((f) => f.filename);

    core.info(
      `PR has ${changedFiles.length} changed files, ${diffLineCount} diff lines`
    );

    // Check CI status before reviewing — don't approve if CI is failing.
    // Skip entirely on workflow_dispatch: the event reactor only triggers this
    // after CI has already passed, so polling is unnecessary.
    let ciStatus: "passed" | "failing" | "pending" = "passed";

    if (ciAlreadyVerified) {
      core.info("Skipping CI check — triggered by event reactor (CI pre-verified).");
    } else {
      ciStatus = await checkCIStatus(octokit, owner, repo, pr.head.sha, prNumber);
    }

    // On pull_request events, poll for CI to complete.
    // CI typically takes 90-120s. Poll for up to 180s (12 × 15s) to avoid
    // deferring to check_suite, which is unreliable (chicken-and-egg: TLM's
    // own check_suite completion can't trigger itself).
    if (context.eventName === "pull_request" && ciStatus === "pending") {
      core.info("CI is pending, waiting up to 180s for completion...");
      for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        ciStatus = await checkCIStatus(octokit, owner, repo, pr.head.sha, prNumber);
        if (ciStatus !== "pending") break;
      }
      if (ciStatus === "pending") {
        core.info("CI still pending after 180s, deferring to check_suite handler.");
        core.setOutput("decision", "ci_pending");
        core.setOutput("summary", "CI is pending, deferring review to check_suite event.");
        return;
      }
    }

    if (ciStatus === "failing") {
      core.setOutput("decision", "ci_blocked");
      core.setOutput("summary", "CI is failing, review recorded as CI_BLOCKED.");
      return;
    }

    if (ciStatus === "pending") {
      core.setOutput("decision", "ci_pending");
      core.setOutput("summary", "CI is pending, deferring review.");
      return;
    }

    // Risk escalation gate: tiered sensitive path handling
    // Tier 1: Always requires human review (core execution/review infrastructure)
    const TIER1_ALWAYS_FLAG = [
      '.github/workflows/execute-handoff.yml',
      '.github/workflows/tlm-review.yml',
      '.github/workflows/handoff-orchestrator.yml',
      'lib/atc.ts',
      'lib/orchestrator.ts',
    ];
    // Tier 2: Flag only if change is high-risk (agent prompts, action scripts)
    // These proceed to normal Claude review which can approve if low-risk
    const TIER2_REVIEW_AWARE = [
      '.github/actions/tlm-review/',
      '.github/actions/tlm-spec-review/',
      '.github/actions/tlm-outcome-tracker/',
      '.github/actions/handoff-orchestrator/',
      '.github/workflows/tlm-spec-review.yml',
      '.github/workflows/tlm-outcome-tracker.yml',
      'lib/claude-code/executor.ts',
      'lib/claude-code/pipeline.ts',
      'lib/claude-code/worktree.ts',
      'lib/claude-code/recovery.ts',
      'lib/agents/executor.ts',
      'lib/cron-config.ts',
      'lib/cron/job-executor.ts',
    ];

    const matchesPatterns = (file: string, patterns: string[]) =>
      patterns.some((pattern) =>
        pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern
      );

    const tier1Files = changedFiles.filter((f) => matchesPatterns(f, TIER1_ALWAYS_FLAG));
    const tier2Files = changedFiles.filter((f) => matchesPatterns(f, TIER2_REVIEW_AWARE));

    // Tier 1: always flag for human
    if (tier1Files.length > 0) {
      const fileList = tier1Files.map((f) => `- \`${f}\``).join('\n');
      core.info(`PR touches ${tier1Files.length} Tier 1 sensitive path(s), flagging for human review.`);
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        body: [
          '## TLM Review: FLAG FOR HUMAN',
          '',
          'This PR modifies core pipeline infrastructure that requires human review before merge.',
          '',
          '### Tier 1 sensitive files (always require human review):',
          fileList,
          '',
          'Auto-merge is disabled for this PR. A human must review and merge manually.',
          '',
          '*Automated review by TLM Code Reviewer*',
        ].join('\n'),
        event: 'COMMENT',
      });
      core.setOutput('decision', 'flag_for_human');
      core.setOutput('summary', `PR modifies ${tier1Files.length} Tier 1 sensitive path(s), requires human review`);
      return;
    }

    // Tier 2: proceed to Claude review, but add context about sensitive files
    // The review prompt will be aware of these files and can still flag_for_human
    // if the changes are risky, but low-risk changes can be auto-merged
    let sensitivePathContext = '';
    if (tier2Files.length > 0) {
      const fileList = tier2Files.map((f) => `- \`${f}\``).join('\n');
      sensitivePathContext = `\n\nNOTE: This PR touches pipeline-adjacent files that warrant extra scrutiny:\n${fileList}\nIf these changes are risky or could break the pipeline, set decision to "flag_for_human". If they are straightforward and low-risk, you may approve.`;
      core.info(`PR touches ${tier2Files.length} Tier 2 sensitive path(s), adding context for Claude review.`);
    }

    // Truncate very large diffs to avoid token limits (keep first 150k chars, ~37k tokens)
    let reviewDiff = diff;
    if (diff.length > 150000) {
      reviewDiff =
        diff.substring(0, 150000) +
        "\n\n[DIFF TRUNCATED - original was " +
        diff.length +
        " characters]";
      core.warning(
        `Diff truncated from ${diff.length} to 150000 characters`
      );
    }

    // Load codebase context for informed review
    const { systemMap, adrSummaries, reviewMemory } = loadCodebaseContext();

    // Parse spec review context from PR comments
    let specReviewContext: string | null = null;
    try {
      const { data: comments } = await octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 50,
      });
      specReviewContext = parseSpecReviewMetadata(comments);
      if (specReviewContext) {
        core.info("Found spec review context from PR comments.");
      }
    } catch (commentErr) {
      core.warning(`Could not fetch PR comments for spec context: ${commentErr}`);
    }

    // Detect staleness in review memory
    const stalenessWarning = detectStaleness(reviewMemory);
    if (stalenessWarning) {
      core.warning(stalenessWarning);
    }

    let systemPrompt = buildSystemPrompt(
      systemMap,
      adrSummaries,
      reviewMemory,
      specReviewContext,
      stalenessWarning
    );

    // Append Tier 2 sensitive path context if present
    if (sensitivePathContext) {
      systemPrompt += sensitivePathContext;
    }

    // Call Claude API for review
    const userPrompt = buildUserPrompt(
      reviewDiff,
      pr.title,
      pr.body || "",
      changedFiles,
      diffLineCount,
      maxDiffLines
    );

    core.info(`Sending to Claude API (model: ${model})...`);
    const review = await callClaudeAPI(
      apiKey,
      model,
      systemPrompt,
      userPrompt
    );
    core.info(
      `Claude decision: ${review.decision} (auto_merge_safe: ${review.auto_merge_safe})`
    );

    // Post inline comments for critical issues
    if (review.issues.length > 0) {
      const criticalIssues = review.issues.filter(
        (i) => i.severity === "critical"
      );
      for (const issue of criticalIssues) {
        try {
          await octokit.rest.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            body: `**${issue.severity.toUpperCase()}** (${issue.category || "issue"}): ${issue.message}`,
            commit_id: pr.head.sha,
            path: issue.file,
            line: issue.line,
          });
        } catch (commentErr) {
          // Line comments can fail if the line isn't in the diff hunk
          core.warning(
            `Could not post inline comment on ${issue.file}:${issue.line}: ${commentErr}`
          );
        }
      }
    }

    // Build review body
    const severityEmoji: Record<string, string> = {
      critical: "\u{1F534}",
      warning: "\u{1F7E1}",
      info: "\u{1F535}",
    };

    const lines: string[] = [
      `## TLM Review: ${review.decision.toUpperCase()}`,
      "",
      review.summary,
      "",
    ];

    if (review.issues.length > 0) {
      lines.push("### Issues");
      for (const issue of review.issues) {
        lines.push(
          `${severityEmoji[issue.severity] || "\u26AA"} \`${issue.file}:${issue.line}\` (${issue.category || "general"}) - ${issue.message}`
        );
      }
      lines.push("");
    }

    if (review.pattern_check) {
      lines.push(review.pattern_check);
      lines.push("");
    }

    if (review.pattern_matches && review.pattern_matches.length > 0) {
      lines.push("### Pattern Match Details");
      lines.push("| Pattern | Matched | Justification |");
      lines.push("|---------|---------|---------------|");
      for (const pm of review.pattern_matches) {
        lines.push(
          `| ${pm.pattern} | ${pm.matched ? "Yes" : "No"} | ${pm.matched ? pm.justification : "—"} |`
        );
      }
      lines.push("");
    }

    lines.push(
      `<details><summary>Reasoning</summary>\n\n${review.reasoning}\n\n</details>`
    );
    lines.push("");
    lines.push(
      `*Model: ${model} | Files: ${changedFiles.length} | Diff: ${diffLineCount} lines | Auto-merge: ${review.auto_merge_safe ? "yes" : "no"}*`
    );

    // Map decision to GitHub review event
    let reviewEvent: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    if (review.decision === "approve") {
      reviewEvent = "APPROVE";
    } else if (review.decision === "request_changes") {
      reviewEvent = "REQUEST_CHANGES";
    } else {
      reviewEvent = "COMMENT";
    }

    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      body: lines.join("\n"),
      event: reviewEvent,
    });

    core.info(`Posted ${reviewEvent} review on PR #${prNumber}`);

    // Post structured metadata for pipeline consumption
    const metadataComment = [
      '<!-- TLM-CODE-REVIEW-METADATA',
      `decision: ${review.decision}`,
      `auto_merge_safe: ${review.auto_merge_safe}`,
      `critical_issues: ${review.issues.filter(i => i.severity === 'critical').length}`,
      `warning_issues: ${review.issues.filter(i => i.severity === 'warning').length}`,
      `files_reviewed: ${changedFiles.length}`,
      `diff_lines: ${diffLineCount}`,
      `model: ${model}`,
      `timestamp: ${new Date().toISOString()}`,
      '-->',
      '',
      `TLM Code Review completed: **${review.decision.toUpperCase()}**`,
    ].join('\n');

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: metadataComment,
    });

    core.info('Posted structured review metadata comment.');

    // Auto-merge if approved and enabled
    if (
      review.decision === "approve" &&
      review.auto_merge_safe &&
      autoMerge
    ) {
      core.info("Enabling auto-merge for approved PR...");

      // Auto-rebase: ensure PR branch is up-to-date with base before merging
      // This prevents merge conflicts from stale branches in the squash-merge workflow
      try {
        const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${pr.head.ref}...${pr.base.ref}`,
        });

        if (comparison.ahead_by > 0) {
          core.info(`PR branch is ${comparison.ahead_by} commit(s) behind ${pr.base.ref}. Updating branch...`);
          try {
            await octokit.rest.pulls.updateBranch({
              owner,
              repo,
              pull_number: prNumber,
              expected_head_sha: pr.head.sha,
            });
            core.info("Branch updated successfully. CI will re-run and TLM will re-review via check_suite trigger.");
            core.setOutput("decision", "branch_updated");
            core.setOutput("summary", "Branch was behind base; updated and deferring to CI re-run.");
            return;
          } catch (updateErr: unknown) {
            const updateError = updateErr as { status?: number; message?: string };
            if (updateError.status === 409 || updateError.status === 422) {
              // Merge conflict — cannot auto-update
              core.warning(`Branch update failed with conflict (${updateError.status}). Posting comment for manual resolution.`);
              await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: prNumber,
                body: [
                  "## TLM Review: Merge Conflict Detected",
                  "",
                  `This PR's branch is behind \`${pr.base.ref}\` and cannot be automatically updated due to merge conflicts.`,
                  "",
                  "The PR has been approved but requires manual conflict resolution before it can be merged.",
                  "",
                  "<!-- MERGE_CONFLICT: true -->",
                ].join("\n"),
              });
              core.setOutput("decision", "merge_conflict");
              core.setOutput("summary", "PR approved but has merge conflicts requiring manual resolution.");
              return;
            }
            // Other error — fall through to normal merge attempt
            core.warning(`Branch update failed: ${updateError.message}. Attempting merge anyway.`);
          }
        }
      } catch (compareErr) {
        core.warning(`Could not check if branch is behind base: ${compareErr}. Attempting merge anyway.`);
      }

      // Direct merge: GitHub downgrades APPROVE to COMMENT when the reviewer
      // (GITHUB_TOKEN = github-actions[bot]) is the same identity as the PR author.
      // So enablePullRequestAutoMerge never fires because the approval doesn't count.
      // Instead, merge directly since we've already verified CI passed.
      try {
        await octokit.rest.pulls.merge({
          owner,
          repo,
          pull_number: prNumber,
          merge_method: "squash",
        });
        console.log(`[TLM-REVIEW] Directly merged PR #${prNumber} (squash)`);
      } catch (mergeErr: unknown) {
        const message = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);

        if (message.toLowerCase().includes('already been merged')) {
          console.log(`[TLM-REVIEW] PR #${prNumber} was already merged`);
        } else if (
          message.toLowerCase().includes('conflict') ||
          message.toLowerCase().includes('not mergeable')
        ) {
          console.log(`[TLM-REVIEW] PR #${prNumber} has merge conflicts, cannot merge`);
        } else {
          // Fall back to enablePullRequestAutoMerge if direct merge fails
          // (e.g., branch protection requires checks that haven't completed yet)
          console.warn(`[TLM-REVIEW] Direct merge failed for PR #${prNumber}: ${message}. Falling back to auto-merge.`);
          try {
            await octokit.graphql<{
              enablePullRequestAutoMerge: {
                pullRequest: {
                  autoMergeRequest: { enabledAt: string } | null;
                };
              };
            }>(
              `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
                enablePullRequestAutoMerge(input: {
                  pullRequestId: $pullRequestId,
                  mergeMethod: $mergeMethod
                }) {
                  pullRequest {
                    autoMergeRequest {
                      enabledAt
                    }
                  }
                }
              }`,
              {
                pullRequestId: pr.node_id,
                mergeMethod: 'SQUASH',
              }
            );
            console.log(`[TLM-REVIEW] Auto-merge enabled for PR #${prNumber} as fallback`);
          } catch (autoMergeErr: unknown) {
            const autoMergeMessage = autoMergeErr instanceof Error ? autoMergeErr.message : String(autoMergeErr);
            console.error(`[TLM-REVIEW] Both direct merge and auto-merge failed for PR #${prNumber}: ${autoMergeMessage}`);
            core.warning(`Failed to merge PR #${prNumber}: ${autoMergeMessage}`);
          }
        }
      }
    }

    // Set outputs
    core.setOutput("decision", review.decision);
    core.setOutput("summary", review.summary);
  } catch (error) {
    core.setFailed(`TLM review failed: ${error}`);
  }
}

run();
