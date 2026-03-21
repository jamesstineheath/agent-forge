# Agent Forge -- Claude Code Context

> Read this file automatically at the start of every Claude Code session.

## What This Is

A dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams across multiple repositories. Agent Forge is the **control plane** -- it decides what work happens and monitors progress. Target repos are the **data plane** -- they execute the work via GitHub Actions.

- **Production**: TBD (Vercel deployment pending)
- **GitHub**: https://github.com/jamesstineheath/agent-forge (public)
- **Branch strategy**: `main` is protected. Work on feature branches, merge via PR.
- **Auth**: Google OAuth (james.stine.heath@gmail.com only)

## Architecture

### Control Plane (this repo)

- **Work Item Store** (Neon Postgres, `work_items` table): Project-agnostic store for filed, queued, and executed work items. Migrated from Vercel Blob to eliminate race conditions.
- **Orchestrator** (API route + Agent SDK): Reads repo context, generates handoff files, pushes to target repos, triggers execution.
- **4 Autonomous Agents** (independent Vercel crons, `lib/atc/`):
  - **Dispatcher** (5 min): Picks up `ready` items, checks concurrency/conflicts, dispatches to target repos.
  - **Health Monitor** (5 min): Detects stalls, CI failures (classifies infra vs code), retries, merge conflict repair.
  - **Project Manager** (15 min): Decomposes projects into work items, manages dependencies, tracks project lifecycle.
  - **Supervisor** (10 min): Monitors other agents for staleness/errors, manages escalations, drift detection, branch cleanup.
- **Event Bus** (`/api/webhooks/github`): Durable webhook event log, 30-day retention. Agents read events first (fast), fall back to API polling.
- **Dashboard** (Next.js pages): Pipeline overview, work item backlog, agent health/traces, execution detail, repo configuration.

> **Note:** The ATC monolith (`lib/atc.ts`) was replaced by these 4 agents on 2026-03-18 (ADR-010). The old `/api/atc/cron` route is removed. Do not modify `lib/atc.ts`.

### Data Plane (target repos)

Each target repo maintains its own execution infrastructure:
- `execute-handoff.yml` -- GitHub Actions workflow that runs Claude Code to execute handoff files
- TLM Spec Review -- Reviews/improves handoff files before execution
- TLM Code Review -- Reviews PRs, auto-merges low-risk changes
- TLM Outcome Tracker -- Daily cron assessing merged PR outcomes
- Repo metadata -- CLAUDE.md, docs/SYSTEM_MAP.md, docs/adr/

### Integration

Agent Forge communicates with target repos entirely through the GitHub API:
1. Read context: GET file contents (CLAUDE.md, system map, ADRs)
2. Push handoffs: Create branch, commit handoff file, push
3. Trigger execution: workflow_dispatch on execute-handoff.yml
4. Monitor progress: Poll workflow runs, PR status, CI
5. Read results: PR descriptions (execution records), review comments

## Tech Stack

- **Framework**: Next.js 16 App Router
- **Auth**: Auth.js v5 (next-auth@beta) with Google OAuth
- **Storage**: Neon Postgres (work items via Drizzle ORM), Vercel Blob (other data) / local files (development)
- **UI**: Tailwind CSS v4, shadcn/ui
- **AI**: Anthropic Claude via AI SDK (`@ai-sdk/anthropic`, `ai`)

## Directory Structure

```
app/
  (app)/            # Auth-protected routes
    page.tsx        # Dashboard
    work-items/     # Work item CRUD + dispatch
    pipeline/       # Active executions, pipeline view
    agents/         # Agent health, heartbeat, traces
    repos/          # Repo registration
    settings/       # Global configuration
  (auth)/           # Public routes
    sign-in/        # Google OAuth sign-in
  api/
    auth/           # Auth.js route handler
lib/
  auth.ts           # Auth.js configuration
  storage.ts        # Vercel Blob / local file storage
  utils.ts          # shadcn/ui utilities
  atc/              # Autonomous agent implementations
    dispatcher.ts   # Work item dispatch logic
    health-monitor.ts # CI failure detection, stall recovery, retries
    project-manager.ts # Project decomposition, lifecycle
    supervisor.ts   # Agent monitoring, escalations, drift detection
    tracing.ts      # Structured agent trace logging
    events.ts       # Event bus persistence
    ci-classifier.ts # CI failure classification (infra vs code)
components/
  ui/               # shadcn/ui components
  sidebar.tsx       # App navigation
  theme-provider.tsx
docs/
  SYSTEM_MAP.md     # Architecture diagram
  tlm-memory.md     # TLM shared review memory
  adr/              # Architecture Decision Records
handoffs/           # Handoff file directory
.github/
  workflows/        # CI + TLM pipeline workflows
  actions/          # TLM composite actions (review, spec-review, outcome-tracker)
```

## Environment Variables

### Vercel (production)
- `ANTHROPIC_API_KEY` -- Claude API access
- `AUTH_SECRET` -- Auth.js session encryption (generate with `openssl rand -base64 32`)
- `DATABASE_URL` -- Neon Postgres connection string (work item store)
- `BLOB_READ_WRITE_TOKEN` -- Vercel Blob storage (non-work-item data)
- `GOOGLE_AUTH_CLIENT_ID` -- Google OAuth
- `GOOGLE_AUTH_CLIENT_SECRET` -- Google OAuth
- `CRON_SECRET` -- Vercel cron authentication
- `WORK_ITEMS_API_KEY` -- Bearer token auth for `/api/work-items` (server-to-server calls from PA)
- `AGENT_FORGE_API_SECRET` -- Bearer token auth for `/api/escalations` (pipeline agent calls)
- `GITHUB_WEBHOOK_SECRET` -- HMAC-SHA256 secret for verifying GitHub webhook payloads at `/api/webhooks/github`
- `AGENT_SPLIT_ENABLED` -- Feature flag: `true` enables 4 independent agent crons, `false` (or unset) keeps legacy ATC
- `AGENT_FORGE_URL` -- Production URL (e.g., `https://agent-forge-phi.vercel.app`)
- `QA_BYPASS_SECRET` -- Auth bypass token for QA Agent Playwright tests against preview deployments

### GitHub Secrets
- `ANTHROPIC_API_KEY` -- For TLM agents in GitHub Actions
- `GH_PAT` -- Fine-grained PAT with contents:write + pull_requests:write for pipeline-generated PRs

## Conventions

- All TLM agents use `claude-opus-4-6`. Cost optimization deferred.
- Handoff files use v3 format (Step 0, budget metadata, abort protocol).
- Documentation is a byproduct of work, not a separate task.
- ADRs capture architectural decisions. Format in `docs/adr/000-conventions.md`.

## TLM Pipeline

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| CI | Push/PR to main | Build + test |
| TLM Spec Review | Push to `handoffs/**`, workflow_dispatch | Review/improve handoff files |
| Execute Handoff | Spec Review completion, workflow_dispatch | Execute handoff via Claude Code |
| TLM Code Review | PR events, check_suite | Review PR diffs with context; enforces TLM memory hot patterns |
| TLM Outcome Tracker | Daily 9am UTC | Assess merged PR outcomes, update TLM memory |
| TLM Feedback Compiler | Daily 10pm UTC | Analyze outcome patterns, propose prompt/config improvements |
| TLM Trace Reviewer | Daily 6am UTC | Review agent traces for anomalies, update TLM memory |
| TLM QA Agent | Vercel deployment_status | Playwright tests against preview deployments (Tier 1 advisory) |
| Handoff Lifecycle Orchestrator | Workflow run events | Track handoff state machine across spec→execute→CI→review→merge |

### Dispatch from Cowork/Chat (no local checkout)

When dispatching handoffs from Cowork via GitHub MCP (`create_or_update_file`), pushes via the GitHub Contents API may intermittently fail to fire `on: push` workflow events. This is a known GitHub behavior. After pushing a handoff to a branch, verify the TLM Spec Review workflow fires within a few minutes on the Actions tab. If it does not, manually trigger the workflow via `workflow_dispatch`, selecting the correct branch. Local `git push` always fires events reliably.

## Relationship to PA

Agent Forge was extracted from the PA's self-improvement pipeline. The PA handles life management (calendar, email, tasks, meals, training). Agent Forge handles dev orchestration (work items, handoffs, execution, review). They communicate through:
- PA improvements API (work item source)
- GitHub API (execution layer)
- Markdown handoff files (interface contract)
