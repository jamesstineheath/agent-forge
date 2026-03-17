# Handoff 132: fix-pipeline-merge-count

## Metadata
- Branch: `fix/pipeline-merge-count`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $2
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-17
- Executor: Claude Code (GitHub Actions)

## Context

The pipeline summary table in the dashboard says nothing was merged, but 85 PRs were merged on 2026-03-16. The merged count is not being computed or rendered correctly. Work items with status "merged" exist in the Blob store (verified via list_work_items MCP tool). The pipeline table likely has a query or rendering bug.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Pipeline table shows correct merged count
- [ ] Merged count matches work items store data
- [ ] npm run build passes

## Step 0: Branch, commit handoff, push

Create branch `fix/pipeline-merge-count` from `main`. Commit this handoff file. Push.

## Step 1: Read the dashboard pipeline/summary components (search for 'pipeline', 'merged', 'summary' in app/ and components/)

## Step 2: Identify how merged items are counted — check if it queries the work items API or uses a different data source

## Step 3: Fix the query to correctly count work items with status === 'merged', grouping by date and repo

## Step 4: Ensure the UI renders the counts correctly, including today's merged count prominently

## Step 5: Run npx tsc --noEmit and npm run build to verify

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-pipeline-merge-count (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/pipeline-merge-count",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```