# Handoff 62: fix-phase-route-max-duration

## Metadata
- Branch: `fix/phase-route-max-duration`
- Priority: critical
- Model: opus
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-20
- Executor: Claude Code (GitHub Actions)

## Context

The Supervisor phase decomposition (PR #386, Session 59) split the monolithic Supervisor into 14 independent phase API routes called by a lightweight coordinator. PR #394 (Session 61) bumped the Supervisor cron route maxDuration to 800s and the coordinator budget to 780s to accommodate Opus latency in the decomposition phase. However, each phase route is its own serverless function and needs its own maxDuration export. The decomposition phase route was missed and still inherits the default ~300s limit.

Evidence: Vercel runtime logs show the decomposition phase route at /api/agents/supervisor/phases/decomposition returning 504 (gateway timeout) after ~295s. The Supervisor phase log records "Timed out after 295000ms". The coordinator itself runs fine (the overall Supervisor cycle completes at 338s), but the fetch call to the decomposition phase route hits Vercel's function-level timeout.

The architecture-planning phase also calls Opus and should get the same treatment, though it currently completes in ~1.4s (no Approved PRDs needing plans). Proactive fix to prevent the same issue when it does have real work.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] Confirm decomposition phase route exists at app/api/agents/supervisor/phases/decomposition/route.ts
- [ ] Confirm architecture-planning phase route exists at app/api/agents/supervisor/phases/architecture-planning/route.ts
- [ ] Confirm Supervisor cron route already has maxDuration = 800

## Step 0: Branch, commit handoff, push

Create branch `fix/phase-route-max-duration` from `main`. Commit this handoff file. Push.

## Step 1: Find all Supervisor phase route files under app/api/agents/supervisor/phases/. Identify which ones currently export maxDuration and what values they use.

## Step 2: Add `export const maxDuration = 800;` to app/api/agents/supervisor/phases/decomposition/route.ts. This is the critical fix.

## Step 3: Add `export const maxDuration = 800;` to app/api/agents/supervisor/phases/architecture-planning/route.ts. Proactive fix for the other Opus-calling phase.

## Step 4: Audit all remaining phase routes. Any phase that makes an Anthropic API call (check for anthropic, routedAnthropicCall, or Claude model strings in the phase handler) should also get maxDuration = 800. Phases that only do Blob/GitHub reads can stay at default.

## Step 5: Verify the Supervisor cron route (app/api/agents/supervisor/cron/route.ts) already has maxDuration = 800 from PR #394. Do not change it, just confirm.

## Step 6: Run tsc --noEmit to verify no type errors.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: fix-phase-route-max-duration (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/phase-route-max-duration",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```

## Post-merge Note

After merge and deploy, monitor the next Supervisor cycle. The decomposition phase should either complete successfully or run for longer than 300s without a 504. Check Vercel runtime logs for /api/agents/supervisor/phases/decomposition status. The Supervisor phase log (via get_pipeline_health) should show decomposition as success or a longer timeout, not 295s.