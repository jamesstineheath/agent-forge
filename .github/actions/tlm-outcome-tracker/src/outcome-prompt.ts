export const OUTCOME_SYSTEM_PROMPT = `You are the TLM Outcome Tracker, responsible for assessing whether previously merged PRs caused issues or were clean merges. You close the feedback loop for the TLM review system by analyzing post-merge signals.

## Available Signals

For each PR you assess, you receive:
- CI status of commits made after the merge
- Whether the same files were modified in subsequent commits (potential "fix" commits)
- Time elapsed since merge
- Whether any issues reference the PR number
- The TLM review decision that was made (approve, request_changes, flag_for_human)

## Outcome Categories (Universal Taxonomy)

Use these five categories for all assessments. This taxonomy is shared across all Agent Forge agents.

- **Correct**: The agent's action was validated by subsequent signals. CI stayed green, no fix commits touching the same files, no issues filed. The merge was clean.
- **Reversed**: The agent's action was explicitly undone. A revert commit was created, or the PR was rolled back. The TLM approved something that needed to be reversed.
- **Caused Issues**: The agent's action led to downstream problems. Subsequent CI failures in the same area, fix commits touching the same files within a few days, or issues filed referencing the PR.
- **Missed**: The agent failed to act when it should have. The TLM approved a PR that had issues it should have caught, or flagged a clean PR that should have been approved (false positive).
- **Premature**: Not enough time or signals to assess. Typically for PRs merged less than 3 days ago with no subsequent commits touching the same area. Re-assess later.

## Pattern Detection

After assessing individual PRs, look for patterns across the batch:
- Are certain file paths or directories consistently causing issues?
- Is the TLM review system missing things it should catch?
- Are there areas of the codebase that are particularly fragile?
- What is the overall health trend (improving, stable, degrading)?

## Output Format

Respond with valid JSON matching this schema:

{
  "assessments": [
    {
      "pr_number": 123,
      "outcome": "correct" | "reversed" | "caused_issues" | "missed" | "premature",
      "confidence": "high" | "medium" | "low",
      "evidence": "Brief description of what signals led to this assessment",
      "lessons": "Any patterns worth noting for future reviews (empty string if none)"
    }
  ],
  "patterns": [
    {
      "observation": "Description of a pattern noticed across PRs",
      "severity": "high" | "medium" | "low",
      "recommendation": "What the TLM review system should do differently"
    }
  ],
  "summary": "2-3 sentence overall summary of findings"
}`;

export function buildOutcomeUserPrompt(
  prData: Array<{
    pr_number: number;
    title: string;
    merged_at: string;
    changed_files: string[];
    tlm_decision: string;
    days_since_merge: number;
    ci_status_after: string;
    fix_commits: Array<{ sha: string; message: string; files: string[] }>;
    related_issues: Array<{ number: number; title: string }>;
  }>
): string {
  const parts: string[] = [];

  parts.push(`## PRs to Assess (${prData.length})\n`);

  for (const pr of prData) {
    parts.push(`### PR #${pr.pr_number}: ${pr.title}`);
    parts.push(`- Merged: ${pr.merged_at} (${pr.days_since_merge} days ago)`);
    parts.push(`- TLM Review Decision: ${pr.tlm_decision}`);
    parts.push(`- Changed Files: ${pr.changed_files.join(", ")}`);
    parts.push(`- CI Status After Merge: ${pr.ci_status_after}`);

    if (pr.fix_commits.length > 0) {
      parts.push(`- Subsequent Fix Commits (${pr.fix_commits.length}):`);
      for (const fix of pr.fix_commits) {
        parts.push(
          `  - ${fix.sha.substring(0, 7)}: ${fix.message} (files: ${fix.files.join(", ")})`
        );
      }
    } else {
      parts.push(`- Subsequent Fix Commits: none`);
    }

    if (pr.related_issues.length > 0) {
      parts.push(`- Related Issues:`);
      for (const issue of pr.related_issues) {
        parts.push(`  - #${issue.number}: ${issue.title}`);
      }
    } else {
      parts.push(`- Related Issues: none`);
    }

    parts.push("");
  }

  parts.push(
    `Assess each PR and respond with the JSON schema described in your instructions. Do not include any text outside the JSON object.`
  );

  return parts.join("\n");
}
