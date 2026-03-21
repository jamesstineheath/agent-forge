# Neon Postgres Migration Status

**Date:** 2026-03-21
**PRs:** #410 (migration), #411 (test fixes)

## Migration: Work Item Store (Vercel Blob → Neon Postgres)

**Status: Complete and verified in production.**

### What changed
- Work item store moved from Vercel Blob (two-layer: individual blobs + index blob) to Neon Postgres via Drizzle ORM
- Eliminates fatal race condition: concurrent index blob writers caused items to disappear, status reverts, and reconciliation deleting valid items
- 43 consumer files work without changes (API surface preserved)

### Schema
- Single `work_items` table with 28 columns (JSONB for nested objects: source, handoff, execution, escalation)
- Indexes on status, target_repo, (status, target_repo), (status, priority)
- New `prd_id` column (nullable) for PRD-prefixed items

### Production verification
- **Table created:** `drizzle-kit push` executed against Neon
- **Data migrated:** 412 work items from Blob → Postgres (0 errors, 0 skipped)
- **Dispatcher:** Confirmed reading from Postgres (last run 06:45 UTC, 412 total items)
- **Supervisor:** blob-reconciliation phase runs as no-op (67ms, success)
- **MCP tools:** All queries returning correct data from Postgres
- **Tests:** 188/188 passing (mocks updated from storage → db layer)
- **Build:** `tsc --noEmit` and `npm run build` both pass

### Dashboard changes
- Home page: replaced old Projects section with work items summary grid (active, queued, merged 24h, failed)
- Projects page: removed Notion Projects DB dependency, derives status from work item pipeline state

### Post-merge checklist
- [x] `DATABASE_URL` set in Vercel environment
- [x] `drizzle-kit push` to create table
- [x] `POST /api/admin/migrate-work-items` to populate Postgres from Blob
- [x] Dispatcher reads/dispatches from Postgres
- [x] Supervisor blob-reconciliation is no-op
- [x] Dashboard shows work items summary
- [x] Old Blob data retained as backup (not deleted)
