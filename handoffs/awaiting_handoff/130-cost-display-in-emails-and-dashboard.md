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

Cost information is not surfaced anywhere visible. The decomposer calculates budgets per work item but: (1) `sendDecompositionSummary()` in `lib/gmail.ts` doesn't include cost info, and (2) the dashboard has no cost widget on project views. Work items have a `budget` field that is populated during decomposition. This data needs to be aggregated and displayed in the email template and dashboard.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] `lib/gmail.ts` exists and contains `sendDecompositionSummary`
- [ ] `lib/types.ts` contains a `budget` field on the WorkItem type (or equivalent)
- [ ] `npm run build` passes on current `main` before any changes

## Step 0: Branch, commit handoff, push

Create branch `fix/cost-display-in-emails-and-dashboard` from `main`. Commit this handoff file. Push.

## Step 1: Read relevant source files

- Read `lib/gmail.ts` — find `sendDecompositionSummary()` and understand its current email template and what data it receives.
- Read `lib/types.ts` — confirm the `WorkItem` type has a `budget` field and note its type (number, string, optional?).
- Search for dashboard project view components: check `app/` and `components/` directories for project-related pages (likely `app/projects/` or `app/dashboard/`). Also check `lib/hooks.ts` for any project data fetching hooks.

## Step 2: Update email template in sendDecompositionSummary

In `lib/gmail.ts`, update the `sendDecompositionSummary()` email template to include:
- A "Cost Breakdown" section after the existing work items list
- Each work item's title and budget formatted as `$X.XX`
- A **Total Budget** line summing all item budgets
- Handle edge cases: if `budget` is undefined/null on a work item, display "—" or "unset" instead of $0

## Step 3: Add cost summary to dashboard project view

Find the project detail/view component identified in Step 1. Add a cost summary section showing:
- **Total Budget**: sum of all work item budgets for the project
- **Per-item breakdown**: table or list with work item title, budget, and current status
- **Spent vs Remaining**: sum of budgets for items in terminal states (merged/failed/cancelled) vs items still in progress (ready/queued/generating/executing/reviewing)
- Handle missing budget values gracefully (skip or show "—")

If no suitable project view component exists, check if there's a project detail page or a work items list grouped by project. Add the cost info wherever project-level data is already rendered.

## Step 4: Build verification
