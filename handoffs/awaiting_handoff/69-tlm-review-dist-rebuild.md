# Handoff 69: Rebuild TLM Code Review dist bundle

## Metadata
- Branch: `fix/tlm-review-dist-rebuild`
- Target repo: jamesstineheath/agent-forge
- Priority: critical
- Model: sonnet
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Date: 2026-03-21
- Estimated files: .github/actions/tlm-review/dist/index.js

## Context

PR #435 added a CI gate fix to `.github/actions/tlm-review/src/index.ts` (40 lines changed) but the compiled bundle at `.github/actions/tlm-review/dist/index.js` was hand-edited (only 3 lines changed) instead of properly rebuilt. GitHub Actions runs the dist, not the source. The fix is dead code.

The source has the correct logic: when `checkCIStatus` finds zero non-TLM check runs, it should poll for up to 30 seconds for CI to register instead of returning "passed" immediately. But the dist still has the old behavior where empty check list equals "passed," which means TLM approves and merges PRs before CI finishes.

Branch protection is now the hard gate (admin bypass removed), so this is no longer a safety issue, but the TLM action should still work correctly as a defense-in-depth layer.

## Pre-flight Self-Check

- [ ] Read `.github/actions/tlm-review/src/index.ts` and confirm the CI gate fix exists in source (look for the 30-second polling loop when `ciChecks.length === 0`)
- [ ] Read `.github/actions/tlm-review/package.json` to find the build command (likely `"build": "ncc build ..."` or similar)
- [ ] Run `grep -c "Waiting for CI to register" .github/actions/tlm-review/dist/index.js` — expect **0**, proving the dist is stale
- [ ] If pre-flight check 1 fails (source doesn't have the fix), ABORT — the premise is wrong

## Step 0: Branch, commit handoff, push

Create branch `fix/tlm-review-dist-rebuild` from `main`. Commit this handoff file. Push.

## Step 1: Install dependencies and rebuild
