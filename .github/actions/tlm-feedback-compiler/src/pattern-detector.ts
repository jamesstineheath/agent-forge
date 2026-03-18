import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";
import {
  TLMMemory,
  MemoryEntry,
  AnalysisContext,
  CompilerHistory,
  PRSummary,
} from "./types";

/**
 * Loads TLM memory from docs/tlm-memory.md.
 * parseMemoryFile logic copied from Outcome Tracker (not imported).
 */
export function loadMemory(workspace: string): TLMMemory {
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

export function parseMemoryFile(content: string): TLMMemory {
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

  // Parse recent outcomes from universal format table
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
    // Legacy fallback
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

  // Parse stats
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
    const freqMatch = content.match(/Assessment Frequency:\s*(.+)/);
    if (freqMatch) {
      memory.stats.assessment_frequency = freqMatch[1].trim();
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

  // Parse hot patterns
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

/**
 * Loads the system prompts for all three TLM agents.
 */
export function loadAgentPrompts(workspace: string): Record<string, string> {
  const prompts: Record<string, string> = {};

  const promptFiles: Record<string, string> = {
    code_reviewer: ".github/actions/tlm-review/src/review-prompt.ts",
    spec_reviewer: ".github/actions/tlm-spec-review/src/spec-review-prompt.ts",
    outcome_tracker: ".github/actions/tlm-outcome-tracker/src/outcome-prompt.ts",
  };

  for (const [agent, relativePath] of Object.entries(promptFiles)) {
    const fullPath = path.join(workspace, relativePath);
    try {
      prompts[agent] = fs.readFileSync(fullPath, "utf-8");
    } catch {
      core.warning(`Could not read prompt file for ${agent}: ${relativePath}`);
      prompts[agent] = "";
    }
  }

  return prompts;
}

/**
 * Fetches recent merged PR history from GitHub API for pattern analysis.
 */
export async function fetchRecentPRHistory(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  lookbackDays: number,
  memory: TLMMemory
): Promise<PRSummary[]> {
  const since = new Date();
  since.setDate(since.getDate() - lookbackDays);

  const { data: pulls } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  const mergedPRs = pulls.filter(
    (pr) => pr.merged_at && new Date(pr.merged_at) >= since
  );

  // Build a map of outcomes from memory
  const outcomeMap = new Map<number, string>();
  for (const entry of memory.recent_outcomes) {
    outcomeMap.set(entry.pr_number, entry.outcome);
  }

  const summaries: PRSummary[] = [];

  for (const pr of mergedPRs) {
    // Get changed files
    let changedFiles: string[] = [];
    try {
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      changedFiles = files.map((f) => f.filename);
    } catch {
      core.warning(`Could not fetch files for PR #${pr.number}`);
    }

    // Determine TLM review decision
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
      // OK
    }

    summaries.push({
      number: pr.number,
      title: pr.title,
      merged_at: pr.merged_at!,
      outcome: outcomeMap.get(pr.number) || null,
      changed_files: changedFiles,
      tlm_decision: tlmDecision,
    });
  }

  return summaries;
}

/**
 * Loads previous Feedback Compiler change records.
 */
export function loadPreviousChanges(workspace: string): CompilerHistory {
  const historyPath = path.join(
    workspace,
    "docs",
    "feedback-compiler-history.json"
  );
  try {
    const content = fs.readFileSync(historyPath, "utf-8");
    return JSON.parse(content) as CompilerHistory;
  } catch {
    core.info("No existing feedback compiler history, starting fresh.");
    return { changes: [], last_run: "" };
  }
}

/**
 * Builds the full analysis context for the compiler prompt.
 */
export async function buildAnalysisContext(
  workspace: string,
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  lookbackDays: number
): Promise<AnalysisContext> {
  const memory = loadMemory(workspace);
  const agentPrompts = loadAgentPrompts(workspace);
  const recentPRs = await fetchRecentPRHistory(
    octokit,
    owner,
    repo,
    lookbackDays,
    memory
  );
  const previousChanges = loadPreviousChanges(workspace);

  core.info(
    `Analysis context: ${memory.recent_outcomes.length} outcomes, ${recentPRs.length} recent PRs, ${previousChanges.changes.length} previous changes`
  );

  return { memory, agentPrompts, recentPRs, previousChanges };
}
