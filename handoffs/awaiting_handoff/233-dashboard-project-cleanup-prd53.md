# Handoff 233: dashboard-project-cleanup-prd53

## Metadata
- Branch: `fix/dashboard-project-cleanup`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $10
- Risk Level: medium
- Complexity: complex
- Depends On: None
- Date: 2026-03-21
- Executor: Claude Code (GitHub Actions)

## Context

PRD-53 (Dashboard UI Alignment) is partially complete. AC-1 through AC-4 and AC-8 are merged. Three criteria remain: AC-5, AC-6, and AC-7. PR #410 (Neon Work Item Store Migration) already updated the dashboard home page and /projects page to read from the PRD database instead of the old Projects DB. That foundation is in place but needs verification and completion.

The old Projects DB (Notion collection://79757fe1) is obsolete. The PRDs & Acceptance Criteria database (Notion data source ID: 04216ec5-2206-4753-9063-d058f636cb46) is the single source of truth. All project-level data in the dashboard should derive from it.

Work items are now stored in Neon Postgres (migrated in PR #410). The old Blob-based work item store race condition that caused AC-5 and AC-6 work items to disappear is resolved.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] tsc --noEmit passes before any changes
- [ ] PR #410 dashboard changes are rendering correctly
- [ ] Can identify all PRJ-* references in codebase via grep
- [ ] Neon database connection is working for work item queries
- [ ] PRD database (04216ec5-2206-4753-9063-d058f636cb46) is accessible via Notion API

## Step 0: Branch, commit handoff, push

Create branch `fix/dashboard-project-cleanup` from `main`. Commit this handoff file. Push.

## Step 1: **Verification pass** — Before changing anything, verify PR #410's dashboard changes are working: tsc --noEmit passes, dashboard home page renders project data from PRD database (not old Projects DB), /projects page renders from PRD database, identify any remaining imports or references to the old project store's PRJ-* ID format.

## Step 2: **AC-5: Project status derived from PRD database** — The dashboard project status derivation logic currently marks projects Obsolete when all work items reach terminal states (merged + cancelled), even when the PRD is still active. Fix: (1) The project status displayed on dashboard pages should use the Notion PRD database status as authoritative. (2) When the local project store says Obsolete but the PRD says Partially Executed, Approved, Executing, or In Review, the PRD status wins. (3) The projects API endpoint should cross-reference PRD status, or the dashboard components should read PRD status directly (PR #410 may have already wired this — verify first). (4) If the projects API still references the old project store for status, update it to use the Neon work item store + PRD database status.

## Step 3: **AC-6: Silent failure indicators surfaced in dashboard** — The backend emits silent failure detection events (decomposer empty output, spec review stall, empty context guard, escalation dedup). These currently render as generic entries in the activity feed or escalation cards. Fix: (1) Each silent failure type should have a distinct, recognizable label in the dashboard UI. (2) Look at the event bus events emitted by the silent failure detection system (shipped in PR #385, stabilization batch). (3) Surface them as distinct alert types in the escalation cards or activity feed on the dashboard home page. (4) Minimum: decomposer_empty_output, spec_review_stall, empty_context_guard, escalation_dedup each get a named label and icon/color treatment.

## Step 4: **AC-7: Migrate from PRJ-XX to PRD auto-increment IDs** — The legacy PRJ-XX project identifier format is replaced throughout the codebase with the Notion PRD auto-increment ID format (PRD-53, PRD-51, etc.). Locations to update (search for PRJ- and sourceId.*PRJ): work item source.sourceId field (verify all new work items use PRD-* format), escalation projectId field, decomposition dedup guards, get_project_status MCP tool input format (should accept PRD-XX), Project Manager agent queries, dashboard project card labels and URLs, any remaining references in API routes/types/utility functions. Historical work items in Neon that still have PRJ-XX sourceIds need a migration — write a one-time migration script (standalone .ts file in scripts/) that queries all work items with PRJ-* sourceIds, maps them to their corresponding PRD numbers using available data (the AF Project ID field in the PRD database, work item history, etc.), updates to PRD-XX format, and logs what changed. After this ships, PRJ-XX should not appear anywhere in the codebase except possibly in archived comments or commit history.

## Step 5: **Verification** — Confirm: (1) tsc --noEmit passes, (2) next build succeeds, (3) Dashboard home page shows project cards with PRD-XX labels (not PRJ-XX), (4) /projects page lists projects from PRD database with correct statuses, (5) Project detail pages load correctly with PRD-XX format IDs, (6) get_project_status MCP tool works with PRD-XX input, (7) Silent failure events render with distinct labels on dashboard, (8) No remaining references to PRJ- in source code (excluding migration script logs and comments).

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: dashboard-project-cleanup-prd53 (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/dashboard-project-cleanup",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```

## Post-merge Note

Bring STATUS.md back to the planning session. PM will: (1) Mark PRD-53 Complete in Notion, (2) Update AF Session Memory to remove the project/dashboard cleanup section, (3) Mark old Projects DB (Notion collection://79757fe1) as archived.