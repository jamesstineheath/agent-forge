# Handoff 68: fix-bug-tracking-mcp-tools

## Metadata
- Branch: `fix/bug-tracking-mcp-tools-notion-schema`
- Priority: critical
- Model: sonnet
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-21
- Executor: Claude Code (GitHub Actions)

## Context

The bug tracking MCP tools (file_bug, list_bugs, update_bug_status) in lib/mcp/tools/bugs.ts are broken due to three bugs:

1. WRONG DATABASE ID: The code uses `023f3621-2885-468d-a8cf-2e0bd1458bb3` which is the Notion data source ID, not the actual database UUID. The real database ID is `7f21af359f69490b9370b03c649ee2ed` (confirmed via Notion MCP fetch of the data source).

2. WRONG TITLE PROPERTY NAME: The code uses `Title` but the actual database property is `Bug Title` (confirmed from the data source schema).

3. WRONG STATUS PROPERTY TYPE: The code uses `status: { name: ... }` (Notion status property type) but the database Status field is a `select` type, not a `status` type. Must use `select: { name: ... }` instead. This affects: the file_bug tool (setting Status to Triaged), the list_bugs tool (filter excluding Fixed and Won't Fix), and the update_bug_status tool (setting new status).

All three bugs cause Notion API 404 or validation errors, making every bug tool call fail.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Read lib/mcp/tools/bugs.ts and confirm all three bugs are present
- [ ] Verify the database ID 7f21af359f69490b9370b03c649ee2ed is correct by checking other Notion database references in the codebase

## Step 0: Branch, commit handoff, push

Create branch `fix/bug-tracking-mcp-tools-notion-schema` from `main`. Commit this handoff file. Push.

## Step 1: In lib/mcp/tools/bugs.ts, change the BUGS_DATABASE_ID constant from '023f3621-2885-468d-a8cf-2e0bd1458bb3' to '7f21af359f69490b9370b03c649ee2ed'

## Step 2: In the file_bug tool handler, change the Title property key from 'Title' to 'Bug Title' in the properties object: change `Title: { title: [{ text: { content: params.title } }] }` to `"Bug Title": { title: [{ text: { content: params.title } }] }`

## Step 3: In the file_bug tool handler, change the Status property from `status: { name: 'Triaged' }` to `select: { name: 'Triaged' }`

## Step 4: In the list_bugs tool handler, change both Status filter entries from `status: { does_not_equal: 'Fixed' }` to `select: { does_not_equal: 'Fixed' }` and from `status: { does_not_equal: "Won't Fix" }` to `select: { does_not_equal: "Won't Fix" }`

## Step 5: In the list_bugs tool handler, change the status name extraction from `props.Status?.status?.name` to `props.Status?.select?.name`

## Step 6: In the list_bugs tool handler, change the title extraction from `props.Title?.title` to `props["Bug Title"]?.title`

## Step 7: In the update_bug_status tool handler, change the Status property from `status: { name: params.status }` to `select: { name: params.status }`

## Step 8: Run `npx tsc --noEmit` to verify TypeScript compiles cleanly

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-bug-tracking-mcp-tools (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/bug-tracking-mcp-tools-notion-schema",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```

## Post-merge Note

Test the MCP tools from the planning surface: call list_bugs to verify empty list returns, call file_bug with a test bug, call update_bug_status to mark it Fixed, call list_bugs again to confirm it's excluded.