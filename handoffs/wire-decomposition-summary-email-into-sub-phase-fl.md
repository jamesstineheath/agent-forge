# Agent Forge -- Wire decomposition summary email into sub-phase flow

## Metadata
- **Branch:** `feat/wire-decomposition-email-subphase`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/decomposer.ts

## Context

Agent Forge has a decomposer (`lib/decomposer.ts`) that converts Notion project plans into ordered work items. For projects with 16-30 items, the decomposer uses a recursive sub-phase strategy: it calls `groupIntoSubPhases` to cluster items into logical phases, then decomposes each phase separately.

Two recent PRs laid the groundwork:
1. The recursive sub-phase decomposition PR added the `groupIntoSubPhases` function and the 16-30 item path.
2. The email formatting PR updated the decomposition summary email function (`lib/gmail.ts`) to accept an optional `PhaseBreakdown` parameter and render phase-structured summaries.

This task bridges those two: after the sub-phase decomposition succeeds, we need to construct a `PhaseBreakdown` object from the `SubPhase[]` data and pass it to the email function. The ≤15 item path must continue calling the email function without a `PhaseBreakdown`.

Key types to be aware of (infer exact shapes from the source files):
- `SubPhase` — returned by `groupIntoSubPhases`, has fields like `name`/`title`, `items` (work items), and `dependencies` (cross-phase dep strings)
- `PhaseBreakdown` — accepted by the email function in `lib/gmail.ts`, has phases array with item summaries and cross-phase dependency info

## Requirements

1. After successful sub-phase decomposition in the 16-30 item path in `lib/decomposer.ts`, construct a `PhaseBreakdown` object from the `SubPhase[]` array returned by `groupIntoSubPhases`.
2. Map each `SubPhase`'s items to the simplified format required by `PhaseBreakdown` (at minimum: `title` and `priority` fields per item).
3. Extract cross-phase dependencies from `SubPhase.dependencies` and include them in the `PhaseBreakdown`.
4. Pass the constructed `PhaseBreakdown` to the decomposition summary email function call in the 16-30 item path.
5. The ≤15 item path must continue to call the email function **without** a `PhaseBreakdown` (preserving existing flat summary behavior).
6. The 31+ item escalation path must not send a decomposition summary email (existing behavior preserved).
7. TypeScript compiles without errors (`npx tsc --noEmit`).
8. All existing tests continue to pass.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wire-decomposition-email-subphase
```

### Step 1: Read and understand current type definitions and function signatures

Before making any changes, read the relevant files to understand the exact type shapes:

```bash
# Read the decomposer to understand SubPhase type and the decomposition flow
cat lib/decomposer.ts

# Read the gmail module to understand PhaseBreakdown type and email function signature
cat lib/gmail.ts

# Check existing tests for decomposer
find lib/__tests__ -name '*decompos*' | xargs ls -la 2>/dev/null || find . -name '*.test.ts' | xargs grep -l 'decompos' 2>/dev/null
```

Key things to identify:
- The exact shape of `SubPhase` (field names for title/name, items array, dependencies array)
- The exact shape of `PhaseBreakdown` (what fields are required, how items are represented per phase)
- The name of the email function that accepts `PhaseBreakdown` (likely `sendDecompositionSummaryEmail` or similar)
- Where in `lib/decomposer.ts` the 16-30 path calls the email function (or where it should)
- Whether `PhaseBreakdown` is defined in `lib/gmail.ts` or `lib/types.ts`

### Step 2: Implement the PhaseBreakdown construction and email call

In `lib/decomposer.ts`, locate the 16-30 item sub-phase decomposition path. After `groupIntoSubPhases` returns successfully and sub-phase items are collected, add the `PhaseBreakdown` construction and email call.

The implementation pattern should look like this (adjust field names to match actual types):

```typescript
// After sub-phase decomposition completes in the 16-30 item path:

// Construct PhaseBreakdown from SubPhase[] data
const phaseBreakdown: PhaseBreakdown = {
  phases: subPhases.map((subPhase) => ({
    name: subPhase.name,  // or subPhase.title — check actual field name
    items: subPhase.items.map((item) => ({
      title: item.title,
      priority: item.priority,
    })),
    // Include any other fields PhaseBreakdown.phases entries require
  })),
  // Extract cross-phase dependencies from all sub-phases
  crossPhaseDependencies: subPhases.flatMap((subPhase) =>
    subPhase.dependencies ?? []
  ),
  // Include total count or other top-level fields PhaseBreakdown requires
  totalItems: allWorkItems.length,  // adjust variable name to match scope
};

// Call email with PhaseBreakdown
await sendDecompositionSummaryEmail(projectName, allWorkItems, phaseBreakdown);
// (adjust function name and parameters to match actual signature)
```

**Important**: 
- The ≤15 path should already call the email function — leave that call unchanged (no `PhaseBreakdown` argument).
- Only add the `PhaseBreakdown` construction and modified email call in the 16-30 path.
- Import `PhaseBreakdown` type at the top of the file if it isn't already imported.

### Step 3: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

If there are type errors, fix them by adjusting field mappings to match the actual `SubPhase` and `PhaseBreakdown` type definitions.

### Step 4: Run existing tests

```bash
npm test -- --testPathPattern='decompos'
npm test
```

Ensure all tests pass. If any decomposer tests fail due to the new email call being made in the 16-30 path when it wasn't before, update the test mocks to expect the `PhaseBreakdown` argument.

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
npm test
```

Confirm:
- [ ] TypeScript compiles cleanly
- [ ] Build succeeds
- [ ] All tests pass
- [ ] The ≤15 item path in `lib/decomposer.ts` calls the email function without `PhaseBreakdown`
- [ ] The 16-30 item path calls the email function with a constructed `PhaseBreakdown`
- [ ] The 31+ item path does not call the decomposition summary email function

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: wire decomposition summary email into sub-phase flow"
git push origin feat/wire-decomposition-email-subphase
gh pr create \
  --title "feat: wire decomposition summary email into sub-phase flow" \
  --body "## Summary

Connects the phase-structured decomposition summary email to the recursive sub-phase decomposition flow.

## Changes

- **\`lib/decomposer.ts\`**: After successful sub-phase decomposition (16-30 item path), constructs a \`PhaseBreakdown\` object from the \`SubPhase[]\` data and passes it to the decomposition summary email function. The ≤15 item path continues to call the email function without \`PhaseBreakdown\` (flat summary, unchanged behavior).

## Behavior

| Item count | Email behavior |
|---|---|
| ≤ 15 items | Flat summary email (unchanged) |
| 16-30 items | Phase-structured summary email with \`PhaseBreakdown\` |
| 31+ items | No decomposition summary email (escalation path handles comms) |

## Testing
- TypeScript compiles without errors
- All existing tests pass"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wire-decomposition-email-subphase
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you cannot resolve a blocker after 3 attempts (e.g., `PhaseBreakdown` type shape is ambiguous, `SubPhase.dependencies` field doesn't exist, the email function signature doesn't accept `PhaseBreakdown` as expected):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "wire-decomposition-email-subphase",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or type mismatch description>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```