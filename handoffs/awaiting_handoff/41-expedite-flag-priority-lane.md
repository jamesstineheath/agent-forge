# Handoff 41: expedite-flag-priority-lane

## Metadata
- Branch: `feat/expedite-flag-priority-lane`
- Priority: high
- Model: opus
- Type: feature
- Max Budget: $5
- Risk Level: low
- Complexity: moderate
- Depends On: None
- Date: 2026-03-19
- Executor: Claude Code (GitHub Actions)

## Context

The pipeline currently treats all work items equally in terms of execution priority. When a human cherry-picks an item for immediate execution (via `dispatch_work_item` or `push_handoff`), it still competes for concurrency slots with everything else. This incentivizes bypassing the pipeline entirely and doing work in Claude Code sessions instead.

We need an `expedite` flag that gives a work item a priority lane through the entire pipeline:
- Exempt from concurrency limits (doesn't count against per-repo or global caps)
- Dispatched immediately by the dispatcher, ahead of the queue
- Already benefits from the event reactor for fast CI→review→merge transitions

The MCP `dispatch_work_item` tool should gain an `expedite` option so the human can say "do this now" from a Cowork session.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] WorkItem type has `expedite?: boolean` field
- [ ] Dispatcher scans for expedited items before normal dispatch
- [ ] Expedited items bypass concurrency limits
- [ ] Expedited items are counted in running totals for normal dispatch
- [ ] dispatch_work_item MCP tool accepts expedite parameter
- [ ] push_handoff MCP tool accepts expedite parameter
- [ ] No changes to terminal status guards or event reactor logic

## Step 0: Branch, commit handoff, push

Create branch `feat/expedite-flag-priority-lane` from `main`. Commit this handoff file. Push.

## Step 1: Add `expedite?: boolean` field to the WorkItem type in `lib/atc/types.ts` (or wherever the WorkItem interface is defined). This is a simple boolean flag, default false.

## Step 2: In `lib/atc/dispatcher.ts`, modify the dispatch logic: (a) Before the normal dispatch loop, scan for any `ready` items with `expedite: true`. Dispatch these first, WITHOUT checking concurrency limits (neither global nor per-repo). (b) Log clearly: `[dispatcher] ⚡ expedited dispatch: {item.title} (bypassing concurrency limits)`. (c) After expedited items are dispatched, proceed with normal dispatch for remaining items using the standard concurrency checks (but count expedited items toward the running totals so we don't over-dispatch normal items).

## Step 3: In `lib/work-items.ts`, update `updateWorkItem()` to allow setting the `expedite` field. No special validation needed — it's just a boolean.

## Step 4: Update the MCP `dispatch_work_item` tool to accept an optional `expedite: boolean` parameter. When true, set `expedite: true` on the work item before dispatching. The tool definition is likely in `lib/mcp/tools/` or `app/api/mcp/`. Find the dispatch_work_item handler and add the parameter.

## Step 5: Update the MCP `push_handoff` tool similarly — add an optional `expedite: boolean` parameter. When true, the work item created for the handoff should have `expedite: true` set so it flows through the priority lane after spec review completes.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: expedite-flag-priority-lane (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "feat/expedite-flag-priority-lane",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```