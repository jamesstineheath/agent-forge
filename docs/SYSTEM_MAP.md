# Agent Forge -- System Map

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   CONTROL PLANE                          │
│                  (Agent Forge repo)                       │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Work Item    │  │ Orchestrator │  │     ATC      │  │
│  │    Store      │  │              │  │ (Air Traffic  │  │
│  │ (Vercel Blob) │  │ (API route + │  │  Controller)  │  │
│  │              │  │  Agent SDK)  │  │ (Vercel cron) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │           │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐  │
│  │ Decomposer   │  │  Escalation  │  │    Gmail      │  │
│  │ (Plan →       │  │  (State      │  │  (Escalation  │  │
│  │  Work Items)  │  │   machine)   │  │   + summaries)│  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │           │
│  ┌──────┴───────┐  ┌──────┴───────┐                     │
│  │   Notion      │  │   Projects   │                     │
│  │   Client      │  │   Manager    │                     │
│  └──────┬───────┘  └──────┬───────┘                     │
│         │                 │                              │
│  ┌──────┴─────────────────┴──────────────────────────┐  │
│  │                    Dashboard                       │  │
│  │          (Next.js App Router pages)                │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │
                    GitHub API
                           │
┌──────────────────────────┴──────────────────────────────┐
│                    DATA PLANE                            │
│              (per target repository)                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Execute     │  │ TLM Spec     │  │ TLM Code     │  │
│  │   Handoff     │  │   Review     │  │   Review     │  │
│  │  (workflow)   │  │  (workflow)  │  │  (workflow)  │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ TLM Outcome  │  │ Handoff      │  │ CI Stuck PR  │  │
│  │   Tracker    │  │ Lifecycle    │  │   Monitor    │  │
│  │  (daily cron)│  │ Orchestrator │  │  (workflow)  │  │
│  └──────────────┘  │  (workflow)  │  └──────────────┘  │
│                    └──────────────┘                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  TLM QA      │  │ Feedback     │  │    Repo      │  │
│  │   Agent      │  │ Compiler     │  │  Metadata    │  │
│  │ (post-deploy │  │ (weekly cron)│  │ (CLAUDE.md,  │  │
│  │  smoke tests)│  │ (ADR-009,    │  │ system map,  │  │
│  └──────────────┘  │  in pipeline)│  │ ADRs, TLM    │  │
│                    └──────────────┘  │ memory)      │  │
│                                      └──────────────┘  │
└─────────────────────────────────────────────────────────┘
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
7. **Merged**: PR merged (auto or manual), outcome tracked. Also set by §2.8 reconciliation when a "failed" item's PR is actually merged.
8. **Blocked**: Escalation created, awaiting human resolution via email
9. **Parked**: File conflict detected or execution failed, waiting for retry

### ATC Self-Healing Sections

- **§2.8 — Failed Work Item PR Reconciliation**: Checks all "failed" work items with a `prNumber`. If the PR is actually merged on GitHub, transitions the work item to "merged". If the PR is still open, moves back to "reviewing". Catches cases where a workflow step failed (e.g., bash parsing error in "Report results") but the code change actually landed.
- **§13a — Stuck Executing Recovery**: Detects projects in "Executing" status with no work items and no dedup guard (decomposition never ran, e.g., due to ATC cycle timeout). Resets them to "Execute" for re-decomposition on the next cycle.
- **§13b — Project Completion Detection**: When all work items for a project reach terminal state (merged/parked/failed/cancelled), auto-transitions the Notion project to "Complete" (if any merged, none failed) or "Failed" (if any failed).

### Project Autopilot Flow

```
Notion Project (Status = "Execute")
          ↓
ATC Section 4.5 detects new project
          ↓
Decomposer fetches plan page from Notion
          ↓
Generates ordered work items with dependency DAG
          ↓
Gmail decomposition summary sent
          ↓
ATC dispatches items in topological order
(dependencies must be "merged" before dispatch)
          ↓
Section 13: all items terminal → project Complete/Failed
```

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
            ┌───────┴───────┐
            │               │
     TLM Code Review   TLM QA Agent
     (defers if CI red) (post-deploy smoke)
            │               │
            └───────┬───────┘
                    ↓
            Auto-merge (if low-risk + CI passes + QA passes)
                    ↓
            Handoff Lifecycle Orchestrator tracks state
                    ↓
            TLM Outcome Tracker (daily assessment)
```

## Agent Evaluation

### TLM QA Agent — Tier 1

The QA Agent is currently in **Tier 1** (supervised mode). Graduation to Tier 2 (autonomous) requires:
- **20+ runs** recorded in `docs/tlm-action-ledger.json`
- **<10% false-negative rate** (smoke tests pass when deploy is actually broken)

Until graduation, QA Agent results are advisory only and do not block auto-merge.

## Key Files

### Control Plane (agent-forge repo)

| Subsystem | Path | Purpose |
|-----------|------|---------|
| ATC | `lib/atc.ts` | Air Traffic Controller cron: dispatch, monitoring, PR reconciliation (§2.8), project lifecycle (§13) |
| Orchestrator | `lib/orchestrator.ts` | Handoff generation + dispatch to target repos |
| Work Items | `lib/work-items.ts` | CRUD + dependency-aware dispatch (`getNextDispatchable`) |
| Decomposer | `lib/decomposer.ts` | Plan page → ordered work items with dependency DAG |
| Escalation | `lib/escalation.ts` | State machine: pending/resolved/expired, SLA timers |
| Gmail | `lib/gmail.ts` | OAuth2 client, escalation emails, decomposition summaries, reply polling |
| Notion | `lib/notion.ts` | Notion API client, `fetchPageContent()`, project status reads |
| Projects | `lib/projects.ts` | Project lifecycle: transition to Complete/Failed, status management |
| Storage | `lib/storage.ts` | Vercel Blob CRUD with auth headers |
| Types | `lib/types.ts` | Shared types (WorkItem, Project, source types including "project") |
| Repos | `lib/repos.ts` | Multi-repo registry with per-repo concurrency limits |
| GitHub helper | `lib/github.ts` | GitHub API wrapper for branches, pushes, workflow triggers, PR lookups |
| Hooks (SWR) | `lib/hooks.ts` | React data fetching hooks for dashboard |
| Handoffs | `handoffs/` | Version-controlled handoff files |

### Data Plane (per target repo, e.g., personal-assistant)

| Subsystem | Path | Purpose |
|-----------|------|---------|
| TLM Code Reviewer | `.github/actions/tlm-review/` | PR review with full codebase context |
| TLM Spec Reviewer | `.github/actions/tlm-spec-review/` | Handoff improvement before execution |
| TLM Outcome Tracker | `.github/actions/tlm-outcome-tracker/` | Daily assessment of merged PR outcomes |
| Feedback Compiler (in pipeline) | `.github/actions/tlm-feedback-compiler/` | Weekly self-improvement proposals |
| TLM QA Agent | `.github/actions/tlm-qa-agent/` | Post-deploy verification via Playwright + HTTP |
| Execute Handoff | `.github/workflows/execute-handoff.yml` | Claude Code runs handoff, waits for CI |
| TLM Review workflow | `.github/workflows/tlm-review.yml` | Triggers Code Reviewer on PR events |
| Spec Review workflow | `.github/workflows/tlm-spec-review.yml` | Triggers on handoff push |
| Outcome Tracker cron | `.github/workflows/tlm-outcome-tracker.yml` | Daily assessment cron |
| Handoff Orchestrator | `.github/workflows/handoff-orchestrator.yml` | Lifecycle state machine, CI retry |
| QA Agent workflow | `.github/workflows/tlm-qa-agent.yml` | Triggers on deployment_status + check_suite |
| CI Stuck PR Monitor | `.github/workflows/ci-stuck-pr-monitor.yml` | Alerts after 2h stuck |
| TLM shared memory | `docs/tlm-memory.md` | Rolling 20-entry review patterns + lessons |
| Action Ledger (in pipeline) | `docs/tlm-action-ledger.json` | Never-pruned outcome history |
| System map | `docs/SYSTEM_MAP.md` | This file |
| ADRs | `docs/adr/` | Architecture Decision Records (000-009) |

## Storage

| Store | Location | Purpose |
|-------|----------|---------|
| Work Items | Vercel Blob `af-data/work-items/*` | Work item CRUD |
| ATC State | Vercel Blob `af-data/atc/*` | Active executions, queue, dedup guards |
| Repo Config | Vercel Blob `af-data/repos/*` | Registered repo metadata |
| Escalations | Vercel Blob `escalations/*` | Escalation records + index |
| TLM Memory | `docs/tlm-memory.md` (in-repo) | Review patterns and lessons (rolling 20) |
| TLM Action Ledger | `docs/tlm-action-ledger.json` (in-repo, in pipeline) | Never-pruned outcome history |
| Feedback Compiler History | `docs/feedback-compiler-history.json` (in-repo, in pipeline) | Change effectiveness tracking |
| Local dev data | `data/` directory | File fallback for development |

## Integration Points

| From | To | Mechanism |
|------|-----|-----------|
| Agent Forge | Target repos | GitHub API (read files, create branches, push, trigger workflows) |
| Target repos | Agent Forge | Polling (workflow run status, PR status, CI checks) |
| PA | Agent Forge | `file_work_item` tool → `POST /api/work-items` (Bearer token auth) |
| Agent Forge | Notion | Notion API (read project plans, poll project status) |
| Agent Forge | Gmail | Gmail API OAuth2 (escalation emails, decomposition summaries, reply polling) |
| TLM QA Agent | Target app (deployed) | HTTP smoke tests with `QA_BYPASS_SECRET` header to bypass auth on protected routes |
| GitHub Issues | Agent Forge | Webhook or polling |

## Environment Variables

### Agent Forge (Vercel)

| Variable | Purpose |
|----------|---------|
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob access |
| `NOTION_API_KEY` | Notion API for project reads |
| `NOTION_PROJECTS_DB_ID` | Projects database ID |
| `GMAIL_CLIENT_ID` | Gmail OAuth2 |
| `GMAIL_CLIENT_SECRET` | Gmail OAuth2 |
| `GMAIL_REFRESH_TOKEN` | Gmail OAuth2 |
| `AGENT_FORGE_API_SECRET` | Bearer token for pipeline auth |
| `WORK_ITEMS_API_KEY` | Bearer token for PA → AF work item filing |
| `GH_PAT` | Fine-grained PAT for GitHub API (avoids token suppression) |
| `QA_BYPASS_SECRET` | Shared secret for QA Agent to bypass auth on protected routes during smoke tests |

### Target Repos (GitHub Secrets)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude API for TLM agents |
| `GH_PAT` | PAT for cross-workflow triggers |
| `AGENT_FORGE_API_SECRET` | Auth for escalation callbacks |
| `AGENT_FORGE_URL` | Agent Forge deployment URL |
| `QA_BYPASS_SECRET` | Shared secret injected into deployed app; validated by QA Agent smoke tests |
