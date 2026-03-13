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
│  ┌──────┴─────────────────┴──────────────────┴───────┐  │
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
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ TLM Outcome  │  │    Repo      │                     │
│  │   Tracker    │  │  Metadata    │                     │
│  │  (daily cron)│  │ (CLAUDE.md,  │                     │
│  └──────────────┘  │ system map,  │                     │
│                    │ ADRs)        │                     │
│                    └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

### Work Item Lifecycle

```
Filed → Ready → Queued → Generating → Executing → Reviewing → Merged
                  │                                     │
                  └── Parked (blocked/failed) ←─────────┘
```

1. **Filed**: Work item created from PA improvements API, GitHub issue, or manual entry
2. **Ready**: Triaged and prioritized, ready for dispatch
3. **Queued**: Dispatched but waiting for pipeline capacity
4. **Generating**: Orchestrator reading repo context and generating handoff
5. **Executing**: Handoff pushed to target repo, Execute Handoff workflow running
6. **Reviewing**: PR opened, TLM Code Review in progress
7. **Merged**: PR merged (auto or manual), outcome tracked

### Execution Flow (per work item)

```
Orchestrator → Push handoff to branch
                    ↓
            TLM Spec Review (improve handoff)
                    ↓
            Execute Handoff (Claude Code runs handoff)
                    ↓
            PR opened with execution results
                    ↓
            TLM Code Review
                    ↓
            Auto-merge (if low-risk + CI passes)
                    ↓
            TLM Outcome Tracker (daily assessment)
```

## Storage

| Store | Location | Purpose |
|-------|----------|---------|
| Work Items | Vercel Blob `af-data/work-items/*` | Work item CRUD |
| ATC State | Vercel Blob `af-data/atc/*` | Active executions, queue |
| Repo Config | Vercel Blob `af-data/repos/*` | Registered repo metadata |
| TLM Memory | `docs/tlm-memory.md` (in-repo) | Review patterns and lessons |
| Local dev data | `data/` directory | File fallback for development |

## Integration Points

| From | To | Mechanism |
|------|-----|-----------|
| Agent Forge | Target repos | GitHub API (read files, create branches, push, trigger workflows) |
| Target repos | Agent Forge | Polling (workflow run status, PR status, CI checks) |
| PA | Agent Forge | Improvements API (webhook or polling) |
| GitHub Issues | Agent Forge | Webhook or polling |
