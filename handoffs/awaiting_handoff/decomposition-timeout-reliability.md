# Decomposition Timeout Reliability

**Execution mode:** Autonomous
**Max Budget:** $5
**Target repo:** agent-forge

## Problem

The decomposition Supervisor phase times out on every cycle because:
1. The decomposition route exports `maxDuration = 120` (120s), overriding the project's 300s Fluid Compute default
2. The Supervisor coordinator sets a 115s HTTP timeout via `AbortSignal.timeout(phase.timeoutMs)` in the phase manifest
3. The Supervisor cron route itself has `maxDuration = 300` with a 280s coordinator budget, which can't accommodate a longer decomposition phase

<<<<<<< HEAD
Opus decomposition calls have highly variable latency (30s for simple PRDs, 3-5min for complex ones). The project has Fluid Compute enabled on Pro (supports up to 800s). Rather than guessing the right timeout, set generous ceilings and let existing telemetry (Supervisor phase log, cost tracking, pipeline scorecard) surface actual performance data. We'll tune down later if the data warrants it.
=======
Opus decomposition calls legitimately take 2-5 minutes for complex PRDs. The project has Fluid Compute enabled on Pro (supports up to 800s). The fix is aligning timeouts to allow decomposition the time it needs.
>>>>>>> 2467902 (handoff: decomposition-timeout-reliability)

Additionally, completed PRDs leave stale criteria and architecture plans in Blob storage, causing the decomposer to retry them indefinitely (it checks Blob, not Notion status).

## Step 0: Branch and Verify

```bash
git checkout -b fix/decomposition-timeout-reliability
git pull origin main --rebase
npx tsc --noEmit
```

<<<<<<< HEAD
## Step 1: Bump decomposition route maxDuration to ceiling

**File:** `app/api/agents/supervisor/phases/decomposition/route.ts`

Change `export const maxDuration = 120;` to `export const maxDuration = 800;`

This is the Vercel Pro + Fluid Compute ceiling. The function is I/O-bound (waiting on the Anthropic API), not CPU-bound, so cost impact is negligible. Existing phase log telemetry tracks actual duration.

## Step 2: Bump architecture-planning route maxDuration to ceiling

**File:** `app/api/agents/supervisor/phases/architecture-planning/route.ts`

Change `maxDuration` to `800` (same rationale: Opus API call with variable latency).

## Step 3: Bump Supervisor cron route maxDuration and budget

**File:** `app/api/agents/supervisor/cron/route.ts`

- Change `export const maxDuration = 300;` to `export const maxDuration = 800;`
- Change `const COORDINATOR_BUDGET_MS = 280_000;` to `const COORDINATOR_BUDGET_MS = 780_000;`

The coordinator needs enough headroom for a long decomposition phase plus all other phases.

## Step 4: Update phase manifest timeouts to match
=======
## Step 1: Bump decomposition route maxDuration

**File:** `app/api/agents/supervisor/phases/decomposition/route.ts`

Change `export const maxDuration = 120;` to `export const maxDuration = 300;`

## Step 2: Bump Supervisor cron route maxDuration and budget

**File:** `app/api/agents/supervisor/cron/route.ts`

- Change `export const maxDuration = 300;` to `export const maxDuration = 600;`
- Change `const COORDINATOR_BUDGET_MS = 280_000;` to `const COORDINATOR_BUDGET_MS = 560_000;`

## Step 3: Update phase manifest timeouts
>>>>>>> 2467902 (handoff: decomposition-timeout-reliability)

**File:** `lib/atc/supervisor-manifest.ts`

Update the decomposition entry:
<<<<<<< HEAD
- `maxDurationSeconds`: 120 → 780
- `timeoutMs`: 115_000 → 750_000

Update architecture-planning entry:
- `maxDurationSeconds`: 120 → 780
- `timeoutMs`: 115_000 → 750_000

Leave all other phase timeouts unchanged.

## Step 5: Add stale criteria cleanup to criteria-import phase
=======
- `maxDurationSeconds`: 120 → 300
- `timeoutMs`: 115_000 → 295_000

Also update architecture-planning (same Opus bottleneck):
- `maxDurationSeconds`: 120 → 300
- `timeoutMs`: 115_000 → 295_000

## Step 4: Add stale criteria cleanup to criteria-import phase
>>>>>>> 2467902 (handoff: decomposition-timeout-reliability)

**File:** `lib/atc/supervisor.ts`, in the `runCriteriaImport()` function

After the existing criteria import logic, add a cleanup step:

1. Call `listAllCriteria()` (from `@/lib/intent-criteria`) to get all criteria entries in Blob
2. For each entry, check its PRD status in Notion (the criteria object should have a `prdId`). Use the existing Notion API integration or the criteria entry's metadata to determine if the PRD is Complete, Paused, or Obsolete.
3. If the PRD is in a terminal status, delete:
   - The criteria blob (via the intent-criteria module's delete function, or `deleteJson` on the criteria key)
   - The architecture plan blob (via the architecture-planner module's delete function, or `deleteJson` on the plan key)
   - The decomposition dedup guard (`atc/project-decomposed/prd-{prdId}`)
4. Log the cleanup: `[supervisor §19] Cleaned up stale criteria for completed PRD "{title}"`
5. Add to decisions array: `Cleaned up stale criteria/plan for completed PRD "{title}"`

**Important:** To check Notion PRD status, use the existing `fetchPRDStatus` pattern from the criteria import code (it already queries Notion for approved PRDs). The cleanup should check for PRDs that are NOT in active statuses (Idea, Draft, In Review, Approved, Executing). Any other status means cleanup is safe.

Keep the cleanup bounded: max 3 cleanups per cycle to avoid timeout.

<<<<<<< HEAD
## Step 6: Verify and commit
=======
## Step 5: Verify and commit
>>>>>>> 2467902 (handoff: decomposition-timeout-reliability)

```bash
npx tsc --noEmit
git add -A
<<<<<<< HEAD
git commit -m "fix: set decomposition/arch-planning timeouts to Pro ceiling (800s)

- Decomposition route maxDuration: 120 → 800s (Fluid Compute ceiling)
- Architecture planning route maxDuration: → 800s
- Supervisor cron maxDuration: 300 → 800s
- Coordinator budget: 280s → 780s
- Phase manifest timeouts aligned to ceiling
- Criteria import now cleans up stale criteria/plans for completed PRDs
- Actual durations tracked via existing phase log telemetry"
=======
git commit -m "fix: bump decomposition timeout to 300s, add stale criteria cleanup

- Decomposition route maxDuration: 120 → 300s
- Supervisor cron maxDuration: 300 → 600s  
- Coordinator budget: 280s → 560s
- Phase manifest decomposition timeout: 115s → 295s
- Architecture planning timeout: 115s → 295s
- Criteria import now cleans up stale criteria/plans for completed PRDs"
>>>>>>> 2467902 (handoff: decomposition-timeout-reliability)
git push origin fix/decomposition-timeout-reliability
```

## Abort Conditions
- If `tsc --noEmit` fails after changes, fix type errors before committing
- If the criteria cleanup requires imports that don't exist (e.g., no `deleteCriteria` function), use `deleteJson` directly with the blob key pattern from the existing code
- Do NOT modify the phase execution order in the manifest
- Do NOT change any other phase timeouts beyond decomposition and architecture-planning
