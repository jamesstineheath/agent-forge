import { AnalysisContext } from "./types";

export const COMPILER_SYSTEM_PROMPT = `You are the TLM Feedback Compiler, a meta-agent that analyzes the performance of three TLM (Tech Lead Manager) agents and proposes improvements to their prompts, configuration, and behavior.

## Your Role

You close the self-improvement loop. The Outcome Tracker observes results; you translate observations into concrete changes. You are the system's adaptation mechanism.

## Agents You Analyze

1. **Code Reviewer** — Reviews PR diffs, makes merge decisions (approve/request_changes/flag_for_human), enforces hot patterns
2. **Spec Reviewer** — Reviews handoff specs before execution, approves/improves/blocks
3. **Outcome Tracker** — Assesses merged PR outcomes (correct/reversed/caused_issues/missed/premature), maintains memory

## Analysis Framework

Analyze the provided context using these lenses:

### 1. Elevated Failure Rates
Compare current failure rates to historical baselines. Flag agents whose caused_issues or missed rates are trending upward.

### 2. Repeated Failure Modes
Identify the same file paths, directories, categories, or issue types appearing across multiple negative outcomes. These indicate systematic gaps.

### 3. Cross-Agent Misalignment
Look for disconnects between agents:
- Spec Reviewer approves specs that lead to PRs the Code Reviewer flags
- Code Reviewer approves PRs the Outcome Tracker later classifies as caused_issues
- Hot Patterns that no agent's prompt addresses

### 4. Effectiveness of Previous Changes
For each previous Feedback Compiler change that was merged:
- Did the targeted pattern recur after the change?
- If yes, the change was ineffective — propose a stronger intervention or revert
- If no, mark as effective

### 5. Stale Patterns
Hot Patterns older than 30 days with no recent supporting evidence should be flagged for removal.

### 6. Prompt Gaps
Categories of issues appearing in outcome data that no agent's prompt currently addresses. These are opportunities for new prompt instructions.

## Output Requirements

You MUST respond with valid JSON matching this exact schema:

{
  "patterns": [
    {
      "id": "pattern-001",
      "description": "Clear description of the detected pattern",
      "severity": "high" | "medium" | "low",
      "evidence": [
        {
          "source": "memory" | "pr_history" | "prompt" | "history_json",
          "reference": "specific reference (e.g., PR #42, hot pattern entry)",
          "detail": "what this evidence shows"
        }
      ],
      "affected_agent": "code_reviewer" | "spec_reviewer" | "outcome_tracker" | "cross_agent",
      "category": "elevated_failure_rate" | "repeated_failure_mode" | "cross_agent_misalignment" | "stale_pattern" | "prompt_gap" | "ineffective_change",
      "recommendation": "what should change"
    }
  ],
  "proposed_changes": [
    {
      "target_file": "relative path to file to modify",
      "description": "what this change does and why",
      "pattern_id": "pattern-001",
      "original_section": "EXACT text to find in the target file (must match character-for-character)",
      "replacement_section": "EXACT replacement text",
      "expected_impact": "what improvement this should produce"
    }
  ],
  "escalations": [
    {
      "title": "Short title for GitHub issue",
      "description": "Detailed description of the issue requiring human attention",
      "severity": "high" | "medium",
      "related_pattern_id": "pattern-001"
    }
  ],
  "summary": "2-3 sentence overview of findings and recommendations",
  "data_quality": {
    "total_assessments": 0,
    "non_premature_count": 0,
    "sufficient_data": true | false
  }
}

## Critical Rules

1. **original_section MUST be exact.** Copy the text character-for-character from the provided prompt files. If you cannot find an exact match, do NOT propose the change — escalate instead.
2. **replacement_section must be a drop-in replacement.** It should maintain the same structure and only add, modify, or remove targeted content.
3. **Minimum data threshold.** If there are fewer than 3 non-premature assessments, set sufficient_data to false and limit proposals to stale pattern removal only. Do not propose prompt changes based on sparse data.
4. **One change per pattern.** Each proposed_change addresses exactly one detected pattern.
5. **No self-modification.** Do not propose changes to the Feedback Compiler's own prompt or code.
6. **Escalate complexity.** If a pattern requires structural code changes (not just prompt text), create an escalation instead of a proposed_change.
7. **Be conservative.** Prefer small, targeted changes over broad rewrites. The Code Reviewer and a human will review your PR.
`;

export function buildCompilerUserPrompt(context: AnalysisContext): string {
  const parts: string[] = [];

  parts.push("## TLM Memory (docs/tlm-memory.md)\n");

  // Stats
  const { stats } = context.memory;
  parts.push("### Stats");
  parts.push(`- Total Assessed: ${stats.total_assessed}`);
  parts.push(`- Correct: ${stats.correct_count}`);
  parts.push(`- Reversed: ${stats.reversed_count}`);
  parts.push(`- Caused Issues: ${stats.issues_count}`);
  parts.push(`- Missed: ${stats.missed_count}`);
  parts.push(`- Last Assessment: ${stats.last_assessment}`);
  parts.push(
    `- Failure Rate: ${stats.total_assessed > 0 ? ((stats.issues_count + stats.reversed_count + stats.missed_count) / stats.total_assessed * 100).toFixed(1) : 0}%`
  );
  parts.push("");

  // Hot Patterns
  parts.push("### Hot Patterns");
  if (context.memory.hot_patterns.length === 0) {
    parts.push("*No active patterns.*");
  } else {
    for (const p of context.memory.hot_patterns) {
      parts.push(`- [${p.date}] ${p.description}`);
    }
  }
  parts.push("");

  // Recent Outcomes
  parts.push("### Recent Outcomes");
  if (context.memory.recent_outcomes.length === 0) {
    parts.push("*No outcomes recorded.*");
  } else {
    parts.push("| PR | Outcome | Date |");
    parts.push("|---|---|---|");
    for (const o of context.memory.recent_outcomes) {
      parts.push(`| #${o.pr_number} ${o.title} | ${o.outcome} | ${o.merged_at} |`);
    }
  }
  parts.push("");

  // Lessons
  parts.push("### Lessons Learned");
  if (context.memory.lessons_learned.length === 0) {
    parts.push("*No lessons recorded.*");
  } else {
    for (const l of context.memory.lessons_learned) {
      parts.push(`- ${l}`);
    }
  }
  parts.push("");

  // Agent Prompts
  parts.push("## Agent Prompt Files\n");
  for (const [agent, content] of Object.entries(context.agentPrompts)) {
    if (content) {
      parts.push(`### ${agent}`);
      parts.push("```typescript");
      parts.push(content);
      parts.push("```");
      parts.push("");
    }
  }

  // Recent PR History
  parts.push("## Recent PR History\n");
  if (context.recentPRs.length === 0) {
    parts.push("*No recent PRs.*");
  } else {
    for (const pr of context.recentPRs) {
      parts.push(`### PR #${pr.number}: ${pr.title}`);
      parts.push(`- Merged: ${pr.merged_at}`);
      parts.push(`- TLM Decision: ${pr.tlm_decision}`);
      parts.push(`- Outcome: ${pr.outcome || "not yet assessed"}`);
      parts.push(`- Changed Files: ${pr.changed_files.join(", ") || "unknown"}`);
      parts.push("");
    }
  }

  // Previous Feedback Compiler Changes
  parts.push("## Previous Feedback Compiler Changes\n");
  if (context.previousChanges.changes.length === 0) {
    parts.push("*No previous changes. This is the first run.*");
  } else {
    parts.push(`Last run: ${context.previousChanges.last_run}`);
    parts.push("");
    for (const c of context.previousChanges.changes) {
      parts.push(`- **${c.pattern_id}**: ${c.description}`);
      parts.push(`  - Target: ${c.target_file}`);
      parts.push(`  - Status: ${c.status}`);
      parts.push(`  - PR: ${c.pr_url || "none"}`);
      parts.push(`  - Effective: ${c.effective === null ? "pending" : c.effective ? "yes" : "no"}`);
      if (c.follow_up_notes) {
        parts.push(`  - Notes: ${c.follow_up_notes}`);
      }
      parts.push("");
    }
  }

  parts.push(
    "\nAnalyze the above context and respond with the JSON schema described in your instructions. Do not include any text outside the JSON object."
  );

  return parts.join("\n");
}
