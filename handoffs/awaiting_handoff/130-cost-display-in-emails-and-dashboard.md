# Handoff 130: cost-display-in-emails-and-dashboard

## Metadata
- Branch: `fix/cost-display-in-emails-and-dashboard`
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

Cost information is not surfaced anywhere visible. The decomposer calculates budgets per work item but: (1) sendDecompositionSummary() in lib/gmail.ts doesn't include cost info, and (2) the dashboard has no cost widget on project views. Work items have a `budget` field that is populated during decomposition. This data needs to be aggregated and displayed in the email template and dashboard.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] sendDecompositionSummary includes budget data in email
- [ ] Dashboard project view renders cost info
- [ ] npm run build passes

## Step 0: Branch, commit handoff, push

Create branch `fix/cost-display-in-emails-and-dashboard` from `main`. Commit this handoff file. Push.

## Step 1: Read lib/gmail.ts to find the sendDecompositionSummary() function and understand its current template

## Step 2: Update the email template to include per-item budget and total project budget sum. Add a cost breakdown section showing each work item's title and budget, followed by a total line.

## Step 3: Read the dashboard project view component (search in app/ and components/ for project-related dashboard components)

## Step 4: Add a cost summary widget to the project view showing: total budget, per-item budgets, cost by status (merged vs remaining)

## Step 5: Run npx tsc --noEmit and npm run build to verify

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: cost-display-in-emails-and-dashboard (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/cost-display-in-emails-and-dashboard",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```