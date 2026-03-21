<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Spec Review: Cross-Reference Handoff Type Shapes Against Codebase

## Metadata
- **Branch:** `feat/spec-review-type-shape-verification`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** .github/actions/tlm-spec-review/src/spec-review-prompt.ts

## Context

The TLM Spec Review action (`.github/actions/tlm-spec-review/`) is responsible for improving handoff files before Claude Code executes them. It currently fails to catch a critical class of bugs: handoffs that paste inline type definitions or reference field names that have diverged from the actual codebase types.

**Concrete failure:** PR #392's handoff included a 415-line spec referencing `slot.activity.name` and `slot.isLocked`, while the real `ItinerarySlot` type uses `slot.title` and `slot.locked`. The spec reviewer approved it without flagging the mismatch.

**Secondary concern:** PR #395 modified `lib/travel/types.ts` at the same time PR #392 depended on it, but neither the ATC conflict detection nor spec review flagged the conflict. This handoff adds spec-review-level cross-checking of estimated files against recently merged PRs.

The fix is purely in the spec review prompt — adding three new verification instructions that tell the reviewer to:
1. Verify inline type field names against actual codebase types
2. Flag handoffs that paste type shapes inline rather than referencing import paths
3. Cross-check `Estimated files` metadata against recently merged PRs for concurrent modification risk

**No concurrent file conflicts:** The concurrent "Dashboard Project Cleanup" work item touches `app/(app)/projects/page.tsx`, `lib/projects.ts`, `lib/types.ts`, `lib/work-items.ts`, `lib/pm-agent.ts`, and `lib/pm-prompts.ts` — none of which overlap with the target file here.

## Requirements

1. Locate the spec review prompt source file at `.github/actions/tlm-spec-review/src/spec-review-prompt.ts` (or equivalent — see Step 1 for discovery).
2. Add an instruction directing the spec reviewer to verify inline type definitions and field name references against actual codebase types (specifically checking `lib/*/types.ts` and similar type files).
3. Add an instruction to flag handoffs that paste type shapes inline instead of referencing existing types by import path, with guidance to prefer `"use ItinerarySlot from lib/travel/types.ts"` over pasting the interface definition.
4. Add an instruction to cross-check the handoff's `Estimated files` metadata against recently merged PRs that may have modified the same files, flagging potential concurrent modification conflicts.
5. The new instructions must integrate cleanly with the existing prompt structure — matching the formatting, tone, and section organization already present.
6. No other files may be modified. Do not touch `lib/types.ts`, `lib/work-items.ts`, or any file in the concurrent work item's file list.
7. TypeScript must compile without errors (`npx tsc --noEmit`).
8. If the action uses a build step, the built output must be updated.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spec-review-type-shape-verification
```

### Step 1: Discover the spec review action structure

Before making any changes, map the actual file layout:

```bash
find .github/actions/tlm-spec-review -type f | sort
```

Look for:
- The main prompt-building file (likely `src/spec-review-prompt.ts`, `src/prompt.ts`, or similar)
- Whether there is a `dist/` or compiled output directory
- A `package.json` with a build script
- Any `index.ts` or `action.ts` entry point

Also check if the prompt is defined inline in the action entry point rather than a separate file:

```bash
grep -r "spec.review\|specReview\|SPEC_REVIEW\|You are a spec reviewer\|handoff" .github/actions/tlm-spec-review/src/ --include="*.ts" -l 2>/dev/null || \
grep -r "spec.review\|specReview\|SPEC_REVIEW\|You are a spec reviewer\|handoff" .github/actions/tlm-spec-review/ --include="*.ts" -l
```

Read the identified file(s) fully before making any edits:

```bash
cat .github/actions/tlm-spec-review/src/spec-review-prompt.ts 2>/dev/null || \
cat .github/actions/tlm-spec-review/src/prompt.ts 2>/dev/null || \
# fallback: print all .ts files
find .github/actions/tlm-spec-review -name "*.ts" | xargs cat
```

### Step 2: Understand the existing prompt structure

Before editing, identify:
- How existing instructions are formatted (numbered list? bullet points? prose sections?)
- Whether there are labeled sections (e.g., "Type Safety", "Conflict Detection", "Code Quality")
- The tone and specificity level of existing checks
- Where new instructions should be inserted to be logically grouped

Example patterns you might find:
```typescript
// Pattern A: Array of instruction strings
const instructions = [
  "Check that all referenced APIs exist in the codebase...",
  "Verify that environment variables mentioned are listed in .env.example...",
];

// Pattern B: Template literal prompt
const prompt = `
You are a spec reviewer. For each handoff:
1. Check X
2. Verify Y
...
`;

// Pattern C: Structured object
const checks = {
  typeSafety: [...],
  conflicts: [...],
};
```

Match the existing pattern exactly.

### Step 3: Add the three new verification instructions

Find the appropriate insertion point(s) in the prompt. If the prompt has a type-safety or code-quality section, add instructions 1 and 2 there. If it has a conflict/dependency section, add instruction 3 there. If no clear sections exist, append as a logical group.

Add these three instructions (adapt formatting to match existing style):

**Instruction 1 — Type field verification:**
> When a handoff includes inline type definitions or references specific field names on types (e.g., `slot.activity.name`, `slot.isLocked`), verify those field names against the actual type definitions in the codebase. Check `lib/*/types.ts`, `lib/types.ts`, and any type files relevant to the referenced domain. Flag any field names that do not exist on the declared type.

**Instruction 2 — Inline type shape anti-pattern:**
> Flag handoffs that paste interface or type definitions inline rather than referencing existing types by import path. For example, if a handoff copies out an `ItinerarySlot` interface body, flag it and suggest: "Reference the existing type via `import { ItinerarySlot } from 'lib/travel/types'` instead of pasting the definition." Pasted type shapes become stale and cause the executor agent to implement against a diverged contract.

**Instruction 3 — Estimated files / recent PR conflict check:**
> Cross-check the handoff's `Estimated files` metadata against recently merged PRs in the same repository. If any listed file was modified by a PR merged within the last 24–48 hours, flag it as a potential concurrent modification conflict and note which PR touched the file. This catches cases where the work item was filed against a version of a file that has since changed.

### Step 4: Verify the edit is clean

Read the modified file back in full to confirm:
- The three new instructions are present and correctly worded
- No existing instructions were accidentally deleted or corrupted
- Formatting is consistent throughout
- No syntax errors (unclosed template literals, missing commas in arrays, etc.)

```bash
cat .github/actions/tlm-spec-review/src/spec-review-prompt.ts
# or whichever file was identified in Step 1
```

### Step 5: Build the action if required

Check whether the action has a build step:

```bash
cat .github/actions/tlm-spec-review/package.json 2>/dev/null | grep -A5 '"scripts"'
```

If there is a `build` or `package` script, run it:

```bash
cd .github/actions/tlm-spec-review
npm install 2>/dev/null || true
npm run build 2>/dev/null || npm run package 2>/dev/null || true
cd -
```

If the action uses `dist/` output, confirm it was updated:

```bash
git diff --stat .github/actions/tlm-spec-review/dist/ 2>/dev/null | head -20
```

If there is no build step (pure TypeScript read at runtime, or action uses `ts-node`), skip this step.

### Step 6: TypeScript type check

From the repo root (if there is a root `tsconfig.json`):

```bash
npx tsc --noEmit 2>&1 | head -50
```

If the action has its own `tsconfig.json`:

```bash
cd .github/actions/tlm-spec-review
npx tsc --noEmit 2>&1 | head -50
cd -
```

Resolve any type errors before proceeding. Do not proceed with a failing type check.

### Step 7: Sanity check — no concurrent file overlap

Confirm the modified files do not overlap with the concurrent work item:

```bash
git diff --name-only
```

Expected output should include only files under `.github/actions/tlm-spec-review/`. If any of the following appear, stop and escalate:
- `app/(app)/projects/page.tsx`
- `lib/projects.ts`
- `lib/types.ts`
- `lib/work-items.ts`
- `lib/pm-agent.ts`
- `lib/pm-prompts.ts`

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "fix: add type-shape and conflict verification to TLM spec review prompt

- Add instruction to verify inline type field names against actual codebase types
- Add instruction to flag pasted type shape definitions (prefer import references)
- Add instruction to cross-check Estimated files against recently merged PRs

Fixes the class of bug seen in PR #392 (slot.activity.name vs slot.title)
and the concurrent modification miss between PR #392 and PR #395."

git push origin feat/spec-review-type-shape-verification

gh pr create \
  --title "fix: add type-shape and conflict verification to TLM spec review prompt" \
  --body "## Summary

Adds three new verification instructions to the TLM Spec Review prompt to prevent a class of handoff bugs where inline type shapes diverge from the real codebase types.

## Problem

PR #392's handoff referenced \`slot.activity.name\` and \`slot.isLocked\` — neither of which exist on the actual \`ItinerarySlot\` type (\`slot.title\` and \`slot.locked\` are the real fields). The spec reviewer approved the handoff without catching this, causing the executor agent to implement against a stale/wrong type contract.

Separately, PR #395 modified \`lib/travel/types.ts\` concurrently with PR #392 depending on it, and neither ATC nor spec review flagged the conflict.

## Changes

- **Instruction 1:** Verify field names in inline type references against actual \`lib/*/types.ts\` definitions
- **Instruction 2:** Flag pasted interface bodies — prefer import path references over inline copies
- **Instruction 3:** Cross-check \`Estimated files\` metadata against recently merged PRs for concurrent modification risk

## Files changed

- \`.github/actions/tlm-spec-review/src/spec-review-prompt.ts\` (prompt additions)
- \`.github/actions/tlm-spec-review/dist/*\` (rebuilt output, if applicable)

## Testing

Type-checked clean. No functional logic changed — prompt text additions only.

## Concurrent work note

Verified no overlap with \`feat/dashboard-project-cleanup-prd-53-ac-5ac-6ac-7\` (that branch touches \`lib/types.ts\`, \`lib/work-items.ts\`, etc. — none of which are modified here)." \
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
BRANCH: feat/spec-review-type-shape-verification
FILES CHANGED: [list actual changed files]
SUMMARY: [what was done — which instructions were added, whether build ran]
ISSUES: [what failed — e.g., "could not locate spec-review-prompt.ts, file may be at different path"]
NEXT STEPS: [what remains — e.g., "build step needed", "file path needs human confirmation"]
```

## Escalation Protocol

If you cannot locate the spec review prompt file after exhaustive search, or if the action structure differs significantly from what is described (e.g., prompt is fetched remotely, generated dynamically, or lives in a compiled blob with no editable source), escalate immediately rather than guessing:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "spec-review-type-shape-verification",
    "reason": "Cannot locate editable spec review prompt source. Action structure differs from expected — prompt file not found at .github/actions/tlm-spec-review/src/spec-review-prompt.ts or any nearby .ts file.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "File not found at expected paths; action structure unknown",
      "filesChanged": []
    }
  }'
```