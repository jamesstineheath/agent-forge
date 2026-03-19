# Agent Forge -- Cron Audit Summary and Vercel.json Schedule Optimization

## Metadata
- **Branch:** `feat/cron-audit-summary-and-schedule-optimization`
- **Priority:** medium
- **Model:** sonnet
- **Type:** docs
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** docs/cron-audit-summary.md, vercel.json

## Context

Agent Forge has 4 autonomous agents running on Vercel cron schedules (Dispatcher, Health Monitor, PM Agent, Supervisor). Recent PRs have added early-exit optimizations to all four agents, and supervisor task throttling was added as well. These optimizations reduce idle invocation cost but the cron schedules themselves have not been reviewed since the initial ADR-010 decomposition.

The task is to:
1. Create a documentation file `docs/cron-audit-summary.md` capturing the audit of all 4 AF cron agents with purpose, frequencies (old vs new if changed), early-exit conditions, and qualitative cost profiles.
2. Document the 13 PA cron jobs for cross-reference (documentation only — we cannot touch the PA repo).
3. Review and optionally update `vercel.json` cron schedules if frequency reductions are warranted based on the audit.

Key context from CLAUDE.md:
- Dispatcher: `/api/agents/dispatcher/cron` — 5 min — conflict detection, concurrency, auto-dispatch
- Health Monitor: `/api/agents/health-monitor/cron` — 5 min — stall detection, recovery, reconciliation
- PM Agent: `/api/pm-agent` — 15 min — backlog review, health assessment, decomposition
- Supervisor: `/api/agents/supervisor/cron` — 10 min — agent health, escalation management, maintenance

The recent PRs confirm:
- Dispatcher: early-exit optimization added (PR: "feat: Dispatcher early-exit optimization")
- Health Monitor: early-exit optimization added (PR: "refactor: Health Monitor early-exit optimization")
- Supervisor: task throttling added + PM agent early-exit added (PR: "feat: supervisor task throttling and PM agent early-exit")

## Requirements

1. `docs/cron-audit-summary.md` must exist with an entry for each of the 4 AF cron agents
2. Each AF agent entry must document: purpose, current schedule, proposed schedule (or "unchanged"), early-exit conditions, and before/after invocation cost profile (qualitative: high/medium/low idle cost)
3. The document must include a section for PA cron jobs (13 jobs documented with purpose and frequency based on available context)
4. `vercel.json` cron schedules must be reviewed; reduce PM Agent from 15min to 30min and Supervisor from 10min to 15min given optimizations added (these are the warranted reductions based on the throttling and early-exit additions)
5. The project must compile successfully with `npm run build`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/cron-audit-summary-and-schedule-optimization
```

### Step 1: Read current vercel.json
```bash
cat vercel.json
```

Note the current cron schedule entries. The expected structure will have entries like:
```json
{
  "crons": [
    { "path": "/api/agents/dispatcher/cron", "schedule": "*/5 * * * *" },
    { "path": "/api/agents/health-monitor/cron", "schedule": "*/5 * * * *" },
    { "path": "/api/pm-agent", "schedule": "*/15 * * * *" },
    { "path": "/api/agents/supervisor/cron", "schedule": "*/10 * * * *" }
  ]
}
```

Also read the actual agent source files to get accurate early-exit condition details:
```bash
cat lib/atc/dispatcher.ts | head -100
cat lib/atc/health-monitor.ts | head -100
cat lib/atc/supervisor.ts | head -100
cat lib/pm-agent.ts | head -100
```

### Step 2: Create docs/cron-audit-summary.md

Create the file `docs/cron-audit-summary.md` with the following content (adjust details based on what you find in Step 1):

```markdown
# Cron Audit Summary

> Generated: [current date]  
> Purpose: Document all Agent Forge cron agents and Personal Assistant cron jobs, analyze schedules, and track optimizations made.

---

## Agent Forge Cron Agents

### 1. Dispatcher

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/dispatcher/cron` |
| **Purpose** | Index reconciliation, conflict detection, concurrency enforcement, auto-dispatch of ready work items to target repos |
| **Old Schedule** | Every 5 minutes (`*/5 * * * *`) |
| **New Schedule** | Every 5 minutes (`*/5 * * * *`) — **unchanged** |
| **Idle Cost Before** | Medium — ran full index scan every invocation regardless of queue state |
| **Idle Cost After** | Low — early-exit added; returns immediately if no ready items in queue |

**Early-Exit Conditions Added:**
- Exits before full index scan if work item index is empty or all items are in terminal state
- Exits before dispatch loop if no items are in `ready` state after reconciliation
- Distributed lock acquisition failure causes immediate exit (avoids duplicate processing)

**Rationale for keeping 5min schedule:** Dispatcher is latency-critical — a new work item filed should begin execution within minutes. Early-exit makes idle invocations cheap enough to keep at 5min.

---

### 2. Health Monitor

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/health-monitor/cron` |
| **Purpose** | Stall detection (stage-aware timeouts 20–35min), merge conflict recovery, auto-rebase, failed PR reconciliation, dependency re-evaluation |
| **Old Schedule** | Every 5 minutes (`*/5 * * * *`) |
| **New Schedule** | Every 5 minutes (`*/5 * * * *`) — **unchanged** |
| **Idle Cost Before** | High — polled GitHub API for all in-flight work items every invocation |
| **Idle Cost After** | Low–Medium — early-exit added; skips GitHub polling when no items are in active states |

**Early-Exit Conditions Added:**
- Exits early if no work items are in `executing`, `reviewing`, or `queued` states
- Skips stall detection pass if no items have exceeded minimum stall threshold based on last-updated timestamps
- Skips merge conflict recovery pass if no PRs are flagged as conflicted

**Rationale for keeping 5min schedule:** Health Monitor needs to detect and recover from stalls promptly. Stall timeouts start at 20min, so 5min polling is appropriate. Early-exit makes idle periods cheap.

---

### 3. PM Agent (Project Manager)

| Field | Value |
|-------|-------|
| **Route** | `/api/pm-agent` |
| **Purpose** | Backlog review, project health assessment, plan decomposition into work items, dependency management, project lifecycle completion detection |
| **Old Schedule** | Every 15 minutes (`*/15 * * * *`) |
| **New Schedule** | Every 30 minutes (`*/30 * * * *`) — **reduced** |
| **Idle Cost Before** | High — invoked Claude API on every run regardless of project activity |
| **Idle Cost After** | Low–Medium — early-exit added; skips Claude invocation when no active projects need attention, plus schedule halved |

**Early-Exit Conditions Added:**
- Exits before Claude invocation if no projects are in active states (`active`, `decomposing`)
- Exits early if all active projects have been recently assessed (within cooldown window)
- Skips decomposition pass if no projects are in `decomposing` state

**Rationale for reducing to 30min:** PM Agent handles project-level planning, not real-time dispatch. Projects evolve over hours, not minutes. Combined with early-exit, 30min provides sufficient responsiveness while halving invocation count.

---

### 4. Supervisor

| Field | Value |
|-------|-------|
| **Route** | `/api/agents/supervisor/cron` |
| **Purpose** | Agent health monitoring, escalation state management (pending/resolved/expired), maintenance tasks (branch cleanup, drift detection), staleness detection for other agents |
| **Old Schedule** | Every 10 minutes (`*/10 * * * *`) |
| **New Schedule** | Every 15 minutes (`*/15 * * * *`) — **reduced** |
| **Idle Cost Before** | Medium — ran all maintenance tasks every invocation |
| **Idle Cost After** | Low — task throttling added (each task category runs on its own sub-cadence); schedule reduced |

**Early-Exit Conditions Added / Throttling:**
- Task throttling: branch cleanup runs at most every N invocations, not every run
- Task throttling: drift detection runs at most every N invocations
- Escalation SLA checks run every invocation but exit immediately if escalation index is empty
- Agent staleness checks exit early if all agents have pinged recently

**Rationale for reducing to 15min:** With task throttling in place, many Supervisor tasks already run less frequently than every 10min. Formalizing this at the schedule level to 15min aligns the cron cadence with actual effective task frequency.

---

## Schedule Change Summary

| Agent | Old Schedule | New Schedule | Change |
|-------|-------------|--------------|--------|
| Dispatcher | `*/5 * * * *` (5 min) | `*/5 * * * *` (5 min) | None |
| Health Monitor | `*/5 * * * *` (5 min) | `*/5 * * * *` (5 min) | None |
| PM Agent | `*/15 * * * *` (15 min) | `*/30 * * * *` (30 min) | **Reduced 2×** |
| Supervisor | `*/10 * * * *` (10 min) | `*/15 * * * *` (15 min) | **Reduced 1.5×** |

**Estimated monthly invocation reduction:**

| Agent | Before (invocations/month) | After (invocations/month) | Saved |
|-------|---------------------------|--------------------------|-------|
| Dispatcher | ~8,640 | ~8,640 | 0 |
| Health Monitor | ~8,640 | ~8,640 | 0 |
| PM Agent | ~2,880 | ~1,440 | **1,440** |
| Supervisor | ~4,320 | ~2,880 | **1,440** |
| **Total** | **24,480** | **21,600** | **2,880 (~12%)** |

---

## Personal Assistant Cron Jobs

> **Note:** This section is documentation-only. The PA repository is separate (`personal-assistant` repo) and these schedules are not managed here. Documented for cross-reference and system-wide visibility.

The PA system runs 13 cron jobs. Based on system context and CLAUDE.md references:

| # | Job Name | Purpose | Estimated Frequency |
|---|----------|---------|-------------------|
| 1 | **Daily Briefing** | Morning summary of calendar, tasks, priorities | Daily (morning) |
| 2 | **Email Triage** | Scan and categorize incoming email | Every 30–60 min |
| 3 | **Calendar Sync** | Sync calendar events, detect conflicts | Every 15–30 min |
| 4 | **Task Review** | Review open tasks, surface overdue items | Daily |
| 5 | **Notion Sync** | Sync project/task data to/from Notion | Every 30–60 min |
| 6 | **Work Item Filer** | File detected action items as AF work items | Every 15–30 min |
| 7 | **Meeting Prep** | Generate prep briefs for upcoming meetings | Daily (morning) |
| 8 | **Digest Compiler** | Compile daily/weekly digest of activity | Daily or Weekly |
| 9 | **Health Check** | Verify PA system components are responsive | Every 5–15 min |
| 10 | **Memory Compaction** | Compact and summarize long-term memory | Daily or Weekly |
| 11 | **Agent Forge Poll** | Poll AF for work item status updates | Every 15–30 min |
| 12 | **Escalation Monitor** | Monitor open escalations for SLA breach | Every 15–30 min |
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
| [today] | PM Agent 15min → 30min, Supervisor 10min → 15min | Align schedule with effective task cadence post-throttling |

---

## Cost Profile Legend

| Level | Description |
|-------|-------------|
| **High** | Invokes Claude API and/or makes multiple GitHub API calls on every run regardless of system state |
| **Medium** | Makes some external API calls but exits early in common idle scenarios |
| **Low** | Primarily checks in-memory/Blob state; exits before expensive operations when system is idle |
```

### Step 3: Update vercel.json cron schedules

Read the current `vercel.json`, then update it to change:
- PM Agent: `*/15 * * * *` → `*/30 * * * *`
- Supervisor: `*/10 * * * *` → `*/15 * * * *`

Use `jq` or edit directly. Example approach:
```bash
# Read current state
cat vercel.json
```

Then edit `vercel.json` to update the two schedule entries. The file should have entries like:
```json
{ "path": "/api/pm-agent", "schedule": "*/30 * * * *" }
{ "path": "/api/agents/supervisor/cron", "schedule": "*/15 * * * *" }
```

**Important:** Only change the `schedule` values for PM Agent and Supervisor. Do not change Dispatcher or Health Monitor schedules. Do not change any other properties in `vercel.json`.

If the actual route paths in `vercel.json` differ from what's documented in CLAUDE.md, use the actual paths from the file — only update the schedule strings.

### Step 4: Verify build
```bash
npm run build
```

TypeScript compilation should pass since we only added a markdown file and modified a JSON config. If there are pre-existing build errors, note them but do not fix unrelated issues.

Also verify the cron entry structure is valid JSON:
```bash
node -e "JSON.parse(require('fs').readFileSync('vercel.json', 'utf8')); console.log('vercel.json is valid JSON')"
```

### Step 5: Verify files are correct
```bash
# Check the audit doc exists and has content
wc -l docs/cron-audit-summary.md

# Check vercel.json shows updated schedules
cat vercel.json | grep -A2 "pm-agent\|supervisor"
```

### Step 6: Commit, push, open PR
```bash
git add docs/cron-audit-summary.md vercel.json
git commit -m "docs: cron audit summary and vercel.json schedule optimization

- Create docs/cron-audit-summary.md documenting all 4 AF cron agents
  with purpose, old/new schedules, early-exit conditions, and cost profiles
- Document 13 PA cron jobs for cross-reference (docs only)
- Reduce PM Agent cron: 15min -> 30min (early-exit + project-level cadence)
- Reduce Supervisor cron: 10min -> 15min (task throttling already added)
- Estimated monthly invocation reduction: ~2,880 (~12%)"
git push origin feat/cron-audit-summary-and-schedule-optimization
gh pr create \
  --title "docs: cron audit summary and vercel.json schedule optimization" \
  --body "## Summary

Creates \`docs/cron-audit-summary.md\` documenting all Agent Forge cron agents and their optimization history, and updates two cron schedules in \`vercel.json\` based on recent optimizations.

## Changes

### docs/cron-audit-summary.md (new)
- Entry for each of the 4 AF agents: Dispatcher, Health Monitor, PM Agent, Supervisor
- Documents purpose, old/new schedule, early-exit conditions, and qualitative cost profile (high/medium/low idle cost)
- PA cron jobs section (13 jobs, documentation-only)
- Schedule change summary table with estimated monthly invocation counts
- Optimization history timeline

### vercel.json
- PM Agent: \`*/15 * * * *\` → \`*/30 * * * *\` (15min → 30min)
  - Rationale: Project-level planning doesn't need sub-15min cadence; early-exit already handles idle cheaply
- Supervisor: \`*/10 * * * *\` → \`*/15 * * * *\` (10min → 15min)
  - Rationale: Task throttling was added in recent PR; schedule now matches effective task cadence

## Invocation Impact
| Agent | Before | After | Saved/month |
|-------|--------|-------|-------------|
| PM Agent | 2,880 | 1,440 | 1,440 |
| Supervisor | 4,320 | 2,880 | 1,440 |
| **Total saved** | | | **2,880 (~12%)** |

## Risk
Low — documentation only + cron schedule loosening (no tighter scheduling, no logic changes)."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/cron-audit-summary-and-schedule-optimization
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If vercel.json does not exist or has an unexpected structure that makes cron schedule updates ambiguous, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "cron-audit-summary-and-schedule-optimization",
    "reason": "vercel.json structure does not contain expected cron entries for PM Agent or Supervisor — cannot safely update schedules without human review",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 3",
      "error": "vercel.json structure mismatch",
      "filesChanged": ["docs/cron-audit-summary.md"]
    }
  }'
```