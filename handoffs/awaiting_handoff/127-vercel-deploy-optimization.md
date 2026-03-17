# Handoff 127: vercel-deploy-optimization

## Metadata
- Branch: `chore/vercel-deploy-optimization`
- Priority: medium
- Model: opus
- Type: chore
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-17
- Executor: Claude Code (GitHub Actions)

## Context

Agent Forge's autonomous pipeline creates excessive Vercel deployments. Every push to any branch (handoff files, docs, CI config, TLM memory) triggers a full Vercel build even though these changes don't affect the deployed Next.js app. Data shows 20 deployments in 2.7 hours, with bursts of 4 production deploys within 40 seconds when PRs auto-merge in sequence. This wastes build minutes and risks exceeding the 6,000 deployments/month Pro plan limit across all projects.

The fix: use Vercel's built-in `ignoreCommand` to skip builds when only non-app files changed. The existing `vercel.json` currently only has the ATC cron config. The `scripts/` directory already exists.

IMPORTANT: The `ignoreCommand` exit code convention is INVERTED from what you might expect. Exit code 0 = SKIP the build (do NOT deploy). Exit code 1 = PROCEED with the build (DO deploy). This is Vercel's convention documented at https://vercel.com/docs/projects/overview#ignored-build-step.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] vercel.json exists and contains the crons configuration
- [ ] scripts/ directory exists
- [ ] No existing ignoreCommand is configured

## Step 0: Branch, commit handoff, push

Create branch `chore/vercel-deploy-optimization` from `main`. Commit this handoff file. Push.

## Step 1: Create `scripts/should-deploy.sh`

Create `scripts/should-deploy.sh` with the following logic:
- Get the diff between VERCEL_GIT_PREVIOUS_SHA and VERCEL_GIT_COMMIT_SHA (Vercel provides these env vars)
- If either SHA is missing (first deploy), exit 1 (proceed with build)
- Define ignore patterns: `handoffs/`, `docs/`, `.github/`, root-level `*.md` files, `docs/tlm-memory.md`, `docs/tlm-action-ledger.json`
- Check if ALL changed files match ignore patterns
- If ALL files are ignorable → exit 0 (SKIP build, do NOT deploy)
- If ANY file is outside ignore patterns → exit 1 (PROCEED with build, DO deploy)
- Echo clear messages like 'All changes are non-app files, skipping deploy' or 'App files changed, proceeding with deploy'
- Make the script executable (chmod +x)

## Step 2: Update vercel.json

Update `vercel.json` to add the ignoreCommand. The file currently contains:
```json
{
  "crons": [
    {
      "path": "/api/atc/cron",
      "schedule": "*/5 * * * *"
    }
  ]
}
```
Add `"ignoreCommand": "bash scripts/should-deploy.sh"` to the top level, preserving the existing crons config.

## Step 3: Verify locally

Verify by running `bash scripts/should-deploy.sh` locally (it should handle missing env vars gracefully by defaulting to 'proceed with build').

## Step 4: Open PR

Open PR targeting main with title 'chore: add Vercel ignored build step to skip non-app deployments'

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: vercel-deploy-optimization (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "chore/vercel-deploy-optimization",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```