# Handoff 49: decomposer-status-filter

## Metadata
- Branch: `fix/decomposer-status-filter`
- Priority: high
- Model: opus
- Type: bugfix
- Max Budget: $3
- Risk Level: low
- Complexity: simple
- Depends On: None
- Date: 2026-03-21
- Executor: Claude Code (GitHub Actions)

## Context

**Bug:** `runDecomposition()` (§22) and `runArchitecturePlanning()` (§21) in `lib/atc/supervisor.ts` iterate over all imported criteria via `listAllCriteria()` without checking the PRD's current status in Notion. This caused PA Real Estate v3 (Backlog, rank 460) to be decomposed into 19 work items on 2026-03-21. Any PRD with criteria in Blob storage + an architecture plan gets decomposed, regardless of whether it's Approved.

**Fix:** Both functions need a status guard using `fetchPRDStatus` from `@/lib/intent-criteria`. This function already exists and is used in `runCriteriaImport()` in the same file for stale criteria cleanup.

## Pre-flight Self-Check

If ANY of these fail, **abort immediately** and report via Session Abort Protocol.

- [ ] tsc --noEmit passes with no errors
- [ ] fetchPRDStatus is dynamically imported from @/lib/intent-criteria (same pattern as runCriteriaImport)
- [ ] Guard logs a skip message and continues, does not throw
- [ ] Only lib/atc/supervisor.ts is modified

## Step 0: Branch, commit handoff, push

Create branch `fix/decomposer-status-filter` from `main`. Commit this handoff file. Push.

## Step 1: In `runArchitecturePlanning()` (§21), inside the `for (const entry of criteriaEntries)` loop, after the existing `const existingPlan = await getArchitecturePlan(entry.prdId); if (existingPlan) continue;` block, add a status guard:
```typescript
// Only generate architecture plans for Approved or Executing PRDs
const { fetchPRDStatus } = await import("@/lib/intent-criteria");
const prdStatus = await fetchPRDStatus(entry.prdId);
if (prdStatus && prdStatus !== "Approved" && prdStatus !== "Executing") {
  console.log(`[supervisor §21] Skipping architecture planning for "${entry.prdTitle}" — PRD status is "${prdStatus}" (requires Approved or Executing)`);
  continue;
}
```

## Step 2: In `runDecomposition()` (§22), inside the `for (const entry of criteriaEntries)` loop, after the existing `const plan = await getArchitecturePlan(entry.prdId); if (!plan) continue;` block (before the dedup guard), add the same status guard:
```typescript
// Only decompose PRDs that are Approved or Executing
const { fetchPRDStatus } = await import("@/lib/intent-criteria");
const prdStatus = await fetchPRDStatus(entry.prdId);
if (prdStatus && prdStatus !== "Approved" && prdStatus !== "Executing") {
  console.log(`[supervisor §22] Skipping decomposition for "${entry.prdTitle}" — PRD status is "${prdStatus}" (requires Approved or Executing)`);
  continue;
}
```

## Step 3: Run `tsc --noEmit` to verify no type errors. Grep for `fetchPRDStatus` to confirm the import pattern matches the existing usage in `runCriteriaImport()`.

## Session Abort Protocol

If you cannot complete execution:
1. Commit current work as WIP: `git add -A && git commit -m "wip: decomposer-status-filter (incomplete)"`
2. Push the branch and open a draft PR
3. Output structured JSON to stdout:
```json
{
  "status": "aborted",
  "reason": "<why>",
  "branch": "fix/decomposer-status-filter",
  "completed_steps": [],
  "remaining_steps": [],
  "pr_url": "<if opened>"
}
```