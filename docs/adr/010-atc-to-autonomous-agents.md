# ADR-010: ATC Monolith → Autonomous Agent Architecture

## Status
Accepted (2026-03-18)

## Context
The Air Traffic Controller (ATC) was a single 1,750-line Vercel cron (`lib/atc.ts`) running every 5 minutes. It handled dispatch, health monitoring, project management, escalation, branch cleanup, and PR reconciliation in one sequential cycle. This created several problems:

- **Instability**: `lib/atc.ts` was modified in 14/22 recent PRs (64%), making it the highest-churn file.
- **No separation of concerns**: A timeout in dispatch could starve health monitoring.
- **Opaque failures**: When the ATC cycle failed, it was difficult to identify which phase caused it.
- **No independent scaling**: All phases ran at the same 5-minute cadence.

## Decision
Decompose the ATC monolith into 4 autonomous agents, each with independent Vercel cron routes, single responsibility, shared distributed lock, and structured event emission. Feature-gated via `AGENT_SPLIT_ENABLED`.

### Agents

| Agent | Route | Cadence | Goal |
|-------|-------|---------|------|
| Dispatcher | `/api/agents/dispatcher/cron` | 5 min | Maximize throughput within concurrency limits |
| Health Monitor | `/api/agents/health-monitor/cron` | 5 min | Every active execution progresses or gets unstuck |
| Project Manager | `/api/pm-agent` | 15 min | Move projects from planning to completion |
| Supervisor | `/api/agents/supervisor/cron` | 10 min | Every other agent is healthy and learning |

### Supporting Infrastructure

- **Event Bus** (`lib/event-bus.ts`): Durable webhook event log in Vercel Blob (hourly-partitioned, 7-day retention).
- **Feedback Compiler** (weekly cron): Reads TLM memory and outcomes, proposes prompt/config changes via PR.

### Migration Path

1. Event Bus + Webhook Handler (PR #240) - MERGED
2. Dispatcher + Health Monitor extraction (PR #244) - MERGED
3. Project Manager + Supervisor extraction (PR #245) - IN PROGRESS
4. Event-driven triggers (future) - webhooks invoke agents directly

Legacy `lib/atc.ts` remains as backward-compatible orchestrator, delegating phases 0-2 to extracted agents.

## Consequences

### Positive
- Each agent fails independently without starving other phases
- Agents can run at different cadences matching actual needs
- Structured event log enables observability and debugging
- Feature flag allows safe rollout and instant rollback

### Negative
- Distributed lock coordination adds complexity
- Multiple cron endpoints increase Vercel function invocations
- Backward-compatible wrapper adds temporary code debt

### Risks
- Lock contention between agents (mitigated by 5-min TTL + force-clear)
- Feature flag drift if AGENT_SPLIT_ENABLED not consistently applied
