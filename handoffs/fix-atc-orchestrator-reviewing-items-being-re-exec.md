<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix ATC Orchestrator: Reviewing Items Being Re-executed and Parked

## Metadata
- **Branch:** `fix/atc-reviewing-items-reparked`
- **Priority:** high
- **Model:** opus
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** high
- **Estimated files:** lib/atc.ts, lib/work-items.ts

## Context

CRITICAL BUG: The ATC orchestrator (`lib/atc.ts`) is repeatedly parking work items that have successfully-executed PRs with fully green CI. The pipeline is frozen — ~10 PRs have accumulated (#169, #170, #175, #176, #178, #180, #182, #184, #188, #190) that are all open with green CI but never merged.

**Observed pattern (every ~30 minutes since 08:05Z on 2026-03-17):**
1. Work item reaches "reviewing" with a PR open and passing CI
2. ATC re-executes the item (re-dispatches), treating it as if it never ran
3. After 2 retries, item is parked with outcome "parked"
4. Original PR remains open, never merged

Items 241ace15 (PR #188, green CI) and ec7de56c (PR #190, green CI) were reset to "ready" by ATC despite having open PRs with green CI.

**Root cause hypothesis:** In `lib/atc.ts`, the reviewing-phase logic is not correctly detecting that a PR already exists with green CI before applying retry/park logic. The `retryCount` check likely fires unconditionally, without first checking whether the PR exists and CI is green.

The fix must ensure: **if a work item has `status=reviewing` AND has a stored `prNumber` AND that PR's CI is green → proceed to MERGE, not re-execute or park.**

The `retryCount` / park logic should only apply when execution actually failed (no PR, or CI is red/failed), never when a PR sits open with green CI.

## Requirements

1. Read `lib/atc.ts` fully — understand the reviewing-phase logic, where `retryCount` is checked, and where the park/re-execute decision is made.
2. Read `lib/work-items.ts` — understand the WorkItem type shape (`prNumber`, `retryCount`, `status`, etc.).
3. Read `lib/github.ts` — understand how PR CI status is checked (function signatures for getting PR checks/status).
4. Fix the reviewing-stage logic: **Before** any retryCount check or park/re-execute decision, check if `workItem.prNumber` is set and CI on that PR is green. If so, trigger merge (or transition to merge-ready state) and skip the retry/park path entirely.
5. The `retryCount` gate and park logic must only fire when the item genuinely failed execution (no PR number stored, or CI is explicitly red/failed).
6. Do not break any other ATC sections (§2.8 reconciliation, §13a stuck-executing recovery, §13b project completion detection).
7. Add clear inline comments explaining the guard so future developers understand the intent.
8. The fix must compile cleanly (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/atc-reviewing-items-reparked
```

### Step 1: Read and understand the codebase

Read these files in full before writing any code:

```bash
cat lib/atc.ts
cat lib/work-items.ts
cat lib/github.ts
cat lib/types.ts
```

Pay careful attention to:
- The reviewing-phase section of the ATC (search for "reviewing", "retryCount", "park", "prNumber")
- The order of checks: does it check `prNumber`/CI-green BEFORE checking `retryCount`?
- How PR CI status is determined (what function is called, what values it returns)
- The WorkItem type definition — fields like `prNumber`, `retryCount`, `status`, `outcome`

### Step 2: Identify the exact bug location

Search for the reviewing logic:

```bash
grep -n "reviewing\|retryCount\|prNumber\|park\|re-execut\|re-dispatch\|CI\|checks\|merge" lib/atc.ts | head -80
```

The bug is almost certainly in a block that:
1. Picks up items with `status === "reviewing"`
2. Checks `retryCount` or some failure condition
3. Either re-dispatches or parks — **without first checking** if `prNumber` is set and CI is green

### Step 3: Implement the fix

The fix pattern to apply in the reviewing-stage logic of `lib/atc.ts`:

**BEFORE (broken pattern — pseudocode):**
```typescript
// Reviewing items
for (const item of reviewingItems) {
  if (item.retryCount >= MAX_RETRIES) {
    // park it
    await updateWorkItem({ ...item, status: "parked", outcome: "parked" });
    continue;
  }
  // re-execute / re-dispatch
  await dispatchWorkItem(item);
}
```

**AFTER (fixed pattern — pseudocode):**
```typescript
// Reviewing items
for (const item of reviewingItems) {
  // GUARD: If a PR already exists with green CI, proceed to merge — do NOT
  // re-execute or apply retry/park logic. This is the success path.
  if (item.prNumber) {
    const ciStatus = await getPRCIStatus(item.prNumber, item.repoFullName /* or however repo is determined */);
    if (ciStatus === "success" || ciStatus === "green") {
      // Trigger auto-merge or transition to merge-ready
      // Use the existing merge mechanism already in the ATC
      await triggerMerge(item); // use the actual function name from the codebase
      continue;
    }
    // CI is pending or failed — fall through to retry logic below
    if (ciStatus === "pending") {
      // Still waiting — do nothing this cycle
      continue;
    }
    // CI failed — fall through to retry/park logic
  }

  // Only reach here if: no prNumber (execution never produced a PR)
  // OR prNumber exists but CI is explicitly failed
  if (item.retryCount >= MAX_RETRIES) {
    await updateWorkItem({ ...item, status: "parked", outcome: "parked" });
    continue;
  }
  // Re-execute
  await dispatchWorkItem(item);
}
```

**Important:** Use the actual function names, variable names, and patterns from the real codebase. The pseudocode above illustrates the logic — adapt it to what you find in `lib/atc.ts`.

Key things to verify in the real implementation:
- What function checks PR CI status? (likely in `lib/github.ts` — look for `getCheckRuns`, `getCombinedStatus`, `getPRChecks`, or similar)
- What is the "green" CI value? (`"success"`, `"passed"`, etc.)
- How is the repo full name determined for a work item? (likely `item.repoFullName` or a registered repo lookup)
- What is the existing merge trigger? (likely an API call or status transition — look for "merge" in `lib/atc.ts`)
- What is `MAX_RETRIES`? (likely 2 or 3 — find the constant)

### Step 4: Verify §2.8 reconciliation is not broken

The §2.8 reconciliation already handles "failed" items that actually have merged PRs. Make sure your fix in the reviewing-stage does not conflict with §2.8. The reviewing-stage fix applies to `status === "reviewing"` items; §2.8 applies to `status === "failed"` items. They should not overlap.

```bash
grep -n "2\.8\|reconcil\|failed.*prNumber\|prNumber.*failed" lib/atc.ts | head -20
```

### Step 5: Check for any existing CI-green guard that may be broken

It's possible there IS a CI-green check already written but it has a bug (wrong field name, inverted condition, wrong CI status string). Look carefully:

```bash
grep -n "success\|green\|checks\|ciStatus\|checkStatus\|allGreen\|passed" lib/atc.ts | head -40
```

If the check exists but is broken, fix the existing check rather than adding a duplicate.

### Step 6: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 7: Manual logic trace

After the fix, mentally trace through the scenario that was failing:

1. Work item: `{ status: "reviewing", prNumber: 188, retryCount: 1 }`
2. CI on PR #188: green/success
3. ATC reviewing-stage runs
4. **Expected**: CI-green guard fires → merge triggered → item transitions to "merged" (or "reviewing" pending merge)
5. **Previously broken**: retryCount check fired → item parked

Confirm your fix produces the expected behavior for this trace.

Also trace the legitimate failure case:
1. Work item: `{ status: "reviewing", prNumber: null, retryCount: 1 }`
2. No PR was ever created (execution failed before opening PR)
3. **Expected**: retry/park logic fires as before
4. Confirm your fix does NOT block this path.

### Step 8: Verification

```bash
npx tsc --noEmit
npm run build
```

If `npm test` exists:
```bash
npm test
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "fix: guard ATC reviewing logic — merge PR with green CI instead of re-executing/parking

CRITICAL: ATC was parking work items with open PRs and green CI.
Root cause: retryCount/park logic fired before checking prNumber + CI status.

Fix: In reviewing-stage, check prNumber + CI status FIRST. If PR exists
with green CI, trigger merge and skip retry/park path entirely.
retryCount gate only applies when execution genuinely failed (no PR or red CI).

Fixes ~10 accumulated PRs: #169, #170, #175, #176, #178, #180, #182, #184, #188, #190"

git push origin fix/atc-reviewing-items-reparked

gh pr create \
  --title "fix: ATC reviewing items being re-executed and parked (green CI PRs now merge)" \
  --body "## Problem

CRITICAL: ATC orchestrator was parking work items with open PRs and fully green CI every ~30 minutes. ~10 PRs accumulated (#169, #170, #175, #176, #178, #180, #182, #184, #188, #190) — none merged, pipeline frozen.

**Pattern:**
1. Item reaches \`reviewing\` with PR open + green CI
2. ATC re-executes item (retryCount check fires unconditionally)
3. After 2 retries, item parked
4. Original PR never merged

## Root Cause

In \`lib/atc.ts\`, the reviewing-stage logic checked \`retryCount\` **before** checking whether a PR already existed with green CI. This caused the retry/park path to fire on successfully-executed items.

## Fix

In the reviewing-stage loop, added an early guard:
- **If** \`prNumber\` is set **AND** CI on that PR is green → trigger merge, skip retry/park entirely
- **If** \`prNumber\` is set but CI is pending → skip this cycle (wait)
- **If** no \`prNumber\` OR CI is failed → proceed to retry/park logic as before

## Testing

- TypeScript compiles cleanly
- Logic traced for both success case (green CI PR → merge) and failure case (no PR → retry/park)
- §2.8 reconciliation unaffected (operates on \`status=failed\` items, not \`reviewing\`)

## Risk

High — ATC is core pipeline logic. However, the fix is a targeted guard that adds the missing check before existing logic; the retry/park path is preserved for genuine failures."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/atc-reviewing-items-reparked
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was unclear]
NEXT STEPS: [what remains — e.g., "CI status check function name unclear, need to verify lib/github.ts getPRChecks return values"]
```

## Escalation

If you cannot determine the exact CI-check function signature, the merge trigger mechanism, or the reviewing-stage loop structure after reading the files, escalate immediately rather than guessing:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-atc-reviewing-reparked",
    "reason": "Cannot determine reviewing-stage loop structure or CI-check function signature in lib/atc.ts — need human guidance before modifying core ATC logic",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "3",
      "error": "Ambiguous code structure in reviewing-stage — risk of introducing new bug in core pipeline",
      "filesChanged": []
    }
  }'
```