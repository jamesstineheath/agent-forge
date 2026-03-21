# ADR-013: Pipeline v2 — Plan-Based Execution

**Status:** Accepted
**Date:** 2026-03-21
**PRD:** PRD-65
**PR:** #469

## Context

The Agent Forge pipeline decomposes PRDs into N independent work items, each getting its own branch, Claude Code session, and PR. Every work item executes in isolation with zero knowledge of what sibling items changed. This produces:

- **52% work item success rate** — most failures are structural (missing context, wrong assumptions)
- **Merge conflicts between siblings** — items modify overlapping files
- **Fragmented TLM review** — Code Reviewer sees N narrow PRs instead of one coherent change
- **Three expensive LLM calls per PRD** — architecture planning and decomposition use Opus, costing $3-8 before any code is written
- **Orchestrator complexity** — the Orchestrator needs implementation-level detail in handoff files because each executor has no codebase context

## Decision

Replace the N-work-item model with **1 PRD = 1 Plan = 1 Branch = 1 PR**.

### Plan Pipeline (data-gathering, no LLM calls)

For each Approved PRD:
1. Fetch acceptance criteria text from Notion
2. Query Knowledge Graph for affected files (keyword search + blast radius)
3. Estimate budget (criteria count * $8/criterion)
4. Estimate max duration (1-3 criteria = 60min, 4-6 = 120min, 7+ = 180min)
5. Create Plan record in Neon Postgres with status "ready" (or "needs_review" if budget > $30)

This replaces three steps that used Opus: criteria import, architecture planning, and decomposition.

### Dispatcher

Reads "ready" Plans, checks per-repo concurrency via KG file overlap detection, and triggers the execute-handoff GitHub Action with plan inputs (plan_id, max_budget, max_duration_minutes).

### Execute-Handoff (dual-mode)

The workflow now supports both legacy handoff files and Pipeline v2 plan prompts. In plan mode:
1. Fetches plan from Agent Forge API
2. Reports "executing" status
3. Creates branch if it doesn't exist
4. Generates plan prompt with acceptance criteria + KG context + constraints
5. Runs Claude Code CLI with the plan prompt
6. Opens PR, waits for CI
7. Reports completion status (reviewing/failed/timed_out) back to Agent Forge

### Session Memory

Claude Code maintains a `PLAN_STATUS.md` on the branch during execution, tracking progress per criterion. On retry, it reads this file to continue from where it left off. The file is removed before PR creation.

## Consequences

### Positive

- **Single coherent PR per PRD** — TLM reviews one change, not N fragments
- **No merge conflicts** — one branch, one executor
- **No LLM planning costs** — acceptance criteria ARE the plan
- **Claude Code has full context** — reads the codebase like interactive use
- **Simpler architecture** — removes orchestrator, decomposer, wave scheduler, work item state machine
- **Resume on retry** — PLAN_STATUS.md preserves progress across attempts

### Negative

- **Larger PRs** — one PR may be bigger than N small ones (mitigated by incremental commits)
- **Longer execution times** — one session handles the full PRD (mitigated by configurable max duration)
- **No parallelism within a PRD** — work items could run in parallel; a plan is sequential (accepted trade-off for coherence)

### Preserved

- Work items table kept as read-only for historical data
- Work item MCP tools kept for backward compatibility
- TLM workflows unchanged (trigger on PR events)
- Knowledge Graph used more heavily (blast radius for concurrency, context for prompts)

## Alternatives Considered

1. **Fix the decomposer** — Improve decomposition quality, add better context sharing between work items. Rejected: fundamental architecture issue, not a quality problem.
2. **Shared branch model** — Multiple work items commit to one branch. Rejected: still requires decomposition and coordination, adds merge complexity within the branch.
3. **Plan + decompose at runtime** — Have Claude Code decompose during execution. Rejected: unnecessary complexity, Claude Code already plans incrementally.
