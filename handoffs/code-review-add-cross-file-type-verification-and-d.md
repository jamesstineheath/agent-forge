<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Code Review: add cross-file type verification and duplication detection

## Metadata
- **Branch:** `feat/tlm-review-type-verification-and-dedup`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** .github/actions/tlm-review/src/review-prompt.ts

## Context

The TLM Code Review action lives at `.github/actions/tlm-review/` and provides automated PR review via Claude. The review prompt is built in `src/review-prompt.ts`.

A recent incident on personal-assistant PR #392 exposed two gaps in the review logic:

1. **Cross-file type verification**: The reviewer only read the PR diff. New components referenced fields like `slot.activity.name`, `slot.isLocked`, `slot.childcare` — but the actual `ItinerarySlot` type (updated by a concurrent PR #395) uses flat fields (`title`, `locked`, no `childcare`). The reviewer never read the imported type definition files to validate field names matched usage.

2. **Duplication detection**: Four files independently defined identical `dayNames`/`monthNames` arrays and near-identical date formatting functions. Two functions (`formatDayLabel` and `formatDayOption`) produced identical output. The reviewer did not flag this.

The root cause for issue #1 is also a post-rebase scenario: PR #392 was self-consistent within its own branch (old types matched), but PR #395 changed the types on main. Code review ran against the branch before rebasing, so it never checked compatibility with main's current type definitions.

**Concurrent work to avoid**: `fix/fix-tlm-code-review-decision-persistence-all-decis` is actively modifying `.github/actions/tlm-review/src/index.ts` and `.github/actions/tlm-outcome-tracker/src/index.ts`. **This handoff must only modify `src/review-prompt.ts`** — do not touch `index.ts` in either action.

## Requirements

1. In `.github/actions/tlm-review/src/review-prompt.ts`, add an instruction directing the reviewer to read imported type definition files for any new files in the PR diff, and verify that all field names and shapes used in the new code match the actual type definitions.
2. Add an instruction directing the reviewer to check whether new utility functions (e.g. date formatting, color mapping, array constants like day/month names) duplicate existing ones elsewhere in the codebase.
3. Add an instruction directing the reviewer to verify that code in the PR branch is compatible with the *current* state of `main`'s type definitions — not just the branch's own snapshot — particularly after rebases or when a concurrent PR may have changed shared types.
4. The new instructions must be coherent with the existing prompt style and formatting conventions in `review-prompt.ts`.
5. Do not modify `.github/actions/tlm-review/src/index.ts` or any file under `.github/actions/tlm-outcome-tracker/`.
6. TypeScript must compile without errors after the change (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tlm-review-type-verification-and-dedup
```

### Step 1: Read the existing review prompt

Read the full content of the file to understand its current structure and style before making any changes:

```bash
cat .github/actions/tlm-review/src/review-prompt.ts
```

Also read `index.ts` (read-only — do not edit it) to understand how the prompt is consumed:

```bash
cat .github/actions/tlm-review/src/index.ts
```

Note the style used: whether instructions are bullet points, numbered lists, prose paragraphs, or a mix. Match that style exactly when inserting new instructions.

### Step 2: Add the three new review instructions to `review-prompt.ts`

Edit `.github/actions/tlm-review/src/review-prompt.ts` to insert the following three instructions in the most logical location within the existing prompt (likely near sections about code quality, type safety, or correctness — use your judgment based on what you see):

**Instruction 1 — Cross-file type verification:**
> For any new or modified files that import types, interfaces, or classes from other files, read those type definition files to verify that all field names and shapes used in the new code match the actual exported definitions. Do not assume the imported type is what the diff implies — check the source.

**Instruction 2 — Utility duplication detection:**
> Check whether new utility functions, constants, or lookup structures (e.g. date formatting helpers, day/month name arrays, color mapping functions) duplicate or near-duplicate existing ones elsewhere in the codebase. If duplicates exist, flag them as candidates for consolidation.

**Instruction 3 — Post-rebase / cross-branch type compatibility:**
> When reviewing a PR, verify that the code is compatible with the *current* state of `main`'s type definitions, not just the branch's own snapshot. If the PR imports shared types that may have changed on main (due to concurrent PRs or recent merges), note whether a rebase is needed to surface any type conflicts before merging.

Adapt the exact wording to match the existing prompt's tone and format. The meaning must be preserved.

### Step 3: Verify no other files were modified

```bash
git diff --name-only
```

The output must contain only:
```
.github/actions/tlm-review/src/review-prompt.ts
```

If `index.ts` or any `tlm-outcome-tracker` file appears, revert those changes immediately:
```bash
git checkout .github/actions/tlm-review/src/index.ts
git checkout .github/actions/tlm-outcome-tracker/
```

### Step 4: TypeScript compilation check

```bash
cd .github/actions/tlm-review
npm install
npx tsc --noEmit
cd ../../..
```

If compilation fails, inspect the error, fix it in `review-prompt.ts` only, and re-run.

### Step 5: Sanity check — confirm new content is present

```bash
grep -n "type definition" .github/actions/tlm-review/src/review-prompt.ts
grep -n "duplicat" .github/actions/tlm-review/src/review-prompt.ts
grep -n "rebase\|current.*main\|main.*current" .github/actions/tlm-review/src/review-prompt.ts
```

Each grep should return at least one match. If any returns empty, the corresponding instruction was not added — go back to Step 2.

### Step 6: Commit, push, open PR

```bash
git add .github/actions/tlm-review/src/review-prompt.ts
git commit -m "fix: add cross-file type verification and duplication detection to TLM Code Review prompt

- Instruct reviewer to read imported type definition files and verify
  field names/shapes match actual usage in new code
- Instruct reviewer to flag utility functions/constants that duplicate
  existing ones in the codebase (e.g. dayNames, date formatters)
- Instruct reviewer to verify PR is compatible with current main's type
  definitions, not just the branch snapshot (post-rebase safety check)

Motivated by personal-assistant PR #392 where slot field mismatches and
four-way dayNames duplication were not caught in review."

git push origin feat/tlm-review-type-verification-and-dedup

gh pr create \
  --title "fix: add cross-file type verification and duplication detection to TLM Code Review" \
  --body "## Summary

Adds three new review instructions to \`.github/actions/tlm-review/src/review-prompt.ts\` to close gaps exposed by personal-assistant PR #392.

## Problems Fixed

### 1. Cross-file type verification
The reviewer was only reading the PR diff. New components referenced field names (\`slot.activity.name\`, \`slot.isLocked\`, \`slot.childcare\`) that didn't match the actual \`ItinerarySlot\` type definition (flat fields: \`title\`, \`locked\`, no \`childcare\`). The reviewer now reads imported type definition files to verify field names and shapes.

### 2. Utility duplication detection
Four files independently defined identical \`dayNames\`/\`monthNames\` arrays and near-identical date formatting functions — not caught in review. The reviewer now explicitly checks for utility duplication.

### 3. Post-rebase / cross-branch type compatibility
PR #392 was self-consistent on its branch, but PR #395 changed shared types on main. The reviewer now checks whether code is compatible with \*current\* main, not just the branch snapshot.

## Files Changed
- \`.github/actions/tlm-review/src/review-prompt.ts\` — added 3 review instructions

## Files NOT Changed
- \`.github/actions/tlm-review/src/index.ts\` — avoided (concurrent branch: fix/fix-tlm-code-review-decision-persistence-all-decis)
- \`.github/actions/tlm-outcome-tracker/\` — avoided (same concurrent branch)
" \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/tlm-review-type-verification-and-dedup
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Notes for Executor

- **Concurrent work conflict**: The branch `fix/fix-tlm-code-review-decision-persistence-all-decis` is actively modifying `tlm-review/src/index.ts` and `tlm-outcome-tracker/src/index.ts`. This handoff touches only `review-prompt.ts`, so there should be no file conflict — but if that branch merges before this one, do a `git rebase main` to pick up any changes before pushing.
- If `review-prompt.ts` does not exist at the expected path, search for it: `find .github/actions/tlm-review -name "*.ts" | head -20`. The file containing the review instructions may have a different name — read all `.ts` files in `src/` to find the right one, then apply changes there.
- If the action does not have a `tsconfig.json` (pure JS), skip the `tsc --noEmit` step and verify with `node --check` or `npm run build` if a build script exists.