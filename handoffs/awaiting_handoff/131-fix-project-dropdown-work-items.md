# Handoff 131: fix-project-dropdown-work-items

## Metadata
- Branch: `fix/project-dropdown-work-items`
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

The dashboard has a project dropdown/selector, but selecting a project doesn't show its associated work items. Work items have a source.sourceId field (e.g., "PRJ-9") that links them to Notion projects. The dropdown exists but either doesn't filter or doesn't query work items by project.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Selecting a project shows its work items
- [ ] Work items are grouped by status
- [ ] npm run build passes

## Step 0: Branch, commit handoff, push

Create branch `fix/project-dropdown-work-items` from `main`. Commit this handoff file. Push.

## Step 1: Read the dashboard components to find the project dropdown (search for 'project' in app/ and components/ directories)

## Step 2: Read lib/work-items.ts to understand how work items are queried and whether projectId filtering exists

## Step 3: Wire the project dropdown onChange to filter work items by source.sourceId matching the selected project's PRJ-ID

## Step 4: Display filtered work items grouped by status (merged, executing, ready, failed, cancelled) with counts

## Step 5: Run npx tsc --noEmit and npm run build to verify

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-project-dropdown-work-items (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/project-dropdown-work-items",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```