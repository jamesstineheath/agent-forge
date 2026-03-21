# Handoff 69: Rebuild TLM Code Review dist bundle

## Metadata
- Branch: `fix/tlm-review-dist-rebuild`
- Priority: critical
- Model: sonnet
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Date: 2026-03-21

## Context

PR #435 added a CI gate fix to `.github/actions/tlm-review/src/index.ts` (40 lines changed) but the compiled bundle at `.github/actions/tlm-review/dist/index.js` was hand-edited (only 3 lines changed) instead of properly rebuilt. GitHub Actions runs the dist, not the source. The fix is dead code.

The source has the correct logic: when `checkCIStatus` finds zero non-TLM check runs, it should poll for up to 30 seconds for CI to register instead of returning "passed" immediately. But the dist still has the old behavior where empty check list equals "passed," which means TLM approves and merges PRs before CI finishes.

Branch protection is now the hard gate (admin bypass removed), so this is no longer a safety issue, but the TLM action should still work correctly as a defense-in-depth layer.

## Pre-flight Self-Check

- [ ] Read `.github/actions/tlm-review/src/index.ts` and confirm the CI gate fix exists in source (look for the 30-second polling loop when ciChecks.length === 0)
- [ ] Read `.github/actions/tlm-review/package.json` to find the build command
- [ ] Confirm `dist/index.js` does NOT contain the polling loop (proving the dist is stale)

## Step 0: Branch, commit handoff, push

Create branch `fix/tlm-review-dist-rebuild` from `main`. Commit this handoff file. Push.

## Step 1: Install dependencies for the TLM review action

```bash
cd .github/actions/tlm-review
cat package.json  # find the build script name
npm ci
```

## Step 2: Rebuild the dist bundle

```bash
npm run build
```

This should recompile `src/index.ts` into `dist/index.js` using whatever bundler is configured (likely ncc, esbuild, or tsc).

## Step 3: Verify the rebuild includes the CI gate fix

```bash
grep -c "Waiting for CI to register" dist/index.js
grep -c "No CI checks appeared after" dist/index.js
```

Both should return 1. If they return 0, the source fix from PR #435 is not being compiled correctly. Check the build output for errors.

## Step 4: Verify from repo root

```bash
cd ../../..  # back to repo root
npx tsc --noEmit
```

## Step 5: Commit and push

```bash
git add .github/actions/tlm-review/dist/index.js
git commit -m "fix: rebuild TLM Code Review dist bundle (CI gate fix was source-only)"
git push origin fix/tlm-review-dist-rebuild
```

Open PR targeting main.

## Session Abort Protocol

If the build command fails or dist/index.js doesn't contain the expected strings after rebuild:

1. Check if the source fix in `src/index.ts` compiles at all: `npx tsc --noEmit -p .github/actions/tlm-review/tsconfig.json`
2. If there's a tsconfig or bundler config issue, commit whatever you have and report
3. Push branch and open draft PR with findings

```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/tlm-review-dist-rebuild",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```

## Post-merge Note

After this merges, the next TLM Code Review run on any PR should show the new behavior: if CI hasn't registered yet, TLM will poll for up to 30s before proceeding. Verify by checking the TLM workflow logs for "Waiting for CI to register" or "No CI checks appeared after" messages.
