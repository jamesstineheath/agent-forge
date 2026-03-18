# Handoff 37: fix-outcome-tracker-push-failures

## Metadata
- Branch: `fix/outcome-tracker-push-failures`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $2
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

The TLM Outcome Tracker workflow (`tlm-outcome-tracker.yml`) fails intermittently at the "Commit memory updates" step. Both March 16 and March 17 runs failed at this step, while the actual Outcome Tracker agent (step 3) succeeded.

Root cause: The workflow checks out `main`, runs the tracker (which modifies `docs/tlm-memory.md`), then does `git push` without pulling first. If any other workflow or commit lands on `main` between checkout and push (common given the ATC cron, other TLM agents, and pipeline merges all committing to main), the push fails with a non-fast-forward error.

Fix: Add `git pull --rebase` before `git push` in the "Commit memory updates" step. This is a one-line addition to the workflow YAML.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm the current 'Commit memory updates' step in tlm-outcome-tracker.yml does NOT have git pull --rebase
- [ ] Confirm the workflow YAML is syntactically valid after the change

## Step 0: Branch, commit handoff, push

Create branch `fix/outcome-tracker-push-failures` from `main`. Commit this handoff file. Push.

## Step 1: Update the workflow YAML

In `.github/workflows/tlm-outcome-tracker.yml`, update the 'Commit memory updates' step to add `git pull --rebase origin main` before `git push`. The full step should be:
```yaml
      - name: Commit memory updates
        run: |
          git config user.name "TLM Outcome Tracker"
          git config user.email "tlm@github-actions"
          git add docs/tlm-memory.md
          git diff --cached --quiet || {
            git commit -m "chore(tlm): update review memory with outcome assessments"
            git pull --rebase origin main
            git push
          }
```
Note: the `git diff --cached --quiet || { ... }` pattern ensures we only pull/push if there's actually a commit to push.

## Step 2: Verify YAML validity

Run `cat .github/workflows/tlm-outcome-tracker.yml` to confirm indentation and syntax are correct.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-outcome-tracker-push-failures (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/outcome-tracker-push-failures",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```