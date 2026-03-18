import * as core from "@actions/core";
import * as github from "@actions/github";
import { CompilerAnalysis } from "./types";
import {
  COMPILER_SYSTEM_PROMPT,
  buildCompilerUserPrompt,
} from "./compiler-prompt";
import { buildAnalysisContext } from "./pattern-detector";
import {
  applyChanges,
  updateHistory,
  createPR,
  createEscalationIssues,
} from "./change-proposer";

async function callClaudeAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<CompilerAnalysis> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error("No text response from Claude API");
  }

  let jsonStr = textBlock.text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }
  if (!jsonStr.startsWith("{")) {
    const rawMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (rawMatch) {
      jsonStr = rawMatch[0];
    }
  }

  try {
    return JSON.parse(jsonStr) as CompilerAnalysis;
  } catch (e) {
    core.warning(`Failed to parse Claude response as JSON: ${jsonStr.substring(0, 500)}`);
    return {
      patterns: [],
      proposed_changes: [],
      escalations: [],
      summary: `Failed to parse compiler analysis response: ${e}`,
      data_quality: {
        total_assessments: 0,
        non_premature_count: 0,
        sufficient_data: false,
      },
    };
  }
}

async function run(): Promise<void> {
  try {
    const apiKey = core.getInput("anthropic-api-key", { required: true });
    const githubToken = core.getInput("github-token", { required: true });
    const model = core.getInput("model");
    const lookbackDays = parseInt(core.getInput("lookback-days"), 10);

    const context = github.context;
    const octokit = github.getOctokit(githubToken);
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

    core.info(
      `TLM Feedback Compiler starting (lookback: ${lookbackDays} days)`
    );

    // Step 1: Build analysis context
    const analysisContext = await buildAnalysisContext(
      workspace,
      octokit,
      owner,
      repo,
      lookbackDays
    );

    // Check minimum data threshold
    const nonPrematureCount = analysisContext.memory.recent_outcomes.filter(
      (o) => o.outcome.toLowerCase() !== "premature"
    ).length;

    if (nonPrematureCount < 3) {
      core.info(
        `Insufficient data: only ${nonPrematureCount} non-premature assessments (need >= 3). Skipping analysis.`
      );
      core.setOutput("patterns-detected", "0");
      core.setOutput("pr-url", "");
      core.setOutput("escalation-count", "0");

      // Still update history to record the run
      updateHistory(
        workspace,
        analysisContext.previousChanges,
        {
          patterns: [],
          proposed_changes: [],
          escalations: [],
          summary: "Skipped: insufficient data",
          data_quality: {
            total_assessments: analysisContext.memory.stats.total_assessed,
            non_premature_count: nonPrematureCount,
            sufficient_data: false,
          },
        },
        [],
        null,
        null
      );
      return;
    }

    // Step 2: Call Claude for analysis
    core.info("Calling Claude for pattern analysis...");
    const userPrompt = buildCompilerUserPrompt(analysisContext);
    const analysis = await callClaudeAPI(
      apiKey,
      model,
      COMPILER_SYSTEM_PROMPT,
      userPrompt
    );

    core.info(
      `Analysis complete: ${analysis.patterns.length} patterns, ${analysis.proposed_changes.length} changes, ${analysis.escalations.length} escalations`
    );
    core.info(`Summary: ${analysis.summary}`);

    // Step 3: Apply changes locally
    const appliedDiffs = applyChanges(workspace, analysis.proposed_changes);
    core.info(`Applied ${appliedDiffs.length} of ${analysis.proposed_changes.length} proposed changes`);

    // Step 4: Create PR if there are applied changes
    let prResult: { prNumber: number; prUrl: string } | null = null;
    if (appliedDiffs.length > 0) {
      prResult = await createPR(
        octokit,
        owner,
        repo,
        workspace,
        analysis,
        appliedDiffs
      );
    }

    // Step 5: Update history
    updateHistory(
      workspace,
      analysisContext.previousChanges,
      analysis,
      appliedDiffs,
      prResult?.prNumber ?? null,
      prResult?.prUrl ?? null
    );

    // Step 6: Create escalation issues
    let escalationCount = 0;
    if (analysis.escalations.length > 0) {
      escalationCount = await createEscalationIssues(
        octokit,
        owner,
        repo,
        analysis.escalations
      );
    }

    // Set outputs
    core.setOutput("patterns-detected", String(analysis.patterns.length));
    core.setOutput("pr-url", prResult?.prUrl ?? "");
    core.setOutput("escalation-count", String(escalationCount));

    // Post summary
    const summaryMsg = [
      `TLM Feedback Compiler: ${analysis.patterns.length} patterns detected.`,
      `Changes applied: ${appliedDiffs.length}/${analysis.proposed_changes.length}.`,
      prResult ? `PR: ${prResult.prUrl}` : "No PR created.",
      escalationCount > 0
        ? `Escalations: ${escalationCount} issues created.`
        : "",
      analysis.summary,
    ]
      .filter(Boolean)
      .join(" ");

    if (
      analysis.patterns.some((p) => p.severity === "high") ||
      escalationCount > 0
    ) {
      core.warning(summaryMsg);
    } else {
      core.notice(summaryMsg);
    }
  } catch (error) {
    core.setFailed(`TLM Feedback Compiler failed: ${error}`);
  }
}

run();
