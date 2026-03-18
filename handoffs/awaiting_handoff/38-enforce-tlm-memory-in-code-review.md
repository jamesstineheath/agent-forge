# Handoff 38: enforce-tlm-memory-in-code-review

## Metadata
- Branch: `feat/enforce-tlm-memory-in-code-review`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $5
- Risk Level: medium
- Complexity: moderate
- Depends On: None
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

The TLM Code Reviewer reads `docs/tlm-memory.md` and passes it to Claude in the system prompt, but the review prompt only mentions memory once as a tie-breaker (item 9 of 10 in the FLAG_FOR_HUMAN list: "Past reviews of similar changes had issues (check review memory)"). This means Claude has the data but isn't required to actively check it.

Evidence this isn't working: The hot patterns correctly identify workflow changes (100% failure rate), env var renames (deployment coordination risk), and lib/atc.ts churn (high-risk). Yet PRs matching ALL of these patterns were approved without extra scrutiny on March 15, leading to 9 "caused issues" PRs.

The fix: Update `review-prompt.ts` to add an explicit "Hot Pattern Check" section that requires Claude to actively match the PR against documented hot patterns and explain why the PR is safe despite matching (or FLAG_FOR_HUMAN if it can't justify safety).

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm review-prompt.ts exists and contains the BASE_SYSTEM_PROMPT
- [ ] Confirm index.ts has the JSON response parsing logic
- [ ] Confirm the current prompt does NOT have explicit hot pattern enforcement

## Step 0: Branch, commit handoff, push

Create branch `feat/enforce-tlm-memory-in-code-review` from `main`. Commit this handoff file. Push.

## Step 1: Read the current code

Read `.github/actions/tlm-review/review-prompt.ts` and `.github/actions/tlm-review/index.ts` to understand the current prompt structure.

## Step 2: Add Hot Pattern Enforcement to the review prompt

In `review-prompt.ts`, add a new mandatory section to the BASE_SYSTEM_PROMPT after the existing approval criteria. Add this between the APPROVE and REQUEST_CHANGES sections:

```
## Hot Pattern Enforcement (MANDATORY)

Before making any decision, you MUST check the Review Memory's Hot Patterns section.
For EACH hot pattern:
1. Determine if this PR matches the pattern (e.g., modifies files mentioned, matches the category)
2. If it matches, you MUST either:
   a. Explain specifically why this PR is safe despite matching the pattern, OR
   b. Set decision to "flag_for_human" with a clear explanation of which pattern matched

You MUST include a "pattern_matches" array in your JSON response listing each hot pattern checked and whether it matched.

PRs that match HIGH severity hot patterns should ONLY be approved if the code explicitly addresses the risk documented in the pattern (e.g., a workflow change that includes recursion guards when the pattern flags workflow recursion risk).
```

## Step 3: Update the JSON response format

Update the JSON response format in the prompt to include the new `pattern_matches` field:
```json
{
  "decision": "approve | request_changes | flag_for_human",
  "summary": "...",
  "pattern_matches": [
    {
      "pattern": "lib/atc.ts high-churn hotspot",
      "matched": true,
      "justification": "PR adds a new function but does not restructure existing interfaces. Change is additive only."
    }
  ],
  "issues": [...],
  "auto_merge_safe": true | false,
  "reasoning": "..."
}
```

## Step 4: Update response parsing and PR comments

In `index.ts`, update the response parsing to handle the new `pattern_matches` field. When posting the review comment on the PR, include a "Pattern Check" section that lists which patterns matched and the justification. This makes the enforcement visible and auditable.

Example PR comment section:
```markdown
### Pattern Check
| Pattern | Matched | Justification |
|---------|---------|---------------|
| lib/atc.ts high-churn hotspot | Yes | Change is additive only, no interface restructuring |
| GitHub Actions workflow risk | No | — |
```

## Step 5: Build and verify

Build the project (`npm run build` or `npx tsc`) to verify TypeScript compiles. Fix any type errors.

## Step 6: Final verification

Verify the action.yml still references the correct entry point. Run `cat .github/actions/tlm-review/action.yml` to confirm.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: enforce-tlm-memory-in-code-review (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/enforce-tlm-memory-in-code-review",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```