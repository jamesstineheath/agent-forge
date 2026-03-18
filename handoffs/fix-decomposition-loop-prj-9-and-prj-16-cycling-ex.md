<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix Decomposition Loop: PRJ-9 and PRJ-16 Cycling Execute→Executing

## Metadata
- **Branch:** `fix/decomposition-loop-quality-gate`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts, lib/decomposer.ts

## Context

Two projects — PRJ-9 ("PA Real Estate Agent v2") and PRJ-16 ("Phase 2e-4: Intent Validation") — are caught in a silent infinite loop:

1. ATC detects project status = "Execute"
2. ATC transitions project to "Executing" in Notion
3. Decomposer runs, hits the Plan Quality Gate (added in `A6: Plan Quality Gate in ATC`, merged 2026-03-17)
4. Quality gate rejects the project's plan (likely because PRJ-9 has a human-authored plan rather than a PM-agent-generated one)
5. Error handler silently resets Notion status back to "Execute"
6. Next ATC cycle (5 min later) repeats steps 1–5

PRJ-9 has been looping 9+ times since 05:20Z on 2026-03-18. PRJ-16 looped twice at 06:05Z and 06:10Z. No work items have been created for either project.

The `33cd8e29` self-referencing dependency fix is merged and is not the cause. The root cause is the Plan Quality Gate silently resetting status without surfacing the failure or making projects observable.

**What needs to happen:**
1. **Stop the silent loop** — when the quality gate rejects a plan, the project must not quietly reset to Execute. It should transition to a visible terminal or blocked state.
2. **Add proper error logging** so the reason for rejection is observable.
3. **Add a bypass mechanism** so projects with valid human-authored plans (not PM-agent plans) can proceed through decomposition without being blocked by the quality gate.
4. **Ensure PRJ-9 and PRJ-16 can proceed** — either by bypassing the gate or by generating the required structure.

## Requirements

1. When the Plan Quality Gate rejects a project's plan, log a structured error message explaining exactly which checks failed.
2. When the quality gate rejects, transition the project to `"Blocked"` state (or `"Failed"` if Blocked is unavailable) — **never** silently reset to `"Execute"`.
3. Add a bypass flag mechanism: if a Notion project page has a property `"Skip Quality Gate"` (checkbox, truthy) OR if the ATC logic detects no PM-agent plan exists but a human plan body is present, skip the quality gate and proceed to decomposition.
4. The fix must not break projects that legitimately require PM-agent plan validation.
5. Add a dedup guard or max-retry counter so that even if the above fixes have a gap, a project cannot loop more than 3 times before being forced into a blocked/failed state.
6. TypeScript must compile with no errors (`npx tsc --noEmit`).
7. Existing tests must pass (`npm test`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/decomposition-loop-quality-gate
```

### Step 1: Read and understand the current quality gate implementation

Read `lib/atc.ts` in full, paying close attention to:
- Section 14 (Plan Quality Gate) — what conditions it checks, what it returns on failure
- How the ATC handles the decomposer's return value / thrown errors
- How the project status reset to "Execute" happens on error
- Whether there is any existing logging on quality gate rejection

Also read `lib/decomposer.ts` to understand:
- The `validatePlan` function (if present) and what it checks
- How it signals failure back to the caller
- Whether it throws or returns an error object

Also check `lib/types.ts` for the `WorkItem`, `Project`, and related types to understand what status values are available (specifically whether `"Blocked"` or `"Failed"` are valid project statuses).

Also check `lib/projects.ts` for how project status transitions work (what function to call to transition to failed/blocked).

Take notes on:
- Exact line numbers where quality gate rejection occurs
- Exact line numbers where status is reset to Execute in the catch block
- What the current logging looks like (or doesn't)
- What Notion properties are read for the plan quality gate

### Step 2: Add structured error logging to the quality gate rejection path

In `lib/atc.ts`, find the quality gate section (Section 14). When the gate rejects:

**Before (likely something like):**
```typescript
// Quality gate fails — reset to Execute
await notionClient.updateProjectStatus(projectId, "Execute");
continue;
```

**After:**
```typescript
const rejectionReason = `Plan quality gate rejected project ${projectId} (${projectName}). ` +
  `Checks failed: ${failedChecks.join(", ")}. ` +
  `Project will be transitioned to Failed to prevent infinite loop. ` +
  `If this project has a human-authored plan, set the 'Skip Quality Gate' Notion property to bypass.`;
console.error(`[ATC §14 Quality Gate] ${rejectionReason}`);
```

Adapt the variable names (`failedChecks`, `projectName`, etc.) to whatever is actually present in the code. The key requirement is that the log message includes:
- Which project (ID + name)
- Which specific checks failed
- Instructions on how to bypass

### Step 3: Transition rejected projects to Failed instead of resetting to Execute

In the same quality gate rejection path, replace the status reset to Execute with a transition to Failed (or Blocked if that's a valid status).

Find the relevant project transition function in `lib/projects.ts`. It will likely be something like `transitionProjectToFailed(projectId, reason)` or a generic `updateProjectStatus(projectId, status)`.

Change the rejection handler to:

```typescript
// Instead of: await updateNotionProjectStatus(projectId, "Execute");
// Do:
await transitionProjectToFailed(
  projectId,
  `Plan quality gate rejection: ${failedChecks.join(", ")}. ` +
  `Set 'Skip Quality Gate' Notion checkbox to bypass for human-authored plans.`
);
```

If there's no dedicated `transitionProjectToFailed` function, use whatever mechanism is used elsewhere in `atc.ts` to fail a project. Check how Section 13b handles project failure for the pattern to follow.

### Step 4: Add a "Skip Quality Gate" bypass mechanism

In `lib/atc.ts` Section 14, before running quality gate checks, add logic to check for a bypass flag.

First, understand how Notion properties are read in the codebase. Look for how the ATC already reads project properties from Notion (there will be existing property reads for things like plan URL, PM agent status, etc.).

Add a bypass check:

```typescript
// Check if project has bypass flag set
const skipQualityGate = await getNotionProjectProperty(projectId, "Skip Quality Gate");
if (skipQualityGate === true || skipQualityGate === "true") {
  console.log(`[ATC §14] Project ${projectId} has 'Skip Quality Gate' set — bypassing plan quality gate.`);
  // Proceed directly to decomposition
} else {
  // Run existing quality gate checks
  // ... existing quality gate logic ...
}
```

**If reading a new Notion property is complex** (requires schema changes, etc.), use an alternative simpler bypass: check if `validatePlan` returns a specific "no PM plan exists but human plan present" indicator, and auto-bypass in that case. Adapt based on what you see in the actual code.

**Fallback bypass approach** (if Notion property approach is too complex): Add an in-memory set or config array `QUALITY_GATE_EXEMPT_PROJECTS` in `lib/atc.ts`:

```typescript
// Projects with human-authored plans that predate the PM quality gate
// Remove entries once they have a proper PM-agent plan or are completed
const QUALITY_GATE_EXEMPT_PROJECTS = new Set([
  "PRJ-9",  // PA Real Estate Agent v2 — human-authored plan
  // Add others as needed
]);
```

Then in the quality gate section:
```typescript
if (QUALITY_GATE_EXEMPT_PROJECTS.has(projectId) || QUALITY_GATE_EXEMPT_PROJECTS.has(projectName)) {
  console.log(`[ATC §14] Project ${projectId} is exempt from quality gate — proceeding to decomposition.`);
  // skip gate
}
```

Check how project IDs are represented (they may be Notion UUIDs not "PRJ-9" labels) and adapt accordingly.

### Step 5: Add loop-detection dedup guard

In `lib/atc.ts`, find where the ATC tracks active executions or dedup guards (search for `dedup`, `guard`, `executing`, or the ATC state blob key). There is already a dedup system based on the `§13a` description in CLAUDE.md.

Add a counter-based loop breaker. When a project transitions Execute→Executing, increment a counter stored in the ATC state. If the counter exceeds 3 (three failed decomposition attempts), force-transition the project to Failed:

```typescript
// In the Execute→Executing transition section:
const loopKey = `decomp-attempts-${projectId}`;
const currentAttempts = (atcState[loopKey] ?? 0) + 1;
atcState[loopKey] = currentAttempts;

if (currentAttempts > 3) {
  console.error(`[ATC Loop Guard] Project ${projectId} has attempted decomposition ${currentAttempts} times without success. Forcing to Failed.`);
  await transitionProjectToFailed(projectId, `Decomposition loop detected after ${currentAttempts} attempts. Check ATC logs for rejection reason.`);
  delete atcState[loopKey];
  continue;
}
```

Clear the counter when decomposition succeeds (work items are created):
```typescript
// After successful decomposition:
delete atcState[`decomp-attempts-${projectId}`];
```

Adapt to the actual ATC state structure — look at how other counters/guards are stored in the ATC blob state.

### Step 6: Verify the error path for PRJ-16 as well

PRJ-16 ("Phase 2e-4: Intent Validation") looped twice at 06:05Z and 06:10Z. It is a new project. The same quality gate fix should cover it. Verify that:
- The bypass mechanism (Step 4) does NOT exempt PRJ-16 unless it genuinely needs it (PRJ-16 is new and may just need a proper PM-agent plan)
- The loop-detection guard (Step 5) will catch PRJ-16 after 3 attempts if its plan is truly invalid
- The error logging (Step 2) will surface the specific reason PRJ-16 is being rejected

Do not add PRJ-16 to any hardcoded exempt list — it should either pass the quality gate with a proper plan or fail visibly.

### Step 7: Review the full diff for correctness

After making all changes, read through the modified sections of `lib/atc.ts` and `lib/decomposer.ts` carefully:

1. Confirm no infinite loop can still occur — the catch block no longer resets to Execute
2. Confirm the bypass path actually reaches decomposition (not just skips and continues without doing anything)
3. Confirm TypeScript types are correct (no `any` casts unless already present in the file)
4. Confirm the dedup counter is properly persisted (written back to blob state)

### Step 8: Verification
```bash
# Type check
npx tsc --noEmit

# Run tests
npm test

# If build check is needed
npm run build
```

Fix any TypeScript errors before proceeding. If tests are failing due to missing mocks for new Notion property reads, add appropriate mock values in the test files.

### Step 9: Commit, push, open PR
```bash
git add -A
git commit -m "fix: stop quality gate loop — fail loudly instead of cycling Execute→Executing

- Transition projects to Failed when quality gate rejects (not silent reset to Execute)
- Add structured error logging showing which quality gate checks failed
- Add bypass mechanism for human-authored plans (QUALITY_GATE_EXEMPT_PROJECTS / Skip Quality Gate property)
- Add loop-detection guard: force-fail after 3 failed decomposition attempts
- Fixes PRJ-9 (9+ loop cycles since 05:20Z 2026-03-18) and PRJ-16 (2 cycles)

Root cause: A6 Plan Quality Gate (merged 2026-03-17) silently resets status to
Execute on rejection, causing infinite 5-minute ATC cycles with no observability."

git push origin fix/decomposition-loop-quality-gate

gh pr create \
  --title "fix: stop decomposition loop — quality gate fails loudly, not silently" \
  --body "## Problem

PRJ-9 has been looping Execute→Executing every ~5 minutes since 05:20Z 2026-03-18 (9+ cycles). PRJ-16 looped twice at 06:05Z/06:10Z. No work items created. The A6 Plan Quality Gate (merged 2026-03-17) silently resets status to Execute on rejection, making this completely invisible without log diving.

## Root Cause

\`lib/atc.ts\` Section 14 (Plan Quality Gate) catches rejection and resets Notion to Execute. Next ATC cycle sees Execute and tries again. No error is logged. No terminal state is set.

## Changes

- **Silent loop → loud failure**: Quality gate rejection now transitions project to Failed with a human-readable explanation, instead of resetting to Execute
- **Bypass mechanism**: Projects with human-authored plans (predating PM quality gate) can be marked exempt via \`QUALITY_GATE_EXEMPT_PROJECTS\` set in ATC or \`Skip Quality Gate\` Notion property
- **Loop-detection guard**: After 3 failed decomposition attempts, force-transition to Failed regardless of cause
- **Structured error logging**: Quality gate rejection logs which specific checks failed and how to resolve

## Testing

- TypeScript compiles cleanly
- Existing tests pass
- PRJ-9 and PRJ-16 will no longer loop after this deploys

## Risk

Medium — changes the error handling path for quality gate rejection. The new behavior (fail loudly) is strictly better than the old behavior (silent loop). No happy-path decomposition logic is changed." \
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
BRANCH: fix/decomposition-loop-quality-gate
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If you cannot determine how to read Notion project properties, cannot find where the quality gate rejects, or the ATC state structure is too complex to add a counter safely:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-decomposition-loop-quality-gate",
    "reason": "Cannot determine safe location to add loop guard or quality gate bypass — ATC state structure unclear or quality gate section not found at expected location",
    "confidenceScore": 0.25,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts", "lib/decomposer.ts"]
    }
  }'
```