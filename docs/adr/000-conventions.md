# ADR-000: Architecture Decision Record Conventions

## Status

Accepted

## Context

Agent Forge needs a lightweight way to capture architectural decisions so that future sessions (human or AI) understand *why* the system is built the way it is.

## Decision

We use Architecture Decision Records (ADRs) following this format:

```markdown
# ADR-NNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-NNN

## Context
What situation prompted this decision?

## Decision
What did we decide and why?

## Consequences
What are the trade-offs? What becomes easier or harder?
```

### Conventions

- Number sequentially: `001`, `002`, etc.
- File naming: `docs/adr/NNN-short-title.md`
- Write an ADR when a work item changes how components interact, where responsibilities live, or involves choosing between reasonable alternatives
- Keep them concise -- a few paragraphs, not a design doc
- ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one
- Claude Code is expected to create ADRs as part of normal work, not as a separate task

## Consequences

- Decisions are discoverable and auditable
- Future sessions don't re-litigate settled questions
- Small overhead per decision (5-10 minutes to write)
