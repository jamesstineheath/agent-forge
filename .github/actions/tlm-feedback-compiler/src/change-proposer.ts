import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import {
  CompilerAnalysis,
  CompilerHistory,
  ChangeRecord,
  FileDiff,
  ProposedChange,
  EscalationItem,
  ProposedWorkItem,
} from "./types";

/**
 * Applies proposed find-and-replace changes to files.
 * Returns the list of file diffs that were successfully applied.
 */
export function applyChanges(
  workspace: string,
  changes: ProposedChange[]
): FileDiff[] {
  const diffs: FileDiff[] = [];

  for (const change of changes) {
    const filePath = path.join(workspace, change.target_file);

    let originalContent: string;
    try {
      originalContent = fs.readFileSync(filePath, "utf-8");
    } catch {
      core.warning(
        `Cannot apply change for ${change.pattern_id}: file not found at ${change.target_file}`
      );
      continue;
    }

    if (!originalContent.includes(change.original_section)) {
      core.warning(
        `Cannot apply change for ${change.pattern_id}: original_section not found in ${change.target_file}. Skipping.`
      );
      continue;
    }

    const newContent = originalContent.replace(
      change.original_section,
      change.replacement_section
    );

    if (newContent === originalContent) {
      core.warning(
        `Change for ${change.pattern_id} produced no difference in ${change.target_file}. Skipping.`
      );
      continue;
    }

    fs.writeFileSync(filePath, newContent, "utf-8");
    core.info(
      `Applied change for ${change.pattern_id} to ${change.target_file}`
    );

    diffs.push({
      file_path: change.target_file,
      original_content: originalContent,
      new_content: newContent,
    });
  }

  return diffs;
}

/**
 * Updates the feedback compiler history file with new change records.
 */
export function updateHistory(
  workspace: string,
  history: CompilerHistory,
  analysis: CompilerAnalysis,
  appliedDiffs: FileDiff[],
  prNumber: number | null,
  prUrl: string | null
): CompilerHistory {
  const now = new Date().toISOString().split("T")[0];
  const appliedFiles = new Set(appliedDiffs.map((d) => d.file_path));

  for (const change of analysis.proposed_changes) {
    const wasApplied = appliedFiles.has(change.target_file);
    const record: ChangeRecord = {
      date: now,
      pattern_id: change.pattern_id,
      description: change.description,
      target_file: change.target_file,
      pr_number: wasApplied ? prNumber : null,
      pr_url: wasApplied ? prUrl : null,
      status: wasApplied ? "proposed" : "rejected",
      effective: null,
      follow_up_notes: wasApplied
        ? ""
        : "Change could not be applied (original_section not found)",
    };
    history.changes.push(record);
  }

  history.last_run = now;

  // Keep only the last 50 change records
  if (history.changes.length > 50) {
    history.changes = history.changes.slice(-50);
  }

  const historyPath = path.join(
    workspace,
    "docs",
    "feedback-compiler-history.json"
  );
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
  core.info(`Updated feedback compiler history at ${historyPath}`);

  return history;
}

/**
 * Creates a branch, commits applied changes, and opens a PR.
 * Returns the PR URL if successful, null otherwise.
 */
export async function createPR(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  workspace: string,
  analysis: CompilerAnalysis,
  appliedDiffs: FileDiff[]
): Promise<{ prNumber: number; prUrl: string } | null> {
  if (appliedDiffs.length === 0) {
    core.info("No changes were applied. Skipping PR creation.");
    return null;
  }

  const now = new Date().toISOString().split("T")[0];
  const branchName = `feedback-compiler/${now}`;

  // Check if branch already exists
  try {
    await octokit.rest.repos.getBranch({ owner, repo, branch: branchName });
    core.warning(`Branch ${branchName} already exists. Skipping PR creation.`);
    return null;
  } catch {
    // Branch doesn't exist, good
  }

  // Get the default branch SHA
  const { data: defaultBranch } = await octokit.rest.repos.get({
    owner,
    repo,
  });
  const baseBranch = defaultBranch.default_branch;

  const { data: baseRef } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`,
  });

  // Create the branch
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseRef.object.sha,
  });
  core.info(`Created branch ${branchName}`);

  // Commit each changed file
  // First, get the current tree
  const { data: baseCommit } = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: baseRef.object.sha,
  });

  const treeItems: Array<{
    path: string;
    mode: "100644";
    type: "blob";
    content: string;
  }> = [];

  for (const diff of appliedDiffs) {
    treeItems.push({
      path: diff.file_path,
      mode: "100644",
      type: "blob",
      content: diff.new_content,
    });
  }

  // Also include the updated history file
  const historyPath = "docs/feedback-compiler-history.json";
  try {
    const historyContent = fs.readFileSync(
      path.join(workspace, historyPath),
      "utf-8"
    );
    treeItems.push({
      path: historyPath,
      mode: "100644",
      type: "blob",
      content: historyContent,
    });
  } catch {
    core.warning("Could not read history file for commit");
  }

  const { data: newTree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems,
  });

  // Build commit message
  const changedFilesList = appliedDiffs
    .map((d) => `- ${d.file_path}`)
    .join("\n");
  const patternsList = analysis.patterns
    .map((p) => `- ${p.id}: ${p.description} (${p.severity})`)
    .join("\n");

  const commitMessage = `chore(tlm): feedback compiler prompt improvements

Patterns detected:
${patternsList}

Files changed:
${changedFilesList}`;

  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [baseRef.object.sha],
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha,
  });

  // Build PR body
  const evidenceSections = analysis.patterns
    .map((p) => {
      const evidenceList = p.evidence
        .map((e) => `  - **${e.source}** (${e.reference}): ${e.detail}`)
        .join("\n");
      return `### ${p.id}: ${p.description}\n- **Severity:** ${p.severity}\n- **Agent:** ${p.affected_agent}\n- **Category:** ${p.category}\n- **Evidence:**\n${evidenceList}\n- **Recommendation:** ${p.recommendation}`;
    })
    .join("\n\n");

  const changesSections = analysis.proposed_changes
    .map(
      (c) =>
        `- **${c.target_file}** (${c.pattern_id}): ${c.description}\n  - Expected impact: ${c.expected_impact}`
    )
    .join("\n");

  const prBody = `## Feedback Compiler: Automated Prompt Improvements

${analysis.summary}

## Data Quality
- Total assessments: ${analysis.data_quality.total_assessments}
- Non-premature: ${analysis.data_quality.non_premature_count}
- Sufficient data: ${analysis.data_quality.sufficient_data ? "Yes" : "No"}

## Detected Patterns

${evidenceSections}

## Proposed Changes

${changesSections}

${analysis.escalations.length > 0 ? `## Escalations\n${analysis.escalations.map((e) => `- **${e.title}** (${e.severity}): ${e.description}`).join("\n")}` : ""}

---
*Generated by TLM Feedback Compiler on ${now}*`;

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `chore(tlm): feedback compiler improvements (${now})`,
    head: branchName,
    base: baseBranch,
    body: prBody,
  });

  core.info(`Created PR #${pr.number}: ${pr.html_url}`);

  return { prNumber: pr.number, prUrl: pr.html_url };
}

/**
 * Creates GitHub issues for escalation items.
 */
export async function createEscalationIssues(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  escalations: EscalationItem[]
): Promise<number> {
  let created = 0;

  for (const escalation of escalations) {
    try {
      const { data: issue } = await octokit.rest.issues.create({
        owner,
        repo,
        title: `[Feedback Compiler] ${escalation.title}`,
        body: `## Severity: ${escalation.severity}\n\n${escalation.description}\n\n**Related Pattern:** ${escalation.related_pattern_id}\n\n---\n*Created by TLM Feedback Compiler*`,
        labels: ["tlm-feedback", escalation.severity],
      });
      core.info(
        `Created escalation issue #${issue.number}: ${escalation.title}`
      );
      created++;
    } catch (error) {
      core.warning(
        `Failed to create escalation issue "${escalation.title}": ${error}`
      );
    }
  }

  return created;
}

/**
 * Files work items via the Agent Forge API for systemic issues
 * that require code changes (not just prompt tweaks).
 */
export async function fileWorkItems(
  workItems: ProposedWorkItem[]
): Promise<number> {
  const apiUrl = process.env.AGENT_FORGE_URL || process.env.INPUT_AGENT_FORGE_URL;
  const apiSecret = process.env.AGENT_FORGE_API_SECRET || process.env.INPUT_AGENT_FORGE_API_SECRET;

  if (!apiUrl || !apiSecret) {
    core.warning("AGENT_FORGE_URL or AGENT_FORGE_API_SECRET not set — cannot file work items");
    return 0;
  }

  let filed = 0;

  for (const item of workItems) {
    try {
      const fullTargetRepo = item.target_repo.includes("/")
        ? item.target_repo
        : `jamesstineheath/${item.target_repo}`;

      const response = await fetch(`${apiUrl}/api/work-items`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiSecret}`,
        },
        body: JSON.stringify({
          title: item.title,
          description: `${item.description}\n\n---\n*Filed by TLM Feedback Compiler (pattern: ${item.related_pattern_id})*\n*Expected impact: ${item.expected_impact}*`,
          targetRepo: fullTargetRepo,
          type: item.type,
          complexity: item.complexity,
          priority: item.priority,
          source: {
            type: "pm-agent" as const,
            sourceId: `feedback-compiler:${item.related_pattern_id}`,
          },
        }),
      });

      if (response.ok) {
        const result = (await response.json()) as { id?: string };
        core.info(`Filed work item "${item.title}" (${result.id || "ok"})`);
        filed++;
      } else {
        const errorText = await response.text();
        core.warning(`Failed to file work item "${item.title}": ${response.status} ${errorText}`);
      }
    } catch (error) {
      core.warning(`Failed to file work item "${item.title}": ${error}`);
    }
  }

  return filed;
}
