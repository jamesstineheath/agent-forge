# Agent Forge -- Add waveNumber column to database schema

## Metadata
- **Branch:** `feat/add-wave-number-column-to-db-schema`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/db/schema.ts, drizzle/*.sql (generated migration)

## Context

Agent Forge uses Neon Postgres as its work item store, accessed via Drizzle ORM. The schema is defined in `lib/db/schema.ts` and the database connection lives in `lib/db/index.ts`.

Wave-based features are being added to the platform to support batched dispatching of work items. This task adds the foundational `waveNumber` column to the `work_items` table — a nullable integer that future wave-based logic will populate and query.

The existing schema uses Drizzle's `pgTable` API with typed columns. The new column must be added as `integer('wave_number').nullable()` following the existing naming conventions (snake_case for DB column names, camelCase for the TypeScript key).

There is concurrent work on `app/agents/page.tsx` (branch `feat/refactor-agents-page-to-render-7-inngest-function-`). That work does not overlap with `lib/db/schema.ts`, so no coordination is needed.

> **⚠️ CRITICAL — Schema Change Hot Pattern:** Per TLM memory, any PR that modifies `lib/db/schema.ts` MUST have its corresponding migration applied to the live Neon database before or at merge time. Drizzle ORM generates SQL referencing ALL columns in the schema definition. If the schema defines `wave_number` but the database lacks the column, every query against `work_items` will fail at runtime. The migration must be applied via `POST /api/admin/migrate` or manual SQL before this PR merges.

## Requirements

1. `lib/db/schema.ts` must include a `waveNumber` field on the `work_items` table defined as `integer('wave_number').nullable()`
2. No other columns, constraints, or defaults are added — the column is purely nullable with no default
3. `npm run build` completes without TypeScript errors
4. `npx drizzle-kit generate` produces a valid migration for the new column (verify it runs without error)
5. Existing work item CRUD operations in `lib/work-items.ts` are unaffected (no changes required there — the nullable column requires no default)
6. No changes to `app/agents/page.tsx` or any file touched by the concurrent work item
7. The PR body must include a reminder that the migration must be applied to the live database before merge

## Execution Steps

### Step 0: Pre-flight checks