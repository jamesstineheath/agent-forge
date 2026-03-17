# Handoff 134: wire-project-escalation-email

## Metadata
- Branch: `fix/wire-project-escalation-email`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-17
- Executor: Claude Code (GitHub Actions)

## Context

PRJ-37 (Project-Level Escalation Email Support) is partially complete. The sendProjectEscalationEmail function was already merged into lib/gmail.ts (work item 94c84001, PR #104). But the wiring in lib/escalation.ts was cancelled. The escalation.ts code has an `else if (projectId)` branch for project-level escalations that currently only logs to console without sending an email. This branch needs to call sendProjectEscalationEmail.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Project-level escalations call sendProjectEscalationEmail
- [ ] Email sends with project ID and reason in subject/body
- [ ] Existing work-item escalation emails are unaffected
- [ ] Gmail credentials missing degrades gracefully
- [ ] npm run build passes

## Step 0: Branch, commit handoff, push

Create branch `fix/wire-project-escalation-email` from `main`. Commit this handoff file. Push.

## Step 1: Read lib/escalation.ts to find the project-level escalation branch (the `else if (projectId)` code path that currently skips email)

## Step 2: Read lib/gmail.ts to find the sendProjectEscalationEmail function signature and required parameters

## Step 3: In the project-level branch of escalation.ts, import and call sendProjectEscalationEmail with the project metadata (projectId, reason, context). Construct the required parameters from available data in the escalation context.

## Step 4: Ensure Gmail credentials missing gracefully degrades (wrap in try/catch, log warning on failure)

## Step 5: Run npx tsc --noEmit and npm run build to verify

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: wire-project-escalation-email (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/wire-project-escalation-email",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```