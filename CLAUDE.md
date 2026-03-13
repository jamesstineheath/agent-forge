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

- **Work Item Store** (Vercel Blob, `af-data/work-items/*`): Project-agnostic store for filed, queued, and executed work items.
- **Orchestrator** (API route + Agent SDK): Reads repo context, generates handoff files, pushes to target repos, triggers execution.
- **Air Traffic Controller** (Vercel cron): Monitors executions, enforces concurrency, detects conflicts, manages queue.
- **Dashboard** (Next.js pages): Pipeline overview, work item backlog, execution detail, repo configuration.

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
- **Storage**: Vercel Blob (production) / local files (development)
- **UI**: Tailwind CSS v4, shadcn/ui
- **AI**: Anthropic Claude via AI SDK (`@ai-sdk/anthropic`, `ai`)

## Directory Structure

```
app/
  (app)/            # Auth-protected routes
    page.tsx        # Dashboard
    work-items/     # Work item CRUD + dispatch
    pipeline/       # Active executions, ATC view
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
- `BLOB_READ_WRITE_TOKEN` -- Vercel Blob storage
- `GOOGLE_AUTH_CLIENT_ID` -- Google OAuth
- `GOOGLE_AUTH_CLIENT_SECRET` -- Google OAuth
- `CRON_SECRET` -- Vercel cron authentication

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
| TLM Spec Review | Push to `handoffs/**` | Review/improve handoff files |
| Execute Handoff | Spec Review completion | Execute handoff via Claude Code |
| TLM Code Review | PR events, check_suite | Review PR diffs with context |
| TLM Outcome Tracker | Daily cron | Assess merged PR outcomes |

## Relationship to PA

Agent Forge was extracted from the PA's self-improvement pipeline. The PA handles life management (calendar, email, tasks, meals, training). Agent Forge handles dev orchestration (work items, handoffs, execution, review). They communicate through:
- PA improvements API (work item source)
- GitHub API (execution layer)
- Markdown handoff files (interface contract)
