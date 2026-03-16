# Agent Forge -- C1: Add failure categorization types and classifier utility

## Metadata
- **Branch:** `feat/failure-categorization-types-and-classifier`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/failure-classifier.ts

## Context

Agent Forge is a dev orchestration platform that coordinates autonomous agent teams. When handoff executions fail, the system currently has no structured way to categorize failures or determine appropriate recovery actions. This work item adds the foundational infrastructure for intelligent failure recovery.

This is the first component (C1) in a larger failure categorization feature. All subsequent components will depend on the `FailureCategory` type and the classifier utility created here.

Existing patterns to follow:
- `lib/types.ts` already exports the `WorkItem` interface and other shared types — add to it without breaking existing exports
- New utility files in `lib/` follow simple function-export patterns (see `lib/github.ts`, `lib/utils.ts`)
- TypeScript strict mode is in use — all types must be explicit

## Requirements

1. `lib/types.ts` must export `type FailureCategory = 'transient' | 'execution' | 'structural' | 'unknown'`
2. The `WorkItem` interface in `lib/types.ts` must include an optional `failureCategory?: FailureCategory` field
3. `lib/failure-classifier.ts` must export `classifyFailure(errorOutput: string, exitCode?: number): FailureCategory`
4. `classifyFailure` must match structural patterns first, then transient, then execution, then default to `'unknown'`
5. Structural patterns: `/401/`, `/403/`, `/Forbidden/`, `/missing.*env/i`, `/ANTHROPIC_API_KEY/`, `/GH_PAT/`, `/repo.*not found/i`, `/permission denied/i`, `/authentication failed/i`
6. Transient patterns: `/timeout/i`, `/ETIMEDOUT/`, `/rate limit/i`, `/5\d{2}/`, `/ECONNRESET/`, `/network error/i`, `/GitHub API rate/i`
7. Execution patterns: `/tsc.*error/i`, `/TS\d{4}/`, `/test.*fail/i`, `/build.*fail/i`, `/context.*exhaust/i`, `/JEST/`, `/vitest/i`, `/npm run build.*exit code/i`, `/compile.*error/i`
8. `lib/failure-classifier.ts` must export `getMaxRetries(category: FailureCategory): number` returning `2` for transient, `0` for execution, `0` for structural, `1` for unknown
9. `lib/failure-classifier.ts` must export `getRecoveryAction(category: FailureCategory): 'retry' | 'regenerate' | 'escalate' | 'retry-then-escalate'` returning `'retry'` for transient, `'regenerate'` for execution, `'escalate'` for structural, `'retry-then-escalate'` for unknown

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/failure-categorization-types-and-classifier
```

### Step 1: Add `FailureCategory` type and extend `WorkItem` in `lib/types.ts`

Open `lib/types.ts`. Find the `WorkItem` interface definition. Add the following:

1. Near the top of the file (with other type exports), add:
```typescript
export type FailureCategory = 'transient' | 'execution' | 'structural' | 'unknown';
```

2. Inside the `WorkItem` interface, add the optional field:
```typescript
failureCategory?: FailureCategory;
```

Place `failureCategory` logically near other failure/status-related fields if they exist, or at the end of the interface. Do not remove or rename any existing fields.

### Step 2: Create `lib/failure-classifier.ts`

Create the file with the following content:

```typescript
import type { FailureCategory } from './types';

// Pattern lists ordered by match priority within each category

const STRUCTURAL_PATTERNS: RegExp[] = [
  /401/,
  /403/,
  /Forbidden/,
  /missing.*env/i,
  /ANTHROPIC_API_KEY/,
  /GH_PAT/,
  /repo.*not found/i,
  /permission denied/i,
  /authentication failed/i,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /ETIMEDOUT/,
  /rate limit/i,
  /5\d{2}/,
  /ECONNRESET/,
  /network error/i,
  /GitHub API rate/i,
];

const EXECUTION_PATTERNS: RegExp[] = [
  /tsc.*error/i,
  /TS\d{4}/,
  /test.*fail/i,
  /build.*fail/i,
  /context.*exhaust/i,
  /JEST/,
  /vitest/i,
  /npm run build.*exit code/i,
  /compile.*error/i,
];

/**
 * Classifies a failure based on error output and optional exit code.
 * Match order: structural → transient → execution → unknown
 */
export function classifyFailure(errorOutput: string, exitCode?: number): FailureCategory {
  if (STRUCTURAL_PATTERNS.some((pattern) => pattern.test(errorOutput))) {
    return 'structural';
  }
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(errorOutput))) {
    return 'transient';
  }
  if (EXECUTION_PATTERNS.some((pattern) => pattern.test(errorOutput))) {
    return 'execution';
  }
  return 'unknown';
}

/**
 * Returns the maximum number of automatic retries for a given failure category.
 * - transient: 2 (network/rate limit issues are often self-resolving)
 * - execution: 0 (routes to handoff regeneration instead)
 * - structural: 0 (escalates immediately — human action required)
 * - unknown: 1 (one cautious retry before escalating)
 */
export function getMaxRetries(category: FailureCategory): number {
  switch (category) {
    case 'transient':
      return 2;
    case 'execution':
      return 0;
    case 'structural':
      return 0;
    case 'unknown':
      return 1;
  }
}

/**
 * Returns the recovery action for a given failure category.
 * - transient: 'retry' — retry the same execution
 * - execution: 'regenerate' — regenerate the handoff and re-execute
 * - structural: 'escalate' — notify human immediately
 * - unknown: 'retry-then-escalate' — retry once, then escalate if still failing
 */
export function getRecoveryAction(
  category: FailureCategory
): 'retry' | 'regenerate' | 'escalate' | 'retry-then-escalate' {
  switch (category) {
    case 'transient':
      return 'retry';
    case 'execution':
      return 'regenerate';
    case 'structural':
      return 'escalate';
    case 'unknown':
      return 'retry-then-escalate';
  }
}
```

### Step 3: Verification

```bash
# Type-check the entire project — must pass with zero errors
npx tsc --noEmit

# Build the project
npm run build
```

If `tsc --noEmit` reports errors related to the new `failureCategory` field on `WorkItem` (e.g., existing code that spreads or constructs `WorkItem` objects), those errors are pre-existing or caused by a strict partial-object check. Since the field is optional (`?`), no existing code should need updates. If errors appear in unrelated files, note them but do not fix them — they are out of scope.

If the build fails for reasons unrelated to the two files changed here, escalate rather than attempting broad fixes.

### Step 4: Commit, push, open PR

```bash
git add lib/types.ts lib/failure-classifier.ts
git commit -m "feat: add FailureCategory type and failure classifier utility (C1)"
git push origin feat/failure-categorization-types-and-classifier
gh pr create \
  --title "feat: add failure categorization types and classifier utility (C1)" \
  --body "## Summary

Adds foundational failure categorization infrastructure to Agent Forge. This is C1 of the failure recovery feature — all subsequent components depend on these exports.

## Changes

### \`lib/types.ts\`
- Added \`FailureCategory\` type: \`'transient' | 'execution' | 'structural' | 'unknown'\`
- Extended \`WorkItem\` interface with optional \`failureCategory?: FailureCategory\` field

### \`lib/failure-classifier.ts\` (new file)
- \`classifyFailure(errorOutput, exitCode?)\` — pattern-matching classifier; checks structural → transient → execution → unknown
- \`getMaxRetries(category)\` — returns retry budget per category (transient: 2, execution: 0, structural: 0, unknown: 1)
- \`getRecoveryAction(category)\` — returns recovery strategy per category

## Acceptance Criteria
- [x] \`FailureCategory\` type exported from \`lib/types.ts\` with four values
- [x] \`WorkItem\` interface has optional \`failureCategory\` field
- [x] \`classifyFailure\` correctly categorizes API timeouts as transient, 401/403 as structural, tsc/test failures as execution, unrecognized errors as unknown
- [x] \`getMaxRetries\` returns 2/0/0/1 for transient/execution/structural/unknown
- [x] \`getRecoveryAction\` returns correct action per category
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "feat: partial - failure categorization types and classifier (C1)"
git push origin feat/failure-categorization-types-and-classifier
gh pr create --title "feat: failure categorization C1 (partial)" --body "Partial implementation — see ISSUES below."
```

2. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/failure-categorization-types-and-classifier
FILES CHANGED: lib/types.ts, lib/failure-classifier.ts
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., tsc errors to resolve, missing exports]
```

## Escalation Protocol

If you encounter an unresolvable blocker (e.g., `lib/types.ts` does not exist or `WorkItem` is defined differently than expected, build system issues, ambiguous type conflicts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "c1-failure-categorization-types-and-classifier",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/failure-classifier.ts"]
    }
  }'
```