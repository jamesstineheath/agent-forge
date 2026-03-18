# Handoff 40: extract-dispatcher-health-monitor

## Metadata
- Branch: `feat/extract-dispatcher-health-monitor`
- Priority: high
- Model: opus
- Type: refactor
- Max Budget: $8
- Risk Level: medium
- Complexity: complex
- Depends On: None
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

The ATC (`lib/atc.ts`) is a 1,750-line monolith with 18 responsibilities in a single 1,360-line function. It's modified in 64% of recent PRs, causing cascading state machine bugs. This handoff extracts the two most volatile subsystems into independent agents with their own cron routes.

Current architecture: Single cron at `/api/atc/cron` every 5 minutes does everything.

Target: Two new independent agents with their own cron routes, plus a shared types/utils layer.

**Agent 1: Dispatcher** (`/api/agents/dispatcher/cron`, 5 min)
- Goal: Maximize throughput within concurrency limits
- Responsibilities: Index reconciliation (Phase 0), dispatch ready items (Phase 1), conflict detection, concurrency enforcement, active-work-items.md updates

**Agent 2: Health Monitor** (`/api/agents/health-monitor/cron`, 5 min)
- Goal: Every active execution progresses or gets unstuck
- Responsibilities: Poll active items (Phase 2), detect merges/failures/stalls, auto-rebase, retry failed items, reconcile failed items with merged PRs

Both agents share a CycleContext pattern and communicate through the work item blob store. The remaining ATC sections (project lifecycle, escalation, PM sweep, HLO, branch cleanup) stay in atc.ts for Handoff 41.

## Pre-flight Self-Check

- [ ] Confirm lib/atc.ts exists and contains _runATCCycleInner
- [ ] Confirm lib/atc/ directory does NOT exist yet
- [ ] Confirm vercel.json has only one cron entry currently
- [ ] Confirm no existing /api/agents/ routes exist

## Step 0: Branch, commit handoff, push

Create branch `feat/extract-dispatcher-health-monitor` from `main`. Commit this handoff file. Push.

## Step 1: Read the full ATC source

Read `lib/atc.ts`, `lib/types.ts`, `lib/storage.ts`, `lib/work-items.ts`, `lib/github.ts`, `app/api/atc/cron/route.ts`, `vercel.json` to understand exact code boundaries.

## Step 2: Create shared infrastructure

**`lib/atc/types.ts`** — CycleContext interface, all constants (LOCK_TTL_MS, CYCLE_TIMEOUT_MS, STALL_TIMEOUT_*, GLOBAL_CONCURRENCY_LIMIT, etc.), CycleTimeoutError, re-export HLOStateEntry.

**`lib/atc/utils.ts`** — parseEstimatedFiles(), hasFileOverlap(), HIGH_CHURN_FILES, makeEvent(), withTimeout().

**`lib/atc/lock.ts`** — acquireATCLock(), releaseATCLock().

**`lib/atc/events.ts`** — persistEvents(), getATCState(), getATCEvents(), getWorkItemEvents().

## Step 3: Create Dispatcher agent

`lib/atc/dispatcher.ts` — Extract Phase 0 (index reconciliation), Phase 1 (dispatch), active-work-items.md updates. Export `runDispatcher(ctx: CycleContext)`.

## Step 4: Create Health Monitor agent

`lib/atc/health-monitor.ts` — Extract Phase 2 (monitoring), §2.7 (merge conflict recovery), §2.8 (failed item reconciliation), stall/timeout detection, §3 (dependency management), §3.4 (auto-cancel obsolete), §3.5 (retry). Export `runHealthMonitor(ctx: CycleContext)`.

## Step 5: Create cron routes

`app/api/agents/dispatcher/cron/route.ts` and `app/api/agents/health-monitor/cron/route.ts`. Same auth as `/api/atc/cron`. Separate lock keys. Feature-flagged with `AGENT_SPLIT_ENABLED` env var.

## Step 6: Update vercel.json

Add both new crons. Keep original `/api/atc/cron` running in parallel. New agents are no-ops unless `AGENT_SPLIT_ENABLED=true`.

## Step 7: Update lib/atc.ts

Remove extracted sections, add re-exports for backward compatibility. Remaining sections: project lifecycle, escalation, PM sweep, HLO, branch cleanup.

## Step 8: Build and verify

`npx tsc --noEmit`, all imports resolve, feature flag works, old cron unchanged.

## Session Abort Protocol

If you cannot complete execution:
1. Commit WIP, push branch, open draft PR
2. Output structured status to stdout