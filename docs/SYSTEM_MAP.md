# Agent Forge -- System Map

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE                             │
│                   (Agent Forge repo)                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Autonomous Agents (ADR-010)              │   │
│  │                                                       │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │   │
│  │  │ Dispatcher   │  │   Health    │  │  Project    │  │   │
│  │  │ (5min cron)  │  │  Monitor   │  │  Manager    │  │   │
│  │  │ Dispatch +   │  │ (5min cron) │  │ (15min cron)│  │   │
│  │  │ concurrency  │  │ Stall +    │  │ Lifecycle + │  │   │
│  │  │ + conflict   │  │ recovery   │  │ decompose   │  │   │
│  │  └──────┬───────┘  └──────┬─────┘  └──────┬──────┘  │   │
│  │         │                 │                │         │   │
│  │  ┌──────┴─────────────────┴────────────────┴──────┐  │   │
│  │  │      Shared: Distributed Lock + Event Log      │  │   │
│  │  │      Feature flag: AGENT_SPLIT_ENABLED         │  │   │
│  │  └────────────────────┬───────────────────────────┘  │   │
│  │                       │                              │   │
│  │  ┌─────────────┐     │     ┌──────────────────┐     │   │
│  │  │ Supervisor   │     │     │ Feedback Compiler │     │   │
│  │  │ (10min cron) │     │     │ (weekly cron,     │     │   │
│  │  │ Agent health │     │     │  per target repo) │     │   │
│  │  │ + escalation │     │     │ Prompt improvement│     │   │
│  │  └─────────────┘     │     └──────────────────┘     │   │
│  └──────────────────────┼───────────────────────────────┘   │
│                         │                                    │
│  ┌──────────┐  ┌────────┴───┐  ┌──────────┐  ┌──────────┐  │
│  │Work Item │  │Orchestrator│  │Decomposer│  │Escalation│  │
│  │  Store   │  │(handoff gen│  │(plan →   │  │(state    │  │
│  │(Postgres)│  │ + dispatch)│  │ work items│  │ machine) │  │
│  └──────────┘  └────────────┘  └──────────┘  └──────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │     Event Bus (lib/event-bus.ts)                      │   │
│  │     GitHub Webhooks → /api/webhooks/github            │   │
│  │     Durable log: Vercel Blob (hourly, 30-day retention)│   │
│  │     Query API: /api/events                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    Dashboard                          │   │
│  │          (Next.js App Router pages)                   │   │
│  │  Pipeline health · Agent metrics · Event feed         │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    GitHub API + Webhooks
                           │
┌──────────────────────────┴──────────────────────────────────┐
│                    DATA PLANE                                │
│              (per target repository)                         │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Execute     │  │ TLM Spec     │  │ TLM Code     │      │
│  │   Handoff     │  │   Review     │  │   Review     │      │
│  │  (workflow)   │  │  (workflow)  │  │  (workflow)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ TLM Outcome  │  │ Handoff      │  │ CI Stuck PR  │      │
│  │   Tracker    │  │ Lifecycle    │  │   Monitor    │      │
│  │  (daily cron)│  │ Orchestrator │  │  (workflow)  │      │
│  └──────────────┘  │  (workflow)  │  └──────────────┘      │
│                    └──────────────┘                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  TLM QA      │  │ Feedback     │  │    Repo      │      │
│  │   Agent      │  │ Compiler     │  │  Metadata    │      │
│  │ (Playwright) │  │ (daily cron) │  │ (CLAUDE.md,  │      │
│  └──────────────┘  └──────────────┘  │ system map,  │      │
│                                       │ ADRs, TLM    │      │
│  ┌──────────────┐                    │ memory)      │      │
│  │ TLM Trace    │                    └──────────────┘      │
│  │  Reviewer    │                                           │
│  │ (daily cron) │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Work Item Lifecycle

```
Filed → Ready → Queued → Generating → Executing → Reviewing → Merged → Verified
                  │           │                        │           │
                  │           └── Retrying ────────────┘           └── Partial
                  ├── Blocked (escalated) ←────────────┤
                  └── Parked (conflict/failed) ←───────┘
```

1. **Filed**: Work item created from PA `file_work_item` bridge, GitHub issue, Plan Decomposer, or manual entry
2. **Ready**: Triaged and prioritized, ready for dispatch
3. **Queued**: Dispatched but waiting for pipeline capacity
4. **Generating**: Orchestrator reading repo context and generating handoff
5. **Executing**: Handoff pushed to target repo, Execute Handoff workflow running
6. **Reviewing**: PR opened, TLM Code Review in progress
7. **Merged**: PR merged (auto or manual), outcome tracked. Also set by Health Monitor reconciliation when a "failed" item's PR is actually merged.
8. **Verified**: All acceptance criteria passed post-merge validation (set by Intent Validator).
9. **Partial**: Some acceptance criteria failed post-merge validation; gap analysis filed (set by Intent Validator).
10. **Blocked**: Escalation created, awaiting human resolution via email
11. **Parked**: File conflict detected or execution failed, waiting for retry

### Autonomous Agent Architecture (ADR-010) — Inngest Migration (PR #415)

All cron agents run as **Inngest durable step functions** (migrated from Vercel serverless cron 2026-03-21). Each step gets its own execution context with independent timeout and retry. Eliminates the timeout compounding flaw that caused decomposition to fail at 340s every cycle.

Old cron routes (`/api/agents/*/cron`) are kept as thin Inngest event triggers for dashboard "Run Now" button compatibility. Inngest serve endpoint: `/api/inngest`.

| Inngest Function | Cron | Steps | Source |
|-----------------|------|-------|--------|
| **plan-pipeline** | */10 | criteria-import, architecture-planning (800s), decomposition (800s) | Supervisor (core) |
| **pipeline-oversight** | */30 | escalation-management, intent-validation, spend-monitoring, agent-health | Supervisor (monitoring) |
| **pm-sweep** | daily 08:00 UTC | PM sweep (backlog review, health, digest) | Supervisor (extracted) |
| **housekeeping** | */6h | branch-cleanup, drift-detection, repo-reindex + cache-metrics | Supervisor (maintenance) |
| **dispatcher-cycle** | */15 | index-reconciliation, dispatch | Dispatcher |
| **pm-cycle** | */30 | retry-processing, decomposition, lifecycle-management | Project Manager |
| **health-monitor-cycle** | */15 | health-monitoring, dashboard-health-check, hlo-polling | Health Monitor |

**Shared infrastructure:**
- **Distributed lock** (`lib/atc/lock.ts`): Optimistic Vercel Blob lock with write-then-reread race detection. 5-min TTL, 10-min hard ceiling.
- **Event log** (`lib/atc/events.ts`): Global rolling log (max 1000 events) + per-work-item history (uncapped).
- **Inngest client** (`lib/inngest/client.ts`): Inngest instance (`id: "agent-forge"`). Functions defined in `lib/inngest/*.ts`.

### Self-Healing Sections

- **Dispatcher §0 — Index Reconciliation**: No-op since Neon Postgres migration (no index/blob drift possible).
- **Health Monitor §2.8 — Failed PR Reconciliation**: Checks all "failed" work items with a `prNumber`. If the PR is actually merged on GitHub, transitions to "merged".
- **Health Monitor — Stall Detection**: Stage-aware timeouts (20-35 min depending on phase). Auto-transitions stuck items.
- **Health Monitor — Merge Conflict Recovery**: Detects PRs with conflicts, attempts auto-rebase.
- **Health Monitor — Dashboard Self-Health**: Checks `/api/work-items` and `/api/pipeline/kill-switch` every 15 min. Sends email alert on failure. Detects schema mismatches, deployment failures, and infrastructure issues.
- **Project Manager §13a — Stuck Executing Recovery**: Detects projects where decomposition never ran, resets for re-decomposition.
- **Project Manager §13b — Completion Detection**: When all work items reach terminal state, auto-transitions project.

### Execution Flow (per work item)

```
Orchestrator → Push handoff to branch
                    ↓
            TLM Spec Review (improve handoff)
                    ↓
            Execute Handoff (Claude Code runs handoff)
                    ↓
            CI wait (execute-handoff waits for checks)
                    ↓
            PR opened with execution results
                    ↓
            TLM Code Review (defers if CI red)
                    ↓
            Auto-merge (if low-risk + CI passes)
                    ↓
            Handoff Lifecycle Orchestrator tracks state
                    ↓
            TLM Outcome Tracker (daily assessment)
                    ↓
            Feedback Compiler (weekly analysis → prompt improvement PRs)
```

### TLM Self-Improvement Loop

```
Outcome Tracker (daily)
  → docs/tlm-memory.md (Hot Patterns, Outcomes, Lessons, Stats)
      → Feedback Compiler (weekly, Sunday 10pm UTC)
          → Reads: memory, agent prompts, PR history, previous changes
          → Claude analysis: patterns, failure modes, cross-agent misalignment
          → Outputs:
              ├── PR with prompt/config changes (gated by Code Reviewer + human)
              ├── GitHub Issues for escalations
              └── docs/feedback-compiler-history.json (effectiveness tracking)
                    → Next run checks if previous changes were effective
                        → If ineffective: propose revert or stronger fix
                        → If effective: mark and move on
```

## Key Files

### Control Plane (agent-forge repo)

| Subsystem | Path | Purpose |
|-----------|------|---------|
| **Autonomous Agents** | | |
| Dispatcher | `lib/atc/dispatcher.ts` | Conflict detection, concurrency, auto-dispatch |
| Health Monitor | `lib/atc/health-monitor.ts` | Stall detection, recovery, reconciliation |
| Shared Types | `lib/atc/types.ts` | CycleContext, timeouts, concurrency limits, high-churn files |
| Distributed Lock | `lib/atc/lock.ts` | Optimistic Blob lock with race detection |
| Event Persistence | `lib/atc/events.ts` | Global rolling log + per-item history |
| Utilities | `lib/atc/utils.ts` | File parsing, overlap detection, timeout wrapper |
| PM Agent | `lib/pm-agent.ts` | Claude-powered backlog review, health, decomposition |
| PM Prompts | `lib/pm-prompts.ts` | Structured prompt builders for PM agent |
| ATC (DEPRECATED) | `lib/atc.ts` | **Deprecated 2026-03-18.** Cron disabled. All responsibilities now handled by Dispatcher, Health Monitor, Project Manager, and Supervisor agents. File kept for utility re-exports only. |
| **Core** | | |
| Orchestrator | `lib/orchestrator.ts` | Handoff generation + dispatch to target repos |
| Work Items | `lib/work-items.ts` | CRUD + dependency-aware dispatch (Neon Postgres via Drizzle) |
| Decomposer | `lib/decomposer.ts` | Plan page → ordered work items with dependency DAG |
| Escalation | `lib/escalation.ts` | State machine: pending/resolved/expired, SLA timers |
| Gmail | `lib/gmail.ts` | OAuth2, escalation emails, decomposition summaries |
| Notion | `lib/notion.ts` | Notion API client, project status reads |
| Projects | `lib/projects.ts` | Project lifecycle: Complete/Failed transitions |
| Storage | `lib/storage.ts` | Vercel Blob CRUD (non-work-item data) |
| Database | `lib/db/index.ts`, `lib/db/schema.ts` | Neon Postgres connection + Drizzle schema |
| Types | `lib/types.ts` | Shared types (WorkItem, Project, source types) |
| Repos | `lib/repos.ts` | Multi-repo registry with per-repo concurrency limits |
| GitHub | `lib/github.ts` | GitHub API wrapper |
| **Event Bus** | | |
| Event Bus | `lib/event-bus.ts` | Durable log: append, query, cleanup (hourly Blob partitions) |
| Event Types | `lib/event-bus-types.ts` | WebhookEvent, GitHubEventType union |
| Webhook Handler | `app/api/webhooks/github/route.ts` | HMAC-SHA256 verified GitHub webhook receiver |
| Event Query API | `app/api/events/route.ts` | Authenticated event query endpoint |
| **API Routes** | | |
| Dispatcher Cron | `app/api/agents/dispatcher/cron/route.ts` | Feature-gated dispatcher agent |
| Health Monitor Cron | `app/api/agents/health-monitor/cron/route.ts` | Feature-gated health monitor agent |
| ATC Metrics | `app/api/agents/atc-metrics/route.ts` | Aggregated metrics from event log |
| TLM Memory API | `app/api/agents/tlm-memory/route.ts` | Parsed TLM memory state |
| Feedback Compiler API | `app/api/agents/feedback-compiler/route.ts` | Feedback compiler status |
| PM Agent API | `app/api/pm-agent/route.ts` | Multi-action PM agent endpoint |
| Telemetry API | `app/api/telemetry/route.ts` | Unified telemetry query (events, traces, costs, metrics) |
| Pipeline Metrics | `lib/pipeline-metrics.ts` | Speed, quality, cost, volume KPIs |
| Cost Tracking | `lib/cost-tracking.ts` | Cost recording, period queries, aggregation |
| Admin Migrate | `app/api/admin/migrate/route.ts` | Idempotent schema migrations (ALTER TABLE) against Neon |
| **Inngest** | | |
| Inngest Client | `lib/inngest/client.ts` | Inngest instance (`id: "agent-forge"`) |
| Plan Pipeline | `lib/inngest/plan-pipeline.ts` | Criteria import → architecture planning → decomposition |
| Pipeline Oversight | `lib/inngest/pipeline-oversight.ts` | Escalation, intent validation, spend, agent health |
| PM Sweep | `lib/inngest/pm-sweep.ts` | Daily PM sweep (backlog, health, digest) |
| Housekeeping | `lib/inngest/housekeeping.ts` | Branch cleanup, drift detection, repo reindex |
| Dispatcher Cycle | `lib/inngest/dispatcher.ts` | Index reconciliation + dispatch |
| PM Cycle | `lib/inngest/pm-cycle.ts` | Project retry + decomposition + lifecycle |
| Health Monitor Cycle | `lib/inngest/health-monitor.ts` | Health monitoring + dashboard self-health + HLO polling |
| Serve Handler | `app/api/inngest/route.ts` | Inngest serve endpoint (registers all 7 functions) |
| **Dashboard** | | |
| Hooks (SWR) | `lib/hooks.ts` | React data fetching hooks |
| Handoffs | `handoffs/` | Version-controlled handoff files |

### Data Plane (per target repo)

| Subsystem | Path | Purpose |
|-----------|------|---------|
| TLM Code Reviewer | `.github/actions/tlm-review/` | PR review with full codebase context |
| TLM Spec Reviewer | `.github/actions/tlm-spec-review/` | Handoff improvement before execution |
| TLM Outcome Tracker | `.github/actions/tlm-outcome-tracker/` | Daily assessment of merged PR outcomes |
| Feedback Compiler | `.github/actions/tlm-feedback-compiler/` | Weekly self-improvement proposals |
| TLM Trace Reviewer | `.github/actions/tlm-trace-review/` | Daily trace analysis, anomaly detection, auto-files work items for systemic issues |
| TLM QA Agent | `.github/actions/tlm-qa-agent/` | Post-deploy verification (advisory mode, Playwright + smoke + criteria) |
| Execute Handoff | `.github/workflows/execute-handoff.yml` | Claude Code runs handoff, waits for CI |
| TLM Review | `.github/workflows/tlm-review.yml` | Triggers Code Reviewer on PR events |
| Spec Review | `.github/workflows/tlm-spec-review.yml` | Triggers on handoff push |
| Outcome Tracker | `.github/workflows/tlm-outcome-tracker.yml` | Daily assessment cron |
| Feedback Compiler | `.github/workflows/tlm-feedback-compiler.yml` | Weekly self-improvement cron |
| Trace Reviewer | `.github/workflows/tlm-trace-reviewer.yml` | Daily 6am UTC trace analysis cron |
| Handoff Orchestrator | `.github/workflows/handoff-orchestrator.yml` | Lifecycle state machine, CI retry |
| CI Stuck PR Monitor | `.github/workflows/ci-stuck-pr-monitor.yml` | Alerts after 2h stuck |
| TLM Memory | `docs/tlm-memory.md` | Rolling 20-entry review patterns + lessons |
| Feedback History | `docs/feedback-compiler-history.json` | Change effectiveness tracking |
| System Map | `docs/SYSTEM_MAP.md` | This file |
| ADRs | `docs/adr/` | Architecture Decision Records |

## Storage

| Store | Location | Purpose |
|-------|----------|---------|
| Work Items | Neon Postgres `work_items` table | Work item CRUD (migrated from Vercel Blob 2026-03-21) |
| ATC State | Vercel Blob `af-data/atc/*` | Active executions, queue, dedup guards |
| Repo Config | Vercel Blob `af-data/repos/*` | Registered repo metadata |
| Escalations | Vercel Blob `escalations/*` | Escalation records + index |
| Event Bus | Vercel Blob `af-data/events/YYYY-MM-DD-HH` | Durable webhook event log |
| PM Agent Cache | Vercel Blob `pm-agent/*` | Backlog review, health assessment results |
| TLM Memory | `docs/tlm-memory.md` (in-repo) | Review patterns and lessons |
| Feedback History | `docs/feedback-compiler-history.json` (in-repo) | Change effectiveness tracking |

## Integration Points

| From | To | Mechanism |
|------|-----|-----------|
| Agent Forge | Target repos | GitHub API (read files, create branches, push, trigger workflows) |
| Target repos | Agent Forge | Polling (workflow run status, PR status, CI checks) |
| GitHub | Agent Forge | Webhooks → `/api/webhooks/github` (PR, CI, push events → durable event log) |
| PA | Agent Forge | `file_work_item` tool → `POST /api/work-items` (Bearer token auth) |
| Agent Forge | Notion | Notion API (read project plans, poll project status) |
| Agent Forge | Gmail | Gmail API OAuth2 (escalation emails, decomposition summaries, reply polling) |

## Environment Variables

### Agent Forge (Vercel)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string (work items) |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob access (non-work-item data) |
| `NOTION_API_KEY` | Notion API for project reads |
| `NOTION_PROJECTS_DB_ID` | Projects database ID |
| `GMAIL_CLIENT_ID` / `CLIENT_SECRET` / `REFRESH_TOKEN` | Gmail OAuth2 |
| `AGENT_FORGE_API_SECRET` | Bearer token for pipeline auth |
| `WORK_ITEMS_API_KEY` | Bearer token for PA → AF work item filing |
| `GH_PAT` | Fine-grained PAT for GitHub API |
| `GITHUB_WEBHOOK_SECRET` | HMAC-SHA256 for webhook verification |
| `INNGEST_EVENT_KEY` | Inngest event key (sends events) |
| `INNGEST_SIGNING_KEY` | Inngest signing key (verifies serve requests) |
| `CRON_SECRET` | Auth for Vercel cron invocations (now thin Inngest event triggers) |

### Target Repos (GitHub Secrets)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API for TLM agents |
| `GH_PAT` | PAT for cross-workflow triggers |
| `AGENT_FORGE_API_SECRET` | Auth for escalation callbacks |
| `AGENT_FORGE_URL` | Agent Forge deployment URL |
