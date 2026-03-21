# Agent Forge -- Add waveNumber column to database schema

## Metadata
- **Branch:** `feat/add-wave-number-column-to-db-schema`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/db/schema.ts

## Context

Agent Forge uses Neon Postgres as its work item store, accessed via Drizzle ORM. The schema is defined in `lib/db/schema.ts` and the database connection lives in `lib/db/index.ts`.

Wave-based features are being added to the platform to support batched dispatching of work items. This task adds the foundational `waveNumber` column to the `work_items` table — a nullable integer that future wave-based logic will populate and query.

The existing schema uses Drizzle's `pgTable` API with typed columns. The new column must be added as `integer('wave_number').nullable()` following the existing naming conventions (snake_case for DB column names, camelCase for the TypeScript key).

There is concurrent work on `app/agents/page.tsx` (branch `feat/refactor-agents-page-to-render-7-inngest-function-`). That work does not overlap with `lib/db/schema.ts`, so no coordination is needed.

## Requirements

1. `lib/db/schema.ts` must include a `waveNumber` field on the `work_items` table defined as `integer('wave_number').nullable()`
2. No other columns, constraints, or defaults are added — the column is purely nullable with no default
3. `npm run build` completes without TypeScript errors
4. `npx drizzle-kit generate` can generate a migration for the new column (verify it runs without error)
5. Existing work item CRUD operations in `lib/work-items.ts` are unaffected (no changes required there — the nullable column requires no default)
6. No changes to `app/agents/page.tsx` or any file touched by the concurrent work item

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-wave-number-column-to-db-schema
```

### Step 1: Inspect the existing schema

Read the current schema to understand column ordering and conventions before making changes:

```bash
cat lib/db/schema.ts
```

Identify:
- The `pgTable` call for `work_items`
- The existing column definitions and their naming pattern
- The import line for Drizzle column types (look for `integer` — it may or may not already be imported)

### Step 2: Add the `waveNumber` column to the schema

In `lib/db/schema.ts`, add the following column to the `work_items` table definition, after the existing columns (append at the end of the column list to minimise diff noise):

```ts
waveNumber: integer('wave_number').nullable(),
```

If `integer` is not already imported from `drizzle-orm/pg-core`, add it to the existing import. For example, if the current import looks like:

```ts
import { pgTable, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';
```

Update it to include `integer`:

```ts
import { pgTable, text, timestamp, boolean, jsonb, integer } from 'drizzle-orm/pg-core';
```

**Do not** add a default value, a `notNull()` constraint, or any index. The column must be purely:

```ts
waveNumber: integer('wave_number').nullable(),
```

### Step 3: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Resolve any type errors before proceeding. Common issues:
- `integer` not imported — fix the import as shown in Step 2
- Accidental syntax errors in the column list (missing comma before or after the new line)

### Step 4: Verify the build

```bash
npm run build
```

The build must complete successfully with no errors.

### Step 5: Verify Drizzle migration generation

```bash
npx drizzle-kit generate
```

This should produce a new migration file under `drizzle/` (or wherever the project's migration output directory is configured). Confirm the generated SQL includes `ALTER TABLE work_items ADD COLUMN wave_number integer;` or equivalent. The command must exit without errors.

> **Note:** Do not run `npx drizzle-kit push` or apply the migration to the database — migration execution is handled separately by the admin migrate route (`app/api/admin/migrate/route.ts`). Just confirm generation succeeds.

### Step 6: Confirm no regressions in work-items.ts

```bash
npx tsc --noEmit
```

Open `lib/work-items.ts` and visually confirm that:
- No existing `insert` or `update` calls are broken (the nullable column needs no value)
- The Drizzle inferred type for `WorkItem` now includes `waveNumber: number | null` — this is additive and safe

No changes to `lib/work-items.ts` should be required. If TypeScript complains about a `waveNumber` field being required somewhere, that indicates a `notNull()` was accidentally added — remove it.

### Step 7: Verification summary

```bash
npx tsc --noEmit
npm run build
```

Both must pass cleanly.

### Step 8: Commit, push, open PR

```bash
git add lib/db/schema.ts
# Also stage any generated migration file if drizzle-kit created one in the working tree
git add drizzle/ 2>/dev/null || true
git commit -m "feat: add waveNumber nullable integer column to work_items schema"
git push origin feat/add-wave-number-column-to-db-schema
gh pr create \
  --title "feat: add waveNumber column to work_items database schema" \
  --body "## Summary

Adds a nullable \`wave_number\` integer column to the \`work_items\` Drizzle schema. This is the foundational schema change required for wave-based dispatching features.

## Changes
- \`lib/db/schema.ts\`: Added \`waveNumber: integer('wave_number').nullable()\` to the \`work_items\` table

## Notes
- Column is nullable with no default — existing inserts and queries are fully unaffected
- \`npx drizzle-kit generate\` produces a valid migration for the new column
- No application logic changes; this is a pure schema addition

## Acceptance Criteria
- [x] \`lib/db/schema.ts\` contains \`waveNumber\` as \`integer().nullable()\`
- [x] \`npm run build\` passes
- [x] \`npx drizzle-kit generate\` runs without error
- [x] Existing work item queries unaffected
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-wave-number-column-to-db-schema
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If blocked by an unresolvable issue (e.g. unexpected schema structure, missing drizzle-kit config, environment issues), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-wave-number-column-to-db-schema",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/db/schema.ts"]
    }
  }'
```