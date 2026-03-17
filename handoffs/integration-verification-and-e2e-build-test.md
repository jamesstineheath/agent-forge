# Agent Forge -- Integration Verification and E2E Build Test

## Metadata
- **Branch:** `feat/integration-verification-e2e-build-test`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc.ts, lib/projects.ts, lib/notion.ts, lib/work-items.ts

## Context

Recent work added the `writeOutcomeSummary` function to `lib/projects.ts` and integrated it into ATC Section 13b (project completion detection). The integration touches three files: `lib/atc.ts`, `lib/projects.ts`, and `lib/notion.ts`. This task verifies the full integration is coherent, type-safe, and that the Next.js production build passes cleanly.

Key data flow:
- ATC Section 13b detects project completion → calls `writeOutcomeSummary(projectId, status, workItems)`
- `writeOutcomeSummary` in `lib/projects.ts` → builds markdown template → calls `appendPageContent` from `lib/notion.ts`
- `writeOutcomeSummary` also calls `listWorkItems` from `lib/work-items.ts` to gather work item data

The markdown templates must include:
- **Complete projects**: Outcome Summary header, Status, Duration, Work Items count, Merged PRs section
- **Failed projects**: Recovery Assessment section with Retry/Re-plan/Abandon recommendation

The try/catch in ATC must wrap the `writeOutcomeSummary` call so that a failure does not abort Section 13b project completion logic.

No modifications are expected unless the verification steps reveal type errors or build failures that need to be fixed.

## Requirements

1. `npx tsc --noEmit` passes with zero errors across the entire project
2. `npm run build` completes successfully with no build errors
3. `lib/atc.ts` correctly imports `writeOutcomeSummary` from `lib/projects.ts` and calls it within a try/catch in Section 13b
4. `lib/projects.ts` correctly imports `appendPageContent` from `lib/notion.ts` and `listWorkItems` from `lib/work-items.ts`
5. The Complete template markdown in `writeOutcomeSummary` includes: Outcome Summary header, Status, Duration, Work Items count, and Merged PRs section
6. The Failed template markdown in `writeOutcomeSummary` includes a Recovery Assessment section with Retry/Re-plan/Abandon recommendation
7. The try/catch in ATC Section 13b ensures `writeOutcomeSummary` failures are logged but do not prevent the project completion transition

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/integration-verification-e2e-build-test
```

### Step 1: Inspect the import chain

Verify the import chain by reading each file:

```bash
# Check writeOutcomeSummary exists in projects.ts and has the right signature
grep -n "writeOutcomeSummary" lib/projects.ts

# Check atc.ts imports writeOutcomeSummary from projects.ts
grep -n "writeOutcomeSummary" lib/atc.ts

# Check the import statement in atc.ts
grep -n "from.*projects" lib/atc.ts

# Check projects.ts imports appendPageContent from notion.ts
grep -n "appendPageContent" lib/projects.ts
grep -n "from.*notion" lib/projects.ts

# Check projects.ts imports listWorkItems from work-items.ts
grep -n "listWorkItems" lib/projects.ts
grep -n "from.*work-items" lib/projects.ts
```

If any import is missing, add it. The expected import in `lib/atc.ts`:
```typescript
import { writeOutcomeSummary } from './projects';
// or as part of a destructured import from the same file
```

The expected imports in `lib/projects.ts`:
```typescript
import { appendPageContent } from './notion';
import { listWorkItems } from './work-items';
```

### Step 2: Verify the try/catch wrapping in ATC Section 13b

Read the Section 13b area of `lib/atc.ts`:
```bash
grep -n -A 20 "writeOutcomeSummary\|Section 13b\|13b\|project completion" lib/atc.ts | head -80
```

The call must be wrapped in a try/catch. If it is not, fix it:

```typescript
// CORRECT pattern — writeOutcomeSummary failure must not abort completion logic
try {
  await writeOutcomeSummary(projectId, finalStatus, workItems);
} catch (err) {
  console.error(`[ATC §13b] writeOutcomeSummary failed for project ${projectId}:`, err);
}
```

If the code already has this pattern, no change is needed.

### Step 3: Verify the Complete template markdown

Read `lib/projects.ts` and find the markdown template for Complete projects. It must include all of:

1. An `## Outcome Summary` (or similar) header
2. A `Status` field (e.g., `**Status:** Complete`)
3. A `Duration` field (e.g., `**Duration:** X days`)
4. A `Work Items` count field (e.g., `**Work Items:** N total, N merged`)
5. A `## Merged PRs` section (or equivalent listing of merged PRs)

```bash
# Inspect the template
grep -n -A 60 "writeOutcomeSummary\|Outcome Summary\|Complete\|markdown\|template" lib/projects.ts | head -100
```

If any required section is missing, add it to the template. Example Complete template:

```typescript
const completeSummary = `
## Outcome Summary

**Status:** Complete  
**Duration:** ${durationDays} days  
**Work Items:** ${totalCount} total, ${mergedCount} merged  
**Completed:** ${new Date().toISOString().split('T')[0]}

## Merged PRs

${mergedItems.map(item => `- ${item.title} (#${item.prNumber ?? 'N/A'})`).join('\n')}
`;
```

### Step 4: Verify the Failed template includes Recovery Assessment

The Failed project markdown template must include a Recovery Assessment section with explicit Retry/Re-plan/Abandon options:

```bash
grep -n "Recovery\|Retry\|Re-plan\|Abandon\|Failed\|failed" lib/projects.ts | head -30
```

If the Recovery Assessment section is missing from the Failed template, add it:

```typescript
const failedSummary = `
## Outcome Summary

**Status:** Failed  
**Duration:** ${durationDays} days  
**Work Items:** ${totalCount} total, ${mergedCount} merged, ${failedCount} failed  
**Failed:** ${new Date().toISOString().split('T')[0]}

## Failed Work Items

${failedItems.map(item => `- ${item.title}`).join('\n')}

## Recovery Assessment

Recommended action:
- **Retry**: Re-queue failed work items if the failures were transient
- **Re-plan**: Revise the plan if the approach needs rethinking
- **Abandon**: Close the project if the goal is no longer valid
`;
```

### Step 5: Run type-checking

```bash
npx tsc --noEmit
```

If there are type errors, fix them. Common issues to look for:

- `writeOutcomeSummary` signature mismatch between declaration in `lib/projects.ts` and call site in `lib/atc.ts`
- `appendPageContent` function not exported from `lib/notion.ts`
- `listWorkItems` function not exported from `lib/work-items.ts`
- Missing `async` on `writeOutcomeSummary` if it uses `await`

For each error, locate the file and line, read the surrounding context, and apply the minimal fix needed.

### Step 6: Run the production build

```bash
npm run build
```

If the build fails:
- Read the error output carefully
- If it's a type error already caught in Step 5, it should be resolved
- If it's a missing module or import error, fix the import
- If it's a Next.js-specific error (e.g., server component boundary), apply the minimal fix

### Step 7: Final verification pass

After all fixes are applied (if any), run the full verification suite:

```bash
# Type check
npx tsc --noEmit

# Production build
npm run build
```

Both must exit with code 0.

### Step 8: Commit, push, open PR

If no changes were needed (everything already passes):
```bash
git add -A
git commit -m "chore: verify integration of outcome summary feature — build passes, types clean"
git push origin feat/integration-verification-e2e-build-test
gh pr create \
  --title "chore: integration verification and E2E build test for outcome summary feature" \
  --body "## Summary

Verification pass for the outcome summary integration across \`lib/atc.ts\`, \`lib/projects.ts\`, and \`lib/notion.ts\`.

## Verification Results

- \`npx tsc --noEmit\`: ✅ zero errors
- \`npm run build\`: ✅ successful

## Import Chain Verified

- \`lib/atc.ts\` → imports \`writeOutcomeSummary\` from \`lib/projects.ts\` ✅
- \`lib/projects.ts\` → imports \`appendPageContent\` from \`lib/notion.ts\` ✅
- \`lib/projects.ts\` → imports \`listWorkItems\` from \`lib/work-items.ts\` ✅

## Template Verification

- Complete template includes: Outcome Summary header, Status, Duration, Work Items count, Merged PRs section ✅
- Failed template includes: Recovery Assessment with Retry/Re-plan/Abandon recommendation ✅

## ATC Robustness

- \`writeOutcomeSummary\` call in Section 13b is wrapped in try/catch ✅"
```

If changes were needed:
```bash
git add -A
git commit -m "fix: resolve type/build issues in outcome summary integration"
git push origin feat/integration-verification-e2e-build-test
gh pr create \
  --title "fix: resolve integration issues in outcome summary feature (atc → projects → notion)" \
  --body "## Summary

Integration verification pass for the outcome summary feature. Found and fixed issues to ensure the build pipeline passes cleanly.

## Changes Made

<!-- List what was fixed -->

## Verification Results

- \`npx tsc --noEmit\`: ✅ zero errors
- \`npm run build\`: ✅ successful

## Import Chain Verified

- \`lib/atc.ts\` → imports \`writeOutcomeSummary\` from \`lib/projects.ts\` ✅
- \`lib/projects.ts\` → imports \`appendPageContent\` from \`lib/notion.ts\` ✅
- \`lib/projects.ts\` → imports \`listWorkItems\` from \`lib/work-items.ts\` ✅"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/integration-verification-e2e-build-test
FILES CHANGED: [list of files modified]
SUMMARY: [what was verified/fixed]
ISSUES: [what failed or remains unclear]
NEXT STEPS: [what remains to be done]
```

If you encounter an unresolvable blocker (e.g., `appendPageContent` does not exist in `lib/notion.ts` and its correct signature is unknown, or `listWorkItems` has an unexpected API), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "integration-verification-e2e-build-test",
    "reason": "<describe the specific missing export or type mismatch>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<exact error message from tsc or build>",
      "filesChanged": ["lib/atc.ts", "lib/projects.ts", "lib/notion.ts"]
    }
  }'
```