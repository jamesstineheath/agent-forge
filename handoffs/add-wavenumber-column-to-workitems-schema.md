# Agent Forge -- Add waveNumber column to work_items schema

## Metadata
- **Branch:** `feat/wave-number-schema-column`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/db/schema.ts, lib/types.ts, migrations/

## Context

This is a foundational schema change to support wave-based execution features in Agent Forge. The `work_items` table (Neon Postgres via Drizzle ORM, defined in `lib/db/schema.ts`) needs a nullable `wave_number` integer column. All wave-based features (wave progress tracking, wave dispatching, wave UI) depend on this column existing first.

The column must be nullable so existing work items are unaffected — no backfill or default value is required.

Additionally, `lib/types.ts` needs a new `WaveProgressData` interface that multiple consumers will import. This type groups work items by wave number and tracks wave status.

**Concurrent work note:** `fix/prd-54-ac-7-agent-bugfix-work-items-write-through-` is modifying `app/api/work-items/route.ts` and `lib/bugs.ts`. This handoff does NOT touch those files — no coordination is needed beyond being aware of it.

**Existing patterns to follow:**
- `lib/db/schema.ts` uses Drizzle ORM with `integer()`, `text()`, `boolean()` column helpers. Look at existing nullable columns (e.g., fields that don't have `.notNull()`) for the pattern.
- `lib/types.ts` exports TypeScript interfaces and types; `WorkItem` is already defined there.
- Migrations live in a `migrations/` or `drizzle/` directory — check which one exists via `ls` before generating.

## Requirements

1. `lib/db/schema.ts` must contain a nullable integer column `waveNumber` mapped to column name `wave_number` on the `work_items` table definition (no `.notNull()`, no default).
2. A Drizzle migration SQL file must exist in the migrations directory that adds `wave_number` column as a nullable integer to the `work_items` table.
3. `lib/types.ts` must export a `WaveProgressData` interface with exactly these fields:
   - `waveNumber: number`
   - `items: WorkItem[]`
   - `status: 'pending' | 'active' | 'complete'`
4. `npm run build` passes with no TypeScript errors.
5. No modifications to `app/api/work-items/route.ts` or `lib/bugs.ts` (concurrent work conflict avoidance).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-number-schema-column
```

### Step 1: Inspect existing schema and migration structure

Before making changes, understand the current state:

```bash
# Check the existing schema file
cat lib/db/schema.ts

# Find where migrations live
ls -la migrations/ 2>/dev/null || ls -la drizzle/ 2>/dev/null || echo "Check package.json for drizzle config"

# Check drizzle config to confirm migration output directory
cat drizzle.config.ts 2>/dev/null || cat drizzle.config.js 2>/dev/null

# Check package.json for drizzle scripts
cat package.json | grep -A5 '"drizzle"'
```

### Step 2: Add `waveNumber` column to `lib/db/schema.ts`

Open `lib/db/schema.ts` and locate the `work_items` table definition. Add the `waveNumber` column as a nullable integer. It should follow the existing column ordering (append near the end of the column list, before any table closing).

The addition should look like:

```typescript
waveNumber: integer('wave_number'),
```

No `.notNull()` and no `.default()` — nullable by omission, which is Drizzle's default behavior.

**Example diff (adapt to actual file structure):**
```diff
  // ... existing columns ...
  retryCount: integer('retry_count'),
+ waveNumber: integer('wave_number'),
```

If the file uses a named import for `integer`, confirm `integer` is already imported from `drizzle-orm/pg-core`. If not, add it to the import.

### Step 3: Add `WaveProgressData` interface to `lib/types.ts`

Open `lib/types.ts` and locate where `WorkItem` is defined/exported. After the `WorkItem` interface (or in a logical grouping with other project/wave types), add:

```typescript
export interface WaveProgressData {
  waveNumber: number;
  items: WorkItem[];
  status: 'pending' | 'active' | 'complete';
}
```

Ensure `WorkItem` is defined before `WaveProgressData` in the file (it should already be), since `WaveProgressData` references it.

### Step 4: Generate the Drizzle migration

Run the Drizzle kit generate command to produce a migration SQL file:

```bash
# Standard command — use whichever matches the project's package.json scripts
npx drizzle-kit generate

# If the above doesn't work, try:
npx drizzle-kit generate:pg
```

This will create a new `.sql` file in the migrations directory (e.g., `migrations/0005_add_wave_number.sql` or similar). Verify it contains an `ALTER TABLE` statement adding the `wave_number` column:

```bash
# Verify the generated migration contains the expected SQL
cat migrations/*.sql | tail -30
# OR
cat drizzle/*.sql | tail -30
```

The generated SQL should look approximately like:
```sql
ALTER TABLE "work_items" ADD COLUMN "wave_number" integer;
```

**If `drizzle-kit generate` is unavailable or fails**, manually create the migration file:

```bash
# Find the migrations directory and highest-numbered existing file
ls migrations/ | sort

# Create the next migration file manually
# Name it after the next sequential number (e.g., 0005_wave_number.sql)
cat > migrations/0005_wave_number.sql << 'EOF'
ALTER TABLE "work_items" ADD COLUMN "wave_number" integer;
EOF
```

If using the manual approach, also update the Drizzle migrations journal/snapshot if one exists (check for `migrations/meta/` directory):

```bash
ls migrations/meta/ 2>/dev/null
```

If a `_journal.json` exists, you may need to add an entry. Check the format of existing entries and add a corresponding one for the new migration. If uncertain, skip this and note it in the PR — Drizzle will reconcile on next `db push`.

### Step 5: Verification

```bash
# TypeScript type check
npx tsc --noEmit

# Full build
npm run build

# Confirm schema file contains the new column
grep -n "wave_number\|waveNumber" lib/db/schema.ts

# Confirm types file contains WaveProgressData
grep -n "WaveProgressData" lib/types.ts

# Confirm migration file exists
find migrations/ drizzle/ -name "*.sql" 2>/dev/null | xargs grep -l "wave_number" 2>/dev/null || echo "WARNING: No migration file found with wave_number"
```

All commands should pass without errors. TypeScript should not report errors on the new nullable column or the new interface.

### Step 6: Commit, push, open PR

```bash
git add lib/db/schema.ts lib/types.ts
# Also stage migration files
git add migrations/ 2>/dev/null || git add drizzle/ 2>/dev/null || true

git add -A
git commit -m "feat: add waveNumber column to work_items schema and WaveProgressData type

- Add nullable integer wave_number column to work_items Drizzle schema
- Generate migration SQL file for wave_number column
- Add WaveProgressData interface to lib/types.ts

Foundational change for wave-based execution features."

git push origin feat/wave-number-schema-column

gh pr create \
  --title "feat: add waveNumber column to work_items schema and WaveProgressData type" \
  --body "## Summary

Foundational schema change for wave-based execution features.

### Changes
- **\`lib/db/schema.ts\`**: Added nullable \`integer('wave_number')\` column to \`work_items\` table
- **\`lib/types.ts\`**: Added \`WaveProgressData\` interface with \`waveNumber\`, \`items\`, and \`status\` fields
- **\`migrations/\`**: Drizzle-generated migration SQL to \`ALTER TABLE work_items ADD COLUMN wave_number integer\`

### Why nullable
Column has no \`.notNull()\` constraint so existing work items are unaffected — no backfill required.

### Acceptance Criteria
- [x] \`lib/db/schema.ts\` contains \`waveNumber: integer('wave_number')\` on work_items table
- [x] Migration file exists adding \`wave_number\` column
- [x] \`lib/types.ts\` exports \`WaveProgressData\` interface
- [x] \`npm run build\` passes with no type errors
- [x] Existing work item queries unaffected (nullable column, no default)

### Concurrent Work
This PR does not touch \`app/api/work-items/route.ts\` or \`lib/bugs.ts\` (reserved for \`fix/prd-54-ac-7-agent-bugfix-work-items-write-through-\`)." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wave-number-schema-column
FILES CHANGED: [list which of lib/db/schema.ts, lib/types.ts, migrations/*.sql were modified]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., drizzle-kit not available, migration journal format unclear]
NEXT STEPS: [what remains — e.g., manually create migration file, update journal]
```

### Common failure modes and mitigations

| Failure | Mitigation |
|---|---|
| `drizzle-kit generate` not found | Run `npx drizzle-kit generate` or check `package.json` for the exact script name |
| Migration journal (`_journal.json`) needs updating | Add entry matching existing format; if unclear, escalate |
| `integer` not imported in schema.ts | Add `integer` to the import from `drizzle-orm/pg-core` |
| Build fails due to unrelated errors | Note in PR, confirm this PR's changes themselves type-check cleanly |
| Migrations directory is `drizzle/` not `migrations/` | Use the actual directory found in Step 1 |

### Escalation

If you encounter a blocker that cannot be resolved autonomously (e.g., the Drizzle config points to an unexpected schema setup, or the migration journal format is ambiguous):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "wave-number-schema-column",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/db/schema.ts", "lib/types.ts"]
    }
  }'
```