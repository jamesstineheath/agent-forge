import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import { OUTCOME_SYSTEM_PROMPT, buildOutcomeUserPrompt } from "./outcome-prompt";

interface OutcomeAssessment {
  pr_number: number;
  outcome: "correct" | "reversed" | "caused_issues" | "missed" | "premature";
  confidence: "high" | "medium" | "low";
  evidence: string;
  lessons: string;
}

interface OutcomePattern {
  observation: string;
  severity: "high" | "medium" | "low";
  recommendation: string;
}

interface OutcomeResult {
  assessments: OutcomeAssessment[];
  patterns: OutcomePattern[];
  summary: string;
}

interface PRData {
  pr_number: number;
  title: string;
  merged_at: string;
  changed_files: string[];
  tlm_decision: string;
  days_since_merge: number;
  ci_status_after: string;
  fix_commits: Array<{ sha: string; message: string; files: string[] }>;
  related_issues: Array<{ number: number; title: string }>;
}

interface MemoryEntry {
  pr_number: number;
  title: string;
  merged_at: string;
  outcome: string;
  assessed_at: string;
}

interface TLMMemory {
  hot_patterns: Array<{ date: string; description: string }>;
  recent_outcomes: MemoryEntry[];
  lessons_learned: string[];
  stats: {
    total_assessed: number;
    correct_count: number;
    reversed_count: number;
    issues_count: number;
    missed_count: number;
    last_assessment: string;
    assessment_frequency: string;
  };
}

async function callClaudeAPI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<OutcomeResult> {
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
    return JSON.parse(jsonStr) as OutcomeResult;
  } catch (e) {
    core.warning(`Failed to parse Claude response as JSON: ${jsonStr}`);
    return {
      assessments: [],
      patterns: [],
      summary: `Failed to parse outcome assessment response: ${e}`,
    };
  }
}

function loadMemory(workspace: string): TLMMemory {
  const memoryPath = path.join(workspace, "docs", "tlm-memory.md");
  try {
    const content = fs.readFileSync(memoryPath, "utf-8");
    return parseMemoryFile(content);
  } catch {
    core.info("No existing TLM memory file, starting fresh.");
    return {
      hot_patterns: [],
      recent_outcomes: [],
      lessons_learned: [],
      stats: {
        total_assessed: 0,
        correct_count: 0,
        reversed_count: 0,
        issues_count: 0,
        missed_count: 0,
        last_assessment: "",
        assessment_frequency: "daily (9am UTC)",
      },
    };
  }
}

function parseMemoryFile(content: string): TLMMemory {
  const memory: TLMMemory = {
    hot_patterns: [],
    recent_outcomes: [],
    lessons_learned: [],
    stats: {
      total_assessed: 0,
      correct_count: 0,
      reversed_count: 0,
      issues_count: 0,
      missed_count: 0,
      last_assessment: "",
      assessment_frequency: "daily (9am UTC)",
    },
  };

  // Parse recent outcomes from universal format table (Date | Action | Entity | Outcome | Notes)
  const outcomeTableMatch = content.match(
    /## Recent Outcomes[^\n]*\n[^\n]*\n\|[^\n]+\n\|[^\n]+\n((?:\|[^\n]+\n)*)/
  );
  if (outcomeTableMatch) {
    const rows = outcomeTableMatch[1].trim().split("\n");
    for (const row of rows) {
      const cols = row
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cols.length >= 4) {
        // Universal format: Date | Action | Entity | Outcome | Notes
        const entityMatch = cols[2].match(/PR #(\d+)/);
        memory.recent_outcomes.push({
          pr_number: entityMatch ? parseInt(entityMatch[1], 10) : 0,
          title: cols[2],
          merged_at: cols[0],
          outcome: cols[3],
          assessed_at: cols[0],
        });
      }
    }
  } else {
    // Legacy fallback: Recent Reviews table (PR | Title | Merged | Outcome | Assessed)
    const legacyMatch = content.match(
      /## Recent Reviews\n\n\|[^\n]+\n\|[^\n]+\n((?:\|[^\n]+\n)*)/
    );
    if (legacyMatch) {
      const rows = legacyMatch[1].trim().split("\n");
      for (const row of rows) {
        const cols = row
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        if (cols.length >= 4) {
          memory.recent_outcomes.push({
            pr_number: parseInt(cols[0].replace("#", ""), 10),
            title: cols[1],
            merged_at: cols[2],
            outcome: cols[3],
            assessed_at: cols[4] || "",
          });
        }
      }
    }
  }

  // Parse stats — universal format
  const universalStatsMatch = content.match(
    /Total Assessed:\s*(\d+)[\s\S]*?Correct:\s*(\d+)[\s\S]*?Reversed:\s*(\d+)[\s\S]*?Caused Issues:\s*(\d+)[\s\S]*?Missed:\s*(\d+)[\s\S]*?Last Assessment:\s*(.+)/
  );
  if (universalStatsMatch) {
    memory.stats = {
      total_assessed: parseInt(universalStatsMatch[1], 10),
      correct_count: parseInt(universalStatsMatch[2], 10),
      reversed_count: parseInt(universalStatsMatch[3], 10),
      issues_count: parseInt(universalStatsMatch[4], 10),
      missed_count: parseInt(universalStatsMatch[5], 10),
      last_assessment: universalStatsMatch[6].trim(),
      assessment_frequency: "daily (9am UTC)",
    };
    // Parse assessment frequency if present
    const freqMatch = content.match(/Assessment Frequency:\s*(.+)/);
    if (freqMatch) {
      memory.stats.assessment_frequency = freqMatch[1].trim();
    }
  } else {
    // Legacy fallback
    const legacyStatsMatch = content.match(
      /Total Assessed:\s*(\d+)[\s\S]*?Clean:\s*(\d+)[\s\S]*?Caused Issues:\s*(\d+)[\s\S]*?Last Run:\s*(.+)/
    );
    if (legacyStatsMatch) {
      memory.stats = {
        total_assessed: parseInt(legacyStatsMatch[1], 10),
        correct_count: parseInt(legacyStatsMatch[2], 10),
        reversed_count: 0,
        issues_count: parseInt(legacyStatsMatch[3], 10),
        missed_count: 0,
        last_assessment: legacyStatsMatch[4].trim(),
        assessment_frequency: "daily (9am UTC)",
      };
    }
  }

  // Parse lessons
  const lessonsMatch = content.match(
    /## Lessons Learned[^\n]*\n\n((?:- .+\n)*)/
  );
  if (lessonsMatch) {
    memory.lessons_learned = lessonsMatch[1]
      .trim()
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .filter(Boolean);
  }

  // Parse hot patterns — universal format: - [YYYY-MM-DD] Description
  const patternsSection = content.match(
    /## Hot Patterns[^\n]*\n<!-- [^>]+-->\n<!-- [^>]+-->\n\n([\s\S]*?)(?=\n## )/
  );
  if (patternsSection) {
    const patternLines = patternsSection[1].trim().split("\n");
    for (const line of patternLines) {
      const patternMatch = line.match(/^- \[(\d{4}-\d{2}-\d{2})\]\s+(.+)/);
      if (patternMatch) {
        memory.hot_patterns.push({
          date: patternMatch[1],
          description: patternMatch[2].trim(),
        });
      }
    }
  }

  return memory;
}

function renderMemoryFile(memory: TLMMemory): string {
  const lines: string[] = [];

  lines.push("# Agent Memory: TLM Code Reviewer");
  lines.push("");
  lines.push(
    "*Maintained by the TLM Outcome Tracker. Read by the Code Reviewer and Spec Reviewer.*"
  );
  lines.push("");

  // Hot Patterns (universal format)
  lines.push("## Hot Patterns (max 10)");
  lines.push(
    "<!-- Maintained by Outcome Tracker. Items here should influence every review. -->"
  );
  lines.push("<!-- Format: - [YYYY-MM-DD] Pattern description. -->");
  lines.push("");
  // Prune patterns older than 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const activePatterns = memory.hot_patterns
    .filter((p) => new Date(p.date) >= thirtyDaysAgo)
    .slice(-10);
  if (activePatterns.length === 0) {
    lines.push(
      "*No active patterns. The Outcome Tracker will populate this as it identifies trends.*"
    );
  } else {
    for (const pattern of activePatterns) {
      lines.push(`- [${pattern.date}] ${pattern.description}`);
    }
  }
  lines.push("");

  // Recent Outcomes (universal format)
  lines.push("## Recent Outcomes (last 20)");
  lines.push(
    "<!-- Each entry: Date | Action | Entity | Outcome (Correct/Reversed/Caused Issues/Missed) | Notes -->"
  );
  lines.push("| Date | Action | Entity | Outcome | Notes |");
  lines.push("|---|---|---|---|---|");
  const recentOutcomes = memory.recent_outcomes.slice(-20);
  for (const entry of recentOutcomes) {
    lines.push(
      `| ${entry.merged_at} | ${entry.outcome === "Correct" ? "approve" : entry.outcome.toLowerCase()} | PR #${entry.pr_number} ${entry.title} | ${entry.outcome} | ${entry.assessed_at !== entry.merged_at ? `Assessed ${entry.assessed_at}` : ""} |`
    );
  }
  lines.push("");

  // Lessons Learned
  lines.push("## Lessons Learned (last 15)");
  lines.push("");
  if (memory.lessons_learned.length === 0) {
    lines.push("*No lessons recorded yet.*");
  } else {
    const recentLessons = memory.lessons_learned.slice(-15);
    for (const lesson of recentLessons) {
      lines.push(`- ${lesson}`);
    }
  }
  lines.push("");

  // Stats (universal format)
  lines.push("## Stats");
  lines.push("");
  lines.push(`- Total Assessed: ${memory.stats.total_assessed}`);
  lines.push(`- Correct: ${memory.stats.correct_count}`);
  lines.push(`- Reversed: ${memory.stats.reversed_count}`);
  lines.push(`- Caused Issues: ${memory.stats.issues_count}`);
  lines.push(`- Missed: ${memory.stats.missed_count}`);
  lines.push(`- Last Assessment: ${memory.stats.last_assessment}`);
  lines.push(`- Assessment Frequency: ${memory.stats.assessment_frequency}`);
  lines.push("");

  return lines.join("\n");
}

function getAlreadyAssessedPRs(memory: TLMMemory): Set<number> {
  const assessed = new Set<number>();
  for (const entry of memory.recent_outcomes) {
    // Skip premature assessments — they need re-evaluation
    if (entry.outcome.toLowerCase() === "premature") continue;
    assessed.add(entry.pr_number);
  }
  return assessed;
}

async function fetchMergedPRs(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  lookbackDays: number,
  alreadyAssessed: Set<number>
): Promise<PRData[]> {
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);

  // Fetch recently merged PRs
  const { data: pulls } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  const mergedPRs = pulls.filter(
    (pr) =>
      pr.merged_at &&
      new Date(pr.merged_at) >= since &&
      !alreadyAssessed.has(pr.number)
  );

  core.info(
    `Found ${mergedPRs.length} merged PRs in the last ${lookbackDays} days (${alreadyAssessed.size} already assessed)`
  );

  const prDataList: PRData[] = [];

  for (const pr of mergedPRs) {
    const mergedAt = new Date(pr.merged_at!);
    const daysSinceMerge = Math.floor(
      (Date.now() - mergedAt.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Get changed files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    });
    const changedFiles = files.map((f) => f.filename);

    // Check CI status on the merge commit
    const mergeCommitSha = pr.merge_commit_sha;
    let ciStatus = "unknown";
    if (mergeCommitSha) {
      try {
        const { data: checkRuns } =
          await octokit.rest.checks.listForRef({
            owner,
            repo,
            ref: mergeCommitSha,
          });
        const failures = checkRuns.check_runs.filter(
          (cr) =>
            cr.conclusion === "failure" || cr.conclusion === "timed_out"
        );
        ciStatus =
          failures.length > 0
            ? `failed (${failures.map((f) => f.name).join(", ")})`
            : "passing";
      } catch {
        ciStatus = "unknown";
      }
    }

    // Find subsequent commits that touch the same files (potential fixes)
    const fixCommits: PRData["fix_commits"] = [];
    try {
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        since: pr.merged_at!,
        per_page: 30,
      });

      for (const commit of commits) {
        // Skip the merge commit itself
        if (commit.sha === mergeCommitSha) continue;

        // Check if commit message suggests a fix
        const msg = commit.commit.message.toLowerCase();
        const isFix =
          msg.includes("fix") ||
          msg.includes("revert") ||
          msg.includes("hotfix") ||
          msg.includes("patch");

        if (!isFix) continue;

        // Check if it touches any of the same files
        try {
          const { data: commitDetail } = await octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: commit.sha,
          });
          const commitFiles = (commitDetail.files || []).map(
            (f) => f.filename
          );
          const overlap = commitFiles.filter((f) =>
            changedFiles.includes(f)
          );
          if (overlap.length > 0) {
            fixCommits.push({
              sha: commit.sha,
              message: commit.commit.message.split("\n")[0],
              files: overlap,
            });
          }
        } catch {
          // Skip commits we can't inspect
        }
      }
    } catch {
      core.warning(
        `Could not fetch subsequent commits for PR #${pr.number}`
      );
    }

    // Check for issues referencing this PR
    const relatedIssues: PRData["related_issues"] = [];
    try {
      const { data: issues } = await octokit.rest.search.issuesAndPullRequests(
        {
          q: `repo:${owner}/${repo} is:issue ${pr.number}`,
          per_page: 10,
        }
      );
      for (const issue of issues.items) {
        if (issue.pull_request) continue; // Skip PRs in search results
        relatedIssues.push({
          number: issue.number,
          title: issue.title,
        });
      }
    } catch {
      core.warning(
        `Could not search issues for PR #${pr.number}`
      );
    }

    // Determine TLM review decision from PR comments
    let tlmDecision = "unknown";
    try {
      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: pr.number,
      });
      const tlmReview = reviews.find((r) =>
        r.body?.includes("TLM Review:")
      );
      if (tlmReview) {
        if (tlmReview.body?.includes("APPROVE")) tlmDecision = "approve";
        else if (tlmReview.body?.includes("REQUEST_CHANGES"))
          tlmDecision = "request_changes";
        else if (tlmReview.body?.includes("FLAG FOR HUMAN"))
          tlmDecision = "flag_for_human";
      }
    } catch {
      // OK, we'll just mark as unknown
    }

    prDataList.push({
      pr_number: pr.number,
      title: pr.title,
      merged_at: pr.merged_at!,
      changed_files: changedFiles,
      tlm_decision: tlmDecision,
      days_since_merge: daysSinceMerge,
      ci_status_after: ciStatus,
      fix_commits: fixCommits,
      related_issues: relatedIssues,
    });
  }

  return prDataList;
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

    core.info(`TLM Outcome Tracker starting (lookback: ${lookbackDays} days)`);

    // Load existing memory
    const memory = loadMemory(workspace);
    const alreadyAssessed = getAlreadyAssessedPRs(memory);

    // Fetch merged PRs that need assessment
    const prData = await fetchMergedPRs(
      octokit,
      owner,
      repo,
      lookbackDays,
      alreadyAssessed
    );

    if (prData.length === 0) {
      core.info("No new PRs to assess. Exiting.");
      core.setOutput("assessed-count", "0");
      core.setOutput("updated-memory", "false");
      return;
    }

    core.info(`Assessing ${prData.length} PRs...`);

    // Call Claude for assessment
    const userPrompt = buildOutcomeUserPrompt(prData);
    const result = await callClaudeAPI(
      apiKey,
      model,
      OUTCOME_SYSTEM_PROMPT,
      userPrompt
    );

    core.info(`Assessment complete: ${result.summary}`);

    // Update memory with results
    const now = new Date().toISOString().split("T")[0];

    // Map legacy outcome names to universal taxonomy
    function mapOutcome(
      raw: string
    ): "correct" | "reversed" | "caused_issues" | "missed" | "premature" {
      const lower = raw.toLowerCase();
      if (lower === "clean" || lower === "correct") return "correct";
      if (lower === "reversed") return "reversed";
      if (lower === "caused_issues") return "caused_issues";
      if (lower === "missed") return "missed";
      if (
        lower === "insufficient_data" ||
        lower === "premature"
      )
        return "premature";
      return "premature"; // default for unknown
    }

    for (const assessment of result.assessments) {
      const prInfo = prData.find((p) => p.pr_number === assessment.pr_number);
      if (!prInfo) continue;

      const mappedOutcome = mapOutcome(assessment.outcome);

      memory.recent_outcomes.push({
        pr_number: assessment.pr_number,
        title: prInfo.title,
        merged_at: prInfo.merged_at.split("T")[0],
        outcome: mappedOutcome,
        assessed_at: now,
      });

      // Skip premature from stats
      if (mappedOutcome !== "premature") {
        memory.stats.total_assessed++;
        if (mappedOutcome === "correct") memory.stats.correct_count++;
        if (mappedOutcome === "reversed") memory.stats.reversed_count++;
        if (mappedOutcome === "caused_issues") memory.stats.issues_count++;
        if (mappedOutcome === "missed") memory.stats.missed_count++;
      }

      if (assessment.lessons && assessment.lessons.trim()) {
        memory.lessons_learned.push(
          `PR #${assessment.pr_number}: ${assessment.lessons}`
        );
      }
    }

    // Update patterns with dated entries
    if (result.patterns.length > 0) {
      const newPatterns = result.patterns.map((p) => ({
        date: now,
        description: `${p.observation} (${p.severity}): ${p.recommendation}`,
      }));
      memory.hot_patterns = [
        ...memory.hot_patterns,
        ...newPatterns,
      ].slice(-10);
    }

    memory.stats.last_assessment = now;

    // Write updated memory file
    const memoryContent = renderMemoryFile(memory);
    const memoryPath = path.join(workspace, "docs", "tlm-memory.md");

    // Ensure docs directory exists
    const docsDir = path.join(workspace, "docs");
    if (!fs.existsSync(docsDir)) {
      fs.mkdirSync(docsDir, { recursive: true });
    }

    fs.writeFileSync(memoryPath, memoryContent, "utf-8");
    core.info(`Updated TLM memory file at ${memoryPath}`);

    // Post summary annotation
    const issueCount = result.assessments.filter(
      (a) => mapOutcome(a.outcome) === "caused_issues"
    ).length;
    const correctCount = result.assessments.filter(
      (a) => mapOutcome(a.outcome) === "correct"
    ).length;
    const prematureCount = result.assessments.filter(
      (a) => mapOutcome(a.outcome) === "premature"
    ).length;
    const reversedCount = result.assessments.filter(
      (a) => mapOutcome(a.outcome) === "reversed"
    ).length;

    const annotationMsg = [
      `TLM Outcome Tracker: Assessed ${result.assessments.length} PRs.`,
      `Correct: ${correctCount}, Issues: ${issueCount}, Reversed: ${reversedCount}, Premature: ${prematureCount}.`,
      result.summary,
    ].join(" ");

    if (issueCount > 0) {
      core.warning(annotationMsg);
    } else {
      core.notice(annotationMsg);
    }

    // Set outputs
    core.setOutput("assessed-count", String(result.assessments.length));
    core.setOutput("updated-memory", "true");
  } catch (error) {
    core.setFailed(`TLM Outcome Tracker failed: ${error}`);
  }
}

run();
