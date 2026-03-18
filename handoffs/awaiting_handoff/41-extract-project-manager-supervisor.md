# Handoff 41: extract-project-manager-supervisor

## Metadata
- Branch: `feat/extract-pm-supervisor-v2`
- Priority: high
- Model: opus
- Type: refactor
- Max Budget: $8
- Risk Level: medium
- Complexity: complex
- Depends On: 40
- Date: 2026-03-18
- Executor: Claude Code (GitHub Actions)

## Context

Part 2 of ATC agent extraction. H40 extracted Dispatcher and Health Monitor. This extracts the remaining responsibilities into two more agents.

**Agent 3: Project Manager** (`/api/agents/project-manager/cron`, 15 min)
- Goal: Move projects from planning to completion
- Responsibilities: Project retry (§4), plan quality gate (§4.5), stuck execution recovery (§13a), project completion detection (§13b)

**Agent 4: Supervisor** (`/api/agents/supervisor/cron`, 10 min)
- Goal: Every other agent is healthy and the system is learning
- Responsibilities: Escalation polling (§11), reminders (§12), HLO polling (§15), branch cleanup, PM sweep (§14), NEW: agent health monitoring

After this handoff, `lib/atc.ts` becomes a ~50-line backward-compat wrapper.

IMPORTANT: This is a v2 re-execution. The v1 PR (#245) had merge conflicts due to rapid main advancement. You are working from CURRENT main which already has: event bus (H39), dispatcher + health monitor (H40), feedback compiler (H38), knowledge graph, debate system, and 10+ other merged PRs. Read the current state of ALL files before making changes.

## Pre-flight Self-Check

- [ ] Confirm H40 has been merged (lib/atc/dispatcher.ts and lib/atc/health-monitor.ts exist)
- [ ] Confirm current main has event-bus.ts, atc/types.ts, atc/lock.ts, atc/events.ts, atc/utils.ts
- [ ] Check if lib/atc/project-manager.ts or lib/atc/supervisor.ts already exist (skip creation if so)

## Step 0: Branch, commit handoff, push

Create branch `feat/extract-pm-supervisor-v2` from `main`. Commit this handoff file. Push.

## Step 1: Read current state

Read lib/atc.ts (should be smaller after H40), plus all files in lib/atc/, lib/notion.ts, lib/gmail.ts, lib/projects.ts, vercel.json. Understand what sections remain in the monolith vs. what was already extracted.

## Step 2: Create Project Manager

`lib/atc/project-manager.ts` — Extract §4 (project retry), §4.5 (quality gate), §13a (stuck recovery), §13b (completion detection). Export `runProjectManager(ctx: CycleContext)`.

## Step 3: Create Supervisor

`lib/atc/supervisor.ts` — Extract §11 (Gmail polling), §12 (reminders), §15 (HLO polling), branch cleanup, §14 (PM sweep). ADD NEW: agent health monitoring — check last-run timestamps for all agents, warn if stale. Export `runSupervisor(ctx: CycleContext)`.

## Step 4: Create cron routes

`app/api/agents/project-manager/cron/route.ts` (15 min) and `app/api/agents/supervisor/cron/route.ts` (10 min). Feature-flagged with `AGENT_SPLIT_ENABLED`. Follow exact same pattern as existing dispatcher and health-monitor cron routes.

## Step 5: Update vercel.json

Add both new crons. Read current vercel.json first — it has changed since v1.

## Step 6: Reduce lib/atc.ts to thin wrapper

Import all four agents. `runATCCycle()` calls them sequentially for backward compat. Re-export all public APIs. Target ~50-100 lines.

## Step 7: Add agent health tracking

Add to `lib/atc/utils.ts`: `recordAgentRun(name)` and `getAgentLastRun(name)`. Each agent calls `recordAgentRun` at end of cycle. Supervisor reads all last-run timestamps.

## Step 8: Build and verify

`npx tsc --noEmit`, all cron routes importable, feature flag gates work, old cron works as fallback.

## Session Abort Protocol

If you cannot complete execution:
1. Commit WIP, push branch, open draft PR
2. Output structured status to stdout