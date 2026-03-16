# Handoff 101: add-qa-agent-to-orchestrator-triggers

## Metadata
- Branch: `fix/orchestrator-add-qa-agent-trigger`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $2
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-16
- Executor: Claude Code (GitHub Actions)

## Context

The Handoff Lifecycle Orchestrator (`handoff-orchestrator.yml`) triggers on `workflow_run` events for: TLM Spec Review, Execute Handoff, TLM Code Review, and CI. It does NOT include "TLM QA Agent".

This means when the QA Agent workflow finishes on a PR branch (often as the last check to complete), the orchestrator is never re-triggered. PRs with all required checks passing — including a just-completed QA Agent success — sit open indefinitely because there's no subsequent CI/review run to trigger the orchestrator.

Observed impact: PRs #92, #95, #98, #100 all had green CI/review checks but were not auto-merged because QA Agent completed last and never re-triggered the orchestrator. Had to manually dispatch the orchestrator 4 times this session.

Fix: add "TLM QA Agent" to the `workflows` list in the `workflow_run` trigger of `.github/workflows/handoff-orchestrator.yml`.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm the `on.workflow_run.workflows` list currently contains exactly: TLM Spec Review, Execute Handoff, TLM Code Review, CI
- [ ] Confirm `branches-ignore: [main, master]` is still present — do not change it
- [ ] The only edit is adding one line: `- "TLM QA Agent"` to the workflows list

## Step 0: Branch, commit handoff, push

Create branch `fix/orchestrator-add-qa-agent-trigger` from `main`. Commit this handoff file. Push.

## Step 1: Edit `.github/workflows/handoff-orchestrator.yml`: in the `on.workflow_run.workflows` list, add `- "TLM QA Agent"` after the existing `- "CI"` entry. No other changes needed.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: add-qa-agent-to-orchestrator-triggers (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/orchestrator-add-qa-agent-trigger",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```
