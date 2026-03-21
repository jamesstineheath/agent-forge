# ADR-012: Work Item Store Migration from Vercel Blob to Neon Postgres

**Date:** 2026-03-21
**Status:** Accepted
**Deciders:** James Heath

## Context

The work item store used a two-layer Vercel Blob design: individual JSON blobs per item (source of truth) and a single index blob for fast listing. This had a fatal race condition: any concurrent writer that loaded the index between another writer's load and save would overwrite the other's changes (last-writer-wins, no locking).

Observed symptoms:
- Work items disappearing from the store (index entry lost during concurrent writes)
- Status updates reverting (e.g., `ready` reverting to `filed` when a cron agent writes a stale index copy)
- `update_work_item` returning the correct status but the change not persisting
- Blob reconciliation deleting "dangling" blobs that were actually real items whose index entries were lost

The write-through cache (120s TTL) and hourly blob reconciliation were band-aids that reduced but did not eliminate the problem.

## Decision

Migrate the work item store to Neon Postgres via Drizzle ORM and `@neondatabase/serverless`.

### Why Neon + Drizzle
- **Neon**: Already provisioned via Vercel integration. HTTP-based driver (`@neondatabase/serverless`) is stateless and optimized for serverless — no connection pooling needed.
- **Drizzle**: Lightweight, TypeScript-first ORM. Schema-as-code with migration generation. No runtime overhead compared to Prisma.
- **JSONB columns**: For nested objects (`source`, `handoff`, `execution`, `escalation`) — keeps the schema flexible without normalizing every field.

### What changed
- `lib/db/schema.ts`: Drizzle schema with 28 columns, 4 indexes
- `lib/db/index.ts`: Lazy-initialized connection via Proxy (avoids build-time crash when `DATABASE_URL` is absent)
- `lib/work-items.ts`: Full rewrite — all functions use SQL queries. API surface preserved (43 consumer files unchanged).
- `reconcileWorkItemIndex` / `rebuildIndex`: Now no-ops (kept for API compat)
- `runBlobReconciliation` in supervisor: Now a no-op
- Migration endpoint: `POST /api/admin/migrate-work-items` (one-time, idempotent)

### What didn't change
- `lib/storage.ts`: Still used by escalations, event bus, ATC state, PM agent cache, repo config
- Vercel Blob: Still the storage backend for all non-work-item data
- Work item blobs: Left in place as backup (not deleted)

## Consequences

### Positive
- **No more race conditions**: Single atomic INSERT/UPDATE replaces load-index → modify → save-index
- **No more N+1 queries**: `findWorkItemByBranch` and `findWorkItemByPR` use JSONB queries (single scan vs loading each blob)
- **No more reconciliation**: No index/blob drift possible with single source of truth
- **No CDN cache issues**: Postgres queries are always fresh (Blob CDN had 60s minimum TTL)

### Negative
- **New dependency**: `DATABASE_URL` env var required. If Neon is down, work items are unavailable (previously Blob was the single dependency).
- **Test complexity**: Tests must mock `@/lib/db` and `drizzle-orm` instead of the simpler `@/lib/storage` mock. Uses `vi.hoisted()` pattern.
- **Mixed storage**: Work items in Postgres, everything else in Blob. Two mental models until further migrations.

### Risks
- Neon free tier has connection limits. Current usage (4 cron agents at 5-15 min intervals + MCP + dashboard) is well within limits.
- If `DATABASE_URL` is misconfigured, all work item operations fail. The lazy init throws a clear error.
