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
│  │(Blob)    │  │ + dispatch)│  │ work items│  │ machine) │  │
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
│  │ (DISABLED)   │  │ (weekly cron)│  │ (CLAUDE.md,  │      │
│  └──────────────┘  └──────────────┘  │ system map,  │      │
│                                       │ ADRs, TLM    │      │
│                                       │ memory)      │      │
│                                       └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Work Item Lifecycle

```
Filed → Ready → Queued → Generating → Executing → Reviewing → Merged
                  │                                     │
                  ├── Blocked (escalated) ←──────────────┤
                  └── Parked (conflict/failed) ←────────┘
```

1. **Filed**: Work item created from PA `file_work_item` bridge, GitHub issue, Plan Decomposer, or manual entry
2. **Ready**: Triaged and prioritized, ready for dispatch
3. **Queued**: Dispatched but waiting for pipeline capacity
4. **Generating**: Orchestrator reading repo context and generating handoff
5. **Executing**: Handoff pushed to target repo, Execute Handoff workflow running
6. **Reviewing**: PR opened, TLM Code Review in progress
7. **Merged**: PR merged (auto or manual), outcome tracked. Also set by Health Monitor reconciliation when a "failed" item's PR is actually merged.
8. **Blocked**: Escalation created, awaiting human resolution via email
9. **Parked**: File conflict detected or execution failed, waiting for retry

### Autonomous Agent Architecture (ADR-010)

The ATC monolith has been decomposed into 4 autonomous agents:

| Agent | Route | Cadence | Responsibility |
|-------|-------|---------|----------------|
| **Dispatcher** | `/api/agents/dispatcher/cron` | 5 min | Index reconciliation, conflict detection, concurrency enforcement, auto-dispatch |
| **Health Monitor** | `/api/agents/health-monitor/cron` | 5 min | Stall detection, merge conflict recovery, auto-rebase, failed item reconciliation, dependency re-evaluation |
| **Project Manager** | `/api/pm-agent` | 15 min | Backlog review, project health assessment, decomposition, completion detection |
| **Supervisor** | `/api/agents/supervisor/cron` | 10 min | Agent health monitoring, escalation management, maintenance tasks |

**Shared infrastructure:**
- **Distributed lock** (`lib/atc/lock.ts`): Optimistic Vercel Blob lock with write-then-reread race detection. 5-min TTL, 10-min hard ceiling.
- **Event log** (`lib/atc/events.ts`): Global rolling log (max 1000 events) + per-work-item history (uncapped).
- **Feature flag**: `AGENT_SPLIT_ENABLED=true` enables new agent cron routes. Legacy `/api/atc/cron` still works as fallback.

### Self-Healing Sections

- **Dispatcher §0 — Index Reconciliation**: Detects and repairs work item index/blob drift before each dispatch cycle.
- **Health Monitor §2.8 — Failed PR Reconciliation**: Checks all "failed" work items with a `prNumber`. If the PR is actually merged on GitHub, transitions to "merged".
- **Health Monitor — Stall Detection**: Stage-aware timeouts (20-35 min depending on phase). Auto-transitions stuck items.
- **Health Monitor — Merge Conflict Recovery**: Detects PRs with conflicts, attempts auto-rebase.
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
| ATC (legacy) | `lib/atc.ts` | Backward-compat orchestrator, delegates to agents |
| **Core** | | |
| Orchestrator | `lib/orchestrator.ts` | Handoff generation + dispatch to target repos |
| Work Items | `lib/work-items.ts` | CRUD + dependency-aware dispatch |
| Decomposer | `lib/decomposer.ts` | Plan page → ordered work items with dependency DAG |
| Escalation | `lib/escalation.ts` | State machine: pending/resolved/expired, SLA timers |
| Gmail | `lib/gmail.ts` | OAuth2, escalation emails, decomposition summaries |
| Notion | `lib/notion.ts` | Notion API client, project status reads |
| Projects | `lib/projects.ts` | Project lifecycle: Complete/Failed transitions |
| Storage | `lib/storage.ts` | Vercel Blob CRUD |
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
| TLM QA Agent | `.github/actions/tlm-qa-agent/` | Post-deploy verification (DISABLED) |
| Execute Handoff | `.github/workflows/execute-handoff.yml` | Claude Code runs handoff, waits for CI |
| TLM Review | `.github/workflows/tlm-review.yml` | Triggers Code Reviewer on PR events |
| Spec Review | `.github/workflows/tlm-spec-review.yml` | Triggers on handoff push |
| Outcome Tracker | `.github/workflows/tlm-outcome-tracker.yml` | Daily assessment cron |
| Feedback Compiler | `.github/workflows/tlm-feedback-compiler.yml` | Weekly self-improvement cron |
| Handoff Orchestrator | `.github/workflows/handoff-orchestrator.yml` | Lifecycle state machine, CI retry |
| CI Stuck PR Monitor | `.github/workflows/ci-stuck-pr-monitor.yml` | Alerts after 2h stuck |
| TLM Memory | `docs/tlm-memory.md` | Rolling 20-entry review patterns + lessons |
| Feedback History | `docs/feedback-compiler-history.json` | Change effectiveness tracking |
| System Map | `docs/SYSTEM_MAP.md` | This file |
| ADRs | `docs/adr/` | Architecture Decision Records |

## Storage

| Store | Location | Purpose |
|-------|----------|---------|
| Work Items | Vercel Blob `af-data/work-items/*` | Work item CRUD |
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
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob access |
| `NOTION_API_KEY` | Notion API for project reads |
| `NOTION_PROJECTS_DB_ID` | Projects database ID |
| `GMAIL_CLIENT_ID` / `CLIENT_SECRET` / `REFRESH_TOKEN` | Gmail OAuth2 |
| `AGENT_FORGE_API_SECRET` | Bearer token for pipeline auth |
| `WORK_ITEMS_API_KEY` | Bearer token for PA → AF work item filing |
| `GH_PAT` | Fine-grained PAT for GitHub API |
| `GITHUB_WEBHOOK_SECRET` | HMAC-SHA256 for webhook verification |
| `AGENT_SPLIT_ENABLED` | Feature flag: enables new agent cron routes |
| `CRON_SECRET` | Auth for Vercel cron invocations |

### Target Repos (GitHub Secrets)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API for TLM agents |
| `GH_PAT` | PAT for cross-workflow triggers |
| `AGENT_FORGE_API_SECRET` | Auth for escalation callbacks |
| `AGENT_FORGE_URL` | Agent Forge deployment URL |
