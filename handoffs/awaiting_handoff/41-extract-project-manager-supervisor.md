# Handoff 41: extract-project-manager-supervisor

## Metadata
- Branch: `feat/extract-project-manager-supervisor`
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

## Pre-flight Self-Check

- [ ] Confirm H40 has been merged (lib/atc/dispatcher.ts and lib/atc/health-monitor.ts exist)
- [ ] Confirm lib/atc/project-manager.ts does NOT exist yet
- [ ] Confirm lib/atc/supervisor.ts does NOT exist yet

## Step 0: Branch, commit handoff, push

Create branch `feat/extract-project-manager-supervisor` from `main`. Commit this handoff file. Push.

## Step 1: Read current state

Read atc.ts (should be smaller after H40), plus all files created in H40 (`lib/atc/*.ts`, agent cron routes), `lib/notion.ts`, `lib/gmail.ts`, `lib/projects.ts`.

## Step 2: Create Project Manager

`lib/atc/project-manager.ts` — Extract §4 (project retry), §4.5 (quality gate), §13a (stuck recovery), §13b (completion detection). Export `runProjectManager(ctx: CycleContext)`.

## Step 3: Create Supervisor

`lib/atc/supervisor.ts` — Extract §11 (Gmail polling), §12 (reminders), §15 (HLO polling), branch cleanup, §14 (PM sweep). ADD NEW: agent health monitoring — check last-run timestamps for all agents, warn if stale. Export `runSupervisor(ctx: CycleContext)`.

## Step 4: Create cron routes

`app/api/agents/project-manager/cron/route.ts` (15 min) and `app/api/agents/supervisor/cron/route.ts` (10 min). Feature-flagged with `AGENT_SPLIT_ENABLED`.

## Step 5: Update vercel.json

Add both new crons.

## Step 6: Reduce lib/atc.ts to thin wrapper

Import all four agents. `runATCCycle()` calls them sequentially for backward compat. Re-export all public APIs. ~50-100 lines.

## Step 7: Add agent health tracking

Add to `lib/atc/utils.ts`: `recordAgentRun(name)` and `getAgentLastRun(name)`. Each agent calls `recordAgentRun` at end of cycle. Supervisor reads all last-run timestamps.

## Step 8: Update SYSTEM_MAP.md

Document 4-agent architecture with self-healing loop: Supervisor detects stale agent → files work item → Dispatcher picks it up.

## Step 9: Build and verify

`npx tsc --noEmit`, all cron routes work, feature flag gates, old cron works as fallback, `lib/atc.ts` is ~50-100 lines.

## Session Abort Protocol

If you cannot complete execution:
1. Commit WIP, push branch, open draft PR
2. Output structured status to stdout