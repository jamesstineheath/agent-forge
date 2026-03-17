# Agent Forge -- Integrate outcome summary into ATC Section 13 project completion

## Metadata
- **Branch:** `feat/atc-section13-outcome-summary`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

Agent Forge has a `writeOutcomeSummary` function in `lib/projects.ts` that writes project outcome summaries to Notion. This function was recently added but is not yet wired into the ATC (Air Traffic Controller) Section 13 project completion logic in `lib/atc.ts`.

ATC Section 13 handles project lifecycle terminal transitions:
- **Section 13a** — Stuck Executing Recovery: resets projects stuck in "Executing" with no work items back to "Execute" for re-decomposition. This is NOT a terminal transition.
- **Section 13b** — Project Completion Detection: when all work items for a project reach terminal state, auto-transitions to "Complete" (if any merged, none failed) or "Failed" (if any failed).

The goal is to call `writeOutcomeSummary` after each terminal transition in Section 13b so that Notion receives an outcome summary when projects finish. The summary write must be wrapped in try/catch so a Notion API failure cannot block the status transition itself.

The function signature from `lib/projects.ts` is:
```typescript
export async function writeOutcomeSummary(projectId: string, outcome: 'Complete' | 'Failed'): Promise<void>
```

## Requirements

1. Import `writeOutcomeSummary` from `lib/projects.ts` at the top of `lib/atc.ts` (add to existing import or create new import)
2. In Section 13b, after calling `transitionToComplete()` (or equivalent), invoke `writeOutcomeSummary(projectId, 'Complete')` wrapped in try/catch
3. In Section 13b, after calling `transitionToFailed()` (or equivalent), invoke `writeOutcomeSummary(projectId, 'Failed')` wrapped in try/catch
4. On successful summary write, log: `[ATC §13b] Outcome summary written for project ${projectId} → ${outcome}`
5. On summary write failure, log: `[ATC §13b] Failed to write outcome summary for project ${projectId}: ${error}`
6. Section 13a (Stuck Executing Recovery) must NOT trigger any `writeOutcomeSummary` call
7. `npx tsc --noEmit` passes with no new errors
8. `npm run build` succeeds

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-section13-outcome-summary
```

### Step 1: Inspect current lib/atc.ts Section 13 code

Read the file carefully to understand the exact structure of Section 13a and 13b before making changes:

```bash
grep -n "13\|transitionToComplete\|transitionToFailed\|writeOutcomeSummary\|Completion\|Stuck Executing" lib/atc.ts | head -60
```

Also check the existing imports at the top of `lib/atc.ts`:
```bash
head -30 lib/atc.ts
```

And verify the exact exported function names from `lib/projects.ts`:
```bash
grep -n "export" lib/projects.ts
```

### Step 2: Add writeOutcomeSummary import to lib/atc.ts

Locate the existing import from `lib/projects.ts` in `lib/atc.ts`. It likely looks something like:
```typescript
import { transitionToComplete, transitionToFailed, ... } from './projects';
```

Add `writeOutcomeSummary` to that import. If there is no existing import from `lib/projects.ts`, add a new import line:
```typescript
import { writeOutcomeSummary } from './projects';
```

### Step 3: Wire writeOutcomeSummary into Section 13b

Find the Section 13b block where terminal project transitions occur. After each call to `transitionToComplete(...)` and `transitionToFailed(...)`, add the try/catch summary write. The pattern should be:

**For Complete transition:**
```typescript
// existing call (do not change this)
await transitionToComplete(projectId /* or whatever args */);

// ADD: write outcome summary (non-blocking)
try {
  await writeOutcomeSummary(projectId, 'Complete');
  console.log(`[ATC §13b] Outcome summary written for project ${projectId} → Complete`);
} catch (summaryErr) {
  console.error(`[ATC §13b] Failed to write outcome summary for project ${projectId}: ${summaryErr}`);
}
```

**For Failed transition:**
```typescript
// existing call (do not change this)
await transitionToFailed(projectId /* or whatever args */);

// ADD: write outcome summary (non-blocking)
try {
  await writeOutcomeSummary(projectId, 'Failed');
  console.log(`[ATC §13b] Outcome summary written for project ${projectId} → Failed`);
} catch (summaryErr) {
  console.error(`[ATC §13b] Failed to write outcome summary for project ${projectId}: ${summaryErr}`);
}
```

**Important:** Adapt the `projectId` variable name to whatever is actually used in the Section 13b code. Do not change the logic of Section 13a — only Section 13b's terminal transition blocks should be modified.

### Step 4: Verify Section 13a is untouched

Confirm that Section 13a (Stuck Executing Recovery — the block that resets projects back to "Execute") has no `writeOutcomeSummary` calls:
```bash
grep -n "writeOutcomeSummary" lib/atc.ts
```

Visually verify that all occurrences are only in the Section 13b / terminal transition code paths and not in any reset/recovery logic.

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- Import path needing `.js` extension (check what other imports in the file use)
- `writeOutcomeSummary` parameter type mismatch (should be `string` and `'Complete' | 'Failed'`)

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: wire writeOutcomeSummary into ATC Section 13b project completion"
git push origin feat/atc-section13-outcome-summary
gh pr create \
  --title "feat: integrate outcome summary into ATC Section 13 project completion" \
  --body "## Summary

Wires \`writeOutcomeSummary\` from \`lib/projects.ts\` into ATC Section 13b (Project Completion Detection) in \`lib/atc.ts\`.

## Changes

- **\`lib/atc.ts\`**: Added import of \`writeOutcomeSummary\` from \`./projects\`. After each terminal project transition in Section 13b, calls \`writeOutcomeSummary(projectId, 'Complete')\` or \`writeOutcomeSummary(projectId, 'Failed')\` wrapped in try/catch so Notion API failures cannot block the status transition.

## Behaviour

- On project → Complete: writes outcome summary to Notion, logs success or failure
- On project → Failed: writes outcome summary to Notion, logs success or failure  
- Section 13a (Stuck Executing Recovery) is unchanged — no summary written for resets
- Notion API errors are caught and logged; they do not throw or affect the transition

## Verification

- \`npx tsc --noEmit\` passes
- \`npm run build\` succeeds"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-section13-outcome-summary
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., `writeOutcomeSummary` has a different signature than expected, Section 13b structure is significantly different from what's described, or TypeScript errors cannot be resolved after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "atc-section13-outcome-summary",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts"]
    }
  }'
```