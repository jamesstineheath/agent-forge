# Cron Audit Summary

> Generated: 2026-03-19
> Purpose: Document all Agent Forge cron agents and Personal Assistant cron jobs, analyze schedules, and track optimizations made.

---

## Agent Forge Cron Agents

### 1. Dispatcher

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/dispatcher/cron` |
| **Purpose** | Index reconciliation, conflict detection, concurrency enforcement, auto-dispatch of ready work items to target repos |
| **Schedule** | Every 15 minutes (`*/15 * * * *`) |
| **Idle Cost Before** | Medium — ran full index scan every invocation regardless of queue state |
| **Idle Cost After** | Low — early-exit added; returns immediately if no ready items in queue |

**Early-Exit Conditions Added:**
- Exits before full index scan if no items are in `ready` state
- Exits before dispatch loop if no items remain after reconciliation
- Distributed lock acquisition failure causes immediate exit (avoids duplicate processing)

**Rationale for 15min schedule:** Dispatcher is latency-sensitive but 15min cadence balances responsiveness with cost. Event-driven dispatch via `dispatchUnblockedItems()` handles the time-critical path when dependencies resolve (triggered by webhook events, not cron). Early-exit makes idle invocations cheap.

---

### 2. Health Monitor

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/health-monitor/cron` |
| **Purpose** | Stall detection (stage-aware timeouts 20-35min), merge conflict recovery, auto-rebase, failed PR reconciliation, CI failure classification and retry |
| **Schedule** | Every 15 minutes (`*/15 * * * *`) |
| **Idle Cost Before** | High — polled GitHub API for all in-flight work items every invocation |
| **Idle Cost After** | Low-Medium — early-exit added; skips GitHub polling when no items are in active states |

**Early-Exit Conditions Added:**
- Exits early if no work items are in `executing`, `reviewing`, or `queued` states
- Skips stall detection pass if no items have exceeded minimum stall threshold based on last-updated timestamps
- Skips merge conflict recovery pass if no PRs are flagged as conflicted
- Code CI retry has idempotency guard (15min window) to prevent duplicate retries

**Rationale for 15min schedule:** Stall timeouts start at 20min, so 15min polling is appropriate. Early-exit makes idle periods cheap.

---

### 3. PM Agent (Project Manager)

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/project-manager/cron` |
| **Purpose** | Backlog review, project health assessment, plan decomposition into work items, dependency management, project lifecycle completion detection |
| **Schedule** | Every 30 minutes (`*/30 * * * *`) |
| **Idle Cost Before** | High — invoked Claude API on every run regardless of project activity |
| **Idle Cost After** | Low-Medium — early-exit added; skips Claude invocation when no active projects need attention |

**Early-Exit Conditions Added:**
- Exits before Claude invocation if no projects are in active states (`active`, `decomposing`)
- Exits early if all active projects have been recently assessed (within cooldown window)
- Skips decomposition pass if no projects are in `decomposing` state

**Rationale for 30min schedule:** PM Agent handles project-level planning, not real-time dispatch. Projects evolve over hours, not minutes. Combined with early-exit, 30min provides sufficient responsiveness while minimizing invocation count.

---

### 4. Supervisor

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/supervisor/cron` |
| **Purpose** | Agent health monitoring, escalation state management (pending/resolved/expired), maintenance tasks (branch cleanup, drift detection), staleness detection for other agents, cache metrics, spend monitoring |
| **Schedule** | Every 30 minutes (`*/30 * * * *`) |
| **Idle Cost Before** | Medium — ran all maintenance tasks every invocation |
| **Idle Cost After** | Low — task throttling added (each task category runs on its own sub-cadence) |

**Early-Exit Conditions / Throttling:**
- Task throttling: branch cleanup and stale PR monitoring run on independent cooldown timers, not every invocation
- Escalation SLA checks run every invocation but exit immediately if escalation index is empty
- Agent staleness checks exit early if all agents have pinged recently
- Spend monitoring and cache metrics are lightweight checks included each cycle

**Rationale for 30min schedule:** With task throttling in place, many Supervisor tasks already run less frequently than every 30min internally. The 30min cron cadence aligns with actual effective task frequency.

---

### 5. Digest

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/digest/cron` |
| **Purpose** | Daily digest compilation |
| **Schedule** | Daily at 8:00 UTC (`0 8 * * *`) |

---

## Schedule Summary

| Agent | Schedule | Frequency |
|-------|----------|-----------|
| Dispatcher | `*/15 * * * *` | Every 15 min |
| Health Monitor | `*/15 * * * *` | Every 15 min |
| PM Agent | `*/30 * * * *` | Every 30 min |
| Supervisor | `*/30 * * * *` | Every 30 min |
| Digest | `0 8 * * *` | Daily |

**Estimated monthly invocations:**

| Agent | Invocations/month |
|-------|-------------------|
| Dispatcher | ~2,880 |
| Health Monitor | ~2,880 |
| PM Agent | ~1,440 |
| Supervisor | ~1,440 |
| Digest | ~30 |
| **Total** | **~8,670** |

---

## Personal Assistant Cron Jobs

> **Note:** This section is documentation-only. The PA repository is separate (`personal-assistant` repo) and these schedules are not managed here. Documented for cross-reference and system-wide visibility.

The PA system runs 13 cron jobs. Based on system context and CLAUDE.md references:

| # | Job Name | Purpose | Estimated Frequency |
|---|----------|---------|-------------------|
| 1 | **Daily Briefing** | Morning summary of calendar, tasks, priorities | Daily (morning) |
| 2 | **Email Triage** | Scan and categorize incoming email | Every 30-60 min |
| 3 | **Calendar Sync** | Sync calendar events, detect conflicts | Every 15-30 min |
| 4 | **Task Review** | Review open tasks, surface overdue items | Daily |
| 5 | **Notion Sync** | Sync project/task data to/from Notion | Every 30-60 min |
| 6 | **Work Item Filer** | File detected action items as AF work items | Every 15-30 min |
| 7 | **Meeting Prep** | Generate prep briefs for upcoming meetings | Daily (morning) |
| 8 | **Digest Compiler** | Compile daily/weekly digest of activity | Daily or Weekly |
| 9 | **Health Check** | Verify PA system components are responsive | Every 5-15 min |
| 10 | **Memory Compaction** | Compact and summarize long-term memory | Daily or Weekly |
| 11 | **Agent Forge Poll** | Poll AF for work item status updates | Every 15-30 min |
| 12 | **Escalation Monitor** | Monitor open escalations for SLA breach | Every 15-30 min |
| 13 | **Weekly Review** | Generate weekly review summary | Weekly |

> Frequencies above are estimates based on system design patterns. Authoritative schedules are in the PA repo's `vercel.json` or equivalent cron configuration.

---

## Optimization History

| Date | Change | Rationale |
|------|--------|-----------|
| 2026-03-18 | ATC monolith decomposed into 4 agents (ADR-010) | Single-responsibility, independent cadences |
| 2026-03 | Dispatcher early-exit optimization | Eliminate idle GitHub API polling |
| 2026-03 | Health Monitor early-exit optimization | Skip polling when no active work items |
| 2026-03 | Supervisor task throttling + PM Agent early-exit | Reduce Claude API calls on idle runs |
| 2026-03-19 | Cron audit summary created | Document all agent schedules, early-exit conditions, and cost profiles |

---

## Cost Profile Legend

| Level | Description |
|-------|-------------|
| **High** | Invokes Claude API and/or makes multiple GitHub API calls on every run regardless of system state |
| **Medium** | Makes some external API calls but exits early in common idle scenarios |
| **Low** | Primarily checks in-memory/Blob state; exits before expensive operations when system is idle |
