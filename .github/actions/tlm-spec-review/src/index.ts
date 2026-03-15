import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { buildSystemPrompt, buildUserPrompt } from "./spec-review-prompt";

type SpecDecision = "APPROVE" | "IMPROVE" | "BLOCK";

interface SpecReviewResult {
  decision: SpecDecision;
  summary: string;
  changes?: string;
  improvedContent?: string;
}

async function callClaudeAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16384,
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

  return textBlock.text.trim();
}

function parseSpecReviewResponse(response: string): SpecReviewResult {
  // Find the decision keyword at the start of a line
  const lines = response.split("\n");
  let decision: SpecDecision | null = null;

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();
    if (trimmed === "APPROVE" || trimmed === "IMPROVE" || trimmed === "BLOCK") {
      decision = trimmed as SpecDecision;
      break;
    }
  }

  if (!decision) {
    core.warning(
      `Could not parse decision from response. Defaulting to BLOCK.\nResponse start: ${response.substring(0, 200)}`
    );
    return {
      decision: "BLOCK",
      summary:
        "Spec Reviewer could not determine a clear decision. Flagging for human review.",
    };
  }

  if (decision === "APPROVE") {
    // Everything after the APPROVE line is the summary
    const afterDecision = response
      .substring(response.indexOf("APPROVE") + 7)
      .trim();
    return {
      decision: "APPROVE",
      summary: afterDecision || "Spec is ready for execution.",
    };
  }

  if (decision === "IMPROVE") {
    // Extract changes summary and improved file content
    const changesMatch = response.match(
      /## Changes\s*\n([\s\S]*?)(?=## Improved File|$)/i
    );
    const changes = changesMatch ? changesMatch[1].trim() : "";

    // Extract the improved file from the code block
    const codeBlockMatch = response.match(
      /## Improved File\s*\n\s*```(?:markdown)?\s*\n([\s\S]*?)\n```/i
    );

    if (!codeBlockMatch) {
      core.warning(
        "IMPROVE decision but no improved file content found in code block. Treating as BLOCK."
      );
      return {
        decision: "BLOCK",
        summary:
          "Spec Reviewer wanted to improve the file but failed to produce the improved content. Human review needed.",
        changes,
      };
    }

    return {
      decision: "IMPROVE",
      summary: changes || "Spec improved.",
      changes,
      improvedContent: codeBlockMatch[1],
    };
  }

  // BLOCK
  const afterDecision = response
    .substring(response.indexOf("BLOCK") + 5)
    .trim();
  return {
    decision: "BLOCK",
    summary: afterDecision || "Fundamental issues require human clarification.",
  };
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

function getChangedHandoffFiles(): string[] {
  try {
    // Compare HEAD with previous commit to find changed handoff files
    const output = execSync(
      'git diff --name-only --diff-filter=AM HEAD~1 HEAD -- "handoffs/"',
      { encoding: "utf-8" }
    ).trim();

    if (!output) return [];
    return output.split("\n").filter((f) => f.endsWith(".md"));
  } catch (err) {
    core.warning(`Failed to get changed handoff files via git diff: ${err}`);
    return [];
  }
}

async function findPRForBranch(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branch: string
): Promise<number | null> {
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
    });
    return prs.length > 0 ? prs[0].number : null;
  } catch {
    return null;
  }
}

interface HandoffMetadata {
  risk: string | null;
  budget: number | null;
}

function parseHandoffMetadata(content: string): HandoffMetadata {
  // Parse risk level: "Risk: low" or "Risk: low" in metadata line
  const riskMatch = content.match(/Risk:\s*(low|medium|high)/i);
  const risk = riskMatch ? riskMatch[1].toLowerCase() : null;

  // Parse budget: "Max Budget: $3" or "Budget: $5"
  const budgetMatch = content.match(/(?:Max\s+)?Budget:\s*\$([\d.]+)/i);
  const budget = budgetMatch ? parseFloat(budgetMatch[1]) : null;

  return { risk, budget };
}

function isLowRiskFastPath(metadata: HandoffMetadata): boolean {
  return metadata.risk === "low" && metadata.budget !== null && metadata.budget <= 3;
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("anthropic-api-key", { required: true });
    const githubToken = core.getInput("github-token", { required: true });
    const model = core.getInput("model");

    const context = github.context;
    const octokit = github.getOctokit(githubToken);
    const owner = context.repo.owner;
    const repo = context.repo.repo;

    // Determine which handoff files changed
    let handoffFiles: string[] = [];

    // Check for workflow_dispatch with specific file
    if (context.eventName === "workflow_dispatch") {
      const handoffFile = context.payload.inputs?.handoff_file;
      if (handoffFile) {
        handoffFiles = [handoffFile];
      } else {
        core.info(
          "workflow_dispatch without specific file. Scanning for recent handoff changes."
        );
        handoffFiles = getChangedHandoffFiles();
      }
    } else {
      // Push event — find changed handoff files
      handoffFiles = getChangedHandoffFiles();
    }

    if (handoffFiles.length === 0) {
      core.info("No handoff files changed in this push. Nothing to review.");
      return;
    }

    core.info(
      `Found ${handoffFiles.length} handoff file(s) to review: ${handoffFiles.join(", ")}`
    );

    // Load codebase context
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const systemMap = readFileOrNull(
      path.join(workspace, "docs", "SYSTEM_MAP.md")
    );
    const adrSummaries = loadADRSummaries(path.join(workspace, "docs", "adr"));
    const reviewMemory = readFileOrNull(
      path.join(workspace, "docs", "tlm-memory.md")
    );
    const activeWorkItems = readFileOrNull(
      path.join(workspace, "docs", "active-work-items.md")
    );

    const loaded: string[] = [];
    if (systemMap) loaded.push("system map");
    if (adrSummaries) loaded.push("ADR summaries");
    if (reviewMemory) loaded.push("review memory");
    if (activeWorkItems) loaded.push("active work items");
    core.info(
      loaded.length > 0
        ? `Loaded context: ${loaded.join(", ")}`
        : "No context files found, using base prompt only."
    );

    const systemPrompt = buildSystemPrompt(
      systemMap,
      adrSummaries,
      reviewMemory,
      activeWorkItems
    );

    // Find the PR for this branch (if one exists)
    const branch = context.ref.replace("refs/heads/", "");
    const prNumber = await findPRForBranch(octokit, owner, repo, branch);

    // Review each handoff file
    for (const handoffPath of handoffFiles) {
      core.info(`Reviewing: ${handoffPath}`);

      const fullPath = path.join(workspace, handoffPath);
      const handoffContent = readFileOrNull(fullPath);

      if (!handoffContent) {
        core.warning(`Could not read handoff file: ${handoffPath}`);
        continue;
      }

      // Fast-path: skip full spec review for low-risk, low-budget handoffs
      const metadata = parseHandoffMetadata(handoffContent);
      if (isLowRiskFastPath(metadata)) {
        core.info(`Fast-path: skipping spec review for low-risk handoff (risk=${metadata.risk}, budget=$${metadata.budget}): ${handoffPath}`);

        // Post a brief comment on the PR if one exists
        if (prNumber) {
          try {
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: prNumber,
              body: [
                `## TLM Spec Review: FAST-PATH ⚡`,
                "",
                `**${handoffPath}**`,
                "",
                `Skipped full review (risk: ${metadata.risk}, budget: $${metadata.budget}). Proceeding directly to execution.`,
                "",
                "<!--",
                "TLM-SPEC-REVIEW",
                "decision: FAST_PATH",
                "improved: false",
                `changes_summary: Skipped - low risk ($${metadata.budget} budget)`,
                "flagged_risks: none",
                "-->",
              ].join("\n"),
            });
          } catch (commentErr) {
            core.warning(`Failed to post fast-path comment: ${commentErr}`);
          }
        }
        continue; // Skip to next handoff file
      }

      const userPrompt = buildUserPrompt(handoffContent, handoffPath);

      core.info(`Sending to Claude API (model: ${model})...`);
      const rawResponse = await callClaudeAPI(
        apiKey,
        model,
        systemPrompt,
        userPrompt
      );

      const result = parseSpecReviewResponse(rawResponse);
      core.info(`Spec review decision: ${result.decision}`);

      // Handle each decision type
      if (result.decision === "IMPROVE" && result.improvedContent) {
        // Write the improved file
        fs.writeFileSync(fullPath, result.improvedContent, "utf-8");
        core.info(`Wrote improved handoff file: ${handoffPath}`);

        // Commit and push the improved file
        try {
          const filename = path.basename(handoffPath);
          execSync(`git config user.name "TLM Spec Reviewer"`, {
            cwd: workspace,
          });
          execSync(
            `git config user.email "tlm-spec-reviewer[bot]@users.noreply.github.com"`,
            { cwd: workspace }
          );
          execSync(`git add "${handoffPath}"`, { cwd: workspace });
          execSync(
            `git commit -m "chore(tlm): spec reviewer improvements to ${filename}"`,
            { cwd: workspace }
          );
          execSync(`git push`, { cwd: workspace });
          core.info(`Committed and pushed improvements to ${handoffPath}`);
        } catch (gitErr) {
          core.warning(`Failed to commit/push improvements: ${gitErr}`);
        }
      }

      // Post PR comment if a PR exists
      if (prNumber) {
        const commentLines: string[] = [];

        if (result.decision === "APPROVE") {
          commentLines.push(
            `## TLM Spec Review: APPROVE \u2705`,
            "",
            `**${handoffPath}**`,
            "",
            result.summary
          );
        } else if (result.decision === "IMPROVE") {
          commentLines.push(
            `## TLM Spec Review: IMPROVE \u270F\uFE0F`,
            "",
            `**${handoffPath}**`,
            "",
            "The spec has been improved and the updated version committed to this branch.",
            ""
          );
          if (result.changes) {
            commentLines.push("### What Changed", "", result.changes);
          }
        } else {
          // BLOCK
          commentLines.push(
            `## TLM Spec Review: BLOCK \u{1F6D1}`,
            "",
            `**${handoffPath}**`,
            "",
            "This spec has fundamental issues that need human clarification before proceeding.",
            "",
            result.summary
          );
        }

        // Add machine-readable metadata (multi-line structured block)
        const improved = result.decision === "IMPROVE" ? "true" : "false";
        const changesSummary = (result.changes || result.summary || "").replace(/\n/g, " ").substring(0, 200);
        commentLines.push(
          "",
          `<!--`,
          `TLM-SPEC-REVIEW`,
          `decision: ${result.decision}`,
          `improved: ${improved}`,
          `changes_summary: ${changesSummary}`,
          `flagged_risks: ${result.decision === "BLOCK" ? result.summary.replace(/\n/g, " ").substring(0, 200) : "none"}`,
          `-->`
        );

        try {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: commentLines.join("\n"),
          });
          core.info(`Posted spec review comment on PR #${prNumber}`);
        } catch (commentErr) {
          core.warning(`Failed to post PR comment: ${commentErr}`);
        }

        // For BLOCK decisions, also request changes on the PR
        if (result.decision === "BLOCK") {
          try {
            await octokit.rest.pulls.createReview({
              owner,
              repo,
              pull_number: prNumber,
              body: `Spec review blocked: ${result.summary.substring(0, 200)}`,
              event: "REQUEST_CHANGES",
            });
            core.info(`Requested changes on PR #${prNumber}`);
          } catch (reviewErr) {
            core.warning(`Failed to request changes: ${reviewErr}`);
          }
        }
      } else {
        core.info(
          `No open PR found for branch ${branch}. Review results logged but not posted.`
        );
      }
    }
  } catch (error) {
    core.setFailed(`TLM spec review failed: ${error}`);
  }
}

run();
