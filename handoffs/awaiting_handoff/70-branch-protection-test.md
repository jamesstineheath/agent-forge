# Handoff 70: Branch Protection Verification Test

## Metadata
- Branch: `test/branch-protection-verification`
- Priority: high
- Model: sonnet
- Type: chore
- Max Budget: $2
- Risk Level: low
- Complexity: simple
- Date: 2026-03-21
- Estimated files: lib/atc/sort.ts

## Context

This is a test to verify that GitHub branch protection is correctly blocking merges when CI fails. Make a trivial, safe change and let the pipeline attempt to merge it. If branch protection is working, the merge will be blocked by GitHub when the build check fails.

## Step 0: Branch, commit handoff, push

Create branch `test/branch-protection-verification` from `main`. Commit this handoff file. Push.

## Step 1: Add a comment to a safe file

Add a single comment line to the top of `lib/atc/sort.ts`:
