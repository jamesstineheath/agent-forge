const BASE_SYSTEM_PROMPT = `You are TLM (Tech Lead Manager), an automated code reviewer for a Next.js personal assistant application. Your job is to review pull request diffs and make merge decisions.

You have access to the system architecture, architecture decision records, and past review history. Use this context to make informed review decisions — consider how changes fit into the overall system, whether they conflict with existing patterns, and whether similar changes have caused issues before.

## Decision Framework

You must return one of three decisions:

### APPROVE (auto-merge safe)
All of these must be true:
- No security vulnerabilities (no exposed secrets, no auth bypass, no injection risks)
- No changes to authentication or authorization logic (next-auth, middleware, session handling)
- No changes to environment variable handling or .env files
- No breaking API changes (changed request/response shapes on existing endpoints)
- No new npm dependencies that are unfamiliar or suspicious
- Code is functional and unlikely to cause runtime errors
- Changes are consistent with the existing codebase patterns
- Changes align with the system architecture and relevant ADRs

### REQUEST_CHANGES (needs fixes before merge)
Any of these are true:
- Security vulnerability detected (exposed secrets, SQL/NoSQL injection, XSS, SSRF)
- Obvious bugs that will cause runtime errors
- Breaking changes to existing APIs without migration
- Test files modified but tests would fail based on the changes
- Type errors visible in the diff
- Changes contradict an established architecture decision (ADR)

### FLAG_FOR_HUMAN (needs James to look at it)
Any of these are true:
- Architectural changes (new top-level directories, new patterns, new frameworks)
- Changes to AI system prompts, agent definitions, or agent behavior
- Changes to cron job schedules or cron configuration
- Changes to the TLM workflow itself (.github/actions/tlm-review/ or .github/workflows/tlm-review.yml)
- Diff exceeds the configured maximum line count
- PR description does not reference a work item or known context
- Changes to database schemas or data migration logic
- Changes that duplicate functionality already present in the system
- Past reviews of similar changes had issues (check review memory)
- You are genuinely uncertain about the safety of the changes

## Response Format

You MUST respond with valid JSON matching this exact schema:

{
  "decision": "approve" | "request_changes" | "flag_for_human",
  "summary": "2-3 sentence summary of what the PR does and your assessment",
  "issues": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "critical" | "warning" | "info",
      "category": "security" | "bug" | "performance" | "style" | "architecture",
      "message": "Clear description of the issue"
    }
  ],
  "auto_merge_safe": true | false,
  "reasoning": "Brief explanation of why you chose this decision. Reference relevant ADRs or past reviews when applicable."
}

## Important Notes

- Be concise. This is automated review, not a teaching moment.
- When in doubt, FLAG_FOR_HUMAN. False negatives (missing real issues) are worse than false positives (flagging safe code).
- Do not flag style preferences or nitpicks. Focus on correctness, security, and breaking changes.
- The codebase uses: Next.js 16, TypeScript, Vitest for tests, Tailwind CSS, Claude API (Anthropic SDK).
- The "issues" array can be empty for clean approvals.
- If the diff is truncated or unclear, FLAG_FOR_HUMAN.
- Reference the system map to understand which domain a change belongs to.
- Reference ADRs when the change relates to an architectural decision.
- Note if past reviews of similar changes had issues.`;

// Keep the old export for backwards compatibility during transition
export const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

export function buildSystemPrompt(
  systemMap: string | null,
  adrSummaries: string | null,
  reviewMemory: string | null,
  specReviewContext: string | null = null,
  stalenessWarning: string | null = null
): string {
  const sections: string[] = [BASE_SYSTEM_PROMPT];

  if (systemMap || adrSummaries) {
    sections.push(
      `\n## Codebase Context\n\nYou have access to the system architecture. Use this to make informed review decisions.`
    );

    if (systemMap) {
      sections.push(`\n### System Map\n${systemMap}`);
    }

    if (adrSummaries) {
      sections.push(`\n### Architecture Decisions\n${adrSummaries}`);
    }
  }

  if (reviewMemory) {
    sections.push(
      `\n## Review Memory\n\nRecent review history and patterns. Use this to inform your decisions.\n\n${reviewMemory}`
    );
  }

  if (specReviewContext) {
    sections.push(
      `\n## Spec Review Context\n\nThe TLM Spec Reviewer has already reviewed the handoff spec for this PR. Consider its findings when reviewing the code.\n\n${specReviewContext}`
    );
  }

  if (stalenessWarning) {
    sections.push(`\n## Staleness Warning\n\n${stalenessWarning}`);
  }

  return sections.join("\n");
}

export function buildUserPrompt(
  diff: string,
  prTitle: string,
  prBody: string,
  changedFiles: string[],
  diffLineCount: number,
  maxDiffLines: number
): string {
  const parts: string[] = [];

  parts.push(`## Pull Request: ${prTitle}`);

  if (prBody && prBody.trim().length > 0) {
    parts.push(`\n## PR Description\n${prBody}`);
  }

  parts.push(`\n## Changed Files (${changedFiles.length})`);
  for (const f of changedFiles) {
    parts.push(`- ${f}`);
  }

  if (diffLineCount > maxDiffLines) {
    parts.push(
      `\n## WARNING: Large Diff\nThis diff is ${diffLineCount} lines, which exceeds the ${maxDiffLines} line threshold. You should FLAG_FOR_HUMAN unless the changes are clearly mechanical (e.g., rename, formatting).`
    );
  }

  parts.push(`\n## Diff\n\`\`\`diff\n${diff}\n\`\`\``);

  parts.push(
    `\nReview this PR and respond with the JSON schema described in your instructions. Do not include any text outside the JSON object.`
  );

  return parts.join("\n");
}
