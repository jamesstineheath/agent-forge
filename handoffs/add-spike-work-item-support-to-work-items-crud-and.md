# Agent Forge -- Add spike work item support to work-items CRUD and API

## Metadata
- **Branch:** `feat/spike-work-item-crud-and-api`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/work-items.ts, app/api/work-items/route.ts

## Context

Agent Forge manages work items in a Neon Postgres database via Drizzle ORM (`lib/db/schema.ts`, `lib/db/index.ts`). The `lib/work-items.ts` file provides CRUD operations, and `app/api/work-items/route.ts` exposes the REST API.

A recent PR (`feat: add spike types and SpikeRecommendation enum to shared types`) added spike-related types to `lib/types.ts`. This work item wires those types into the actual persistence layer and API route.

The `lib/types.ts` file already defines spike-related types — inspect it first to understand the exact shape of `SpikeMetadata` and the `'spike'` work item type before making changes. Based on the description, `spikeMetadata` requires at minimum `parentPrdId` and `technicalQuestion` fields.

**Concurrent work warning:** `fix/create-spike-findings-template-and-parser-utility` is active and touches `lib/spike-template.ts` only — no overlap with files in this handoff.

## Requirements

1. `lib/work-items.ts` `createWorkItem` (or equivalent filing function) accepts `type: 'spike'` and `spikeMetadata` fields and persists them to the database.
2. Validation rejects spike work items that are missing `spikeMetadata`, `spikeMetadata.parentPrdId`, or `spikeMetadata.technicalQuestion` — returns a clear error.
3. `POST /api/work-items` accepts `type: 'spike'` with `spikeMetadata` in the request body and validates fields before calling the store.
4. Non-spike work items continue to work unchanged (full backward compatibility — `spikeMetadata` is optional on non-spike items).
5. TypeScript compiles without errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spike-work-item-crud-and-api
```

### Step 1: Inspect existing types and schema

Read the relevant files to understand current shapes before modifying anything:

```bash
cat lib/types.ts | grep -A 40 -i spike
cat lib/db/schema.ts
cat lib/work-items.ts
cat app/api/work-items/route.ts
```

Key things to confirm:
- The exact TypeScript type for `SpikeMetadata` in `lib/types.ts` (especially required fields)
- Whether `spikeMetadata` is already a column in the Drizzle schema (`lib/db/schema.ts`), or needs to be added as a JSONB column
- The current signature of `createWorkItem` (or `fileWorkItem` / equivalent) in `lib/work-items.ts`
- How the POST handler in `app/api/work-items/route.ts` currently parses and validates the request body

### Step 2: Add spikeMetadata column to Drizzle schema (if not already present)

If `lib/db/schema.ts` does not already have a `spikeMetadata` column on the `work_items` table, add it as a nullable JSONB column:

```typescript
// In lib/db/schema.ts, inside the work_items table definition:
spikeMetadata: json('spike_metadata').$type<SpikeMetadata>(),
```

Import `SpikeMetadata` from `lib/types.ts` at the top of the schema file if not already imported.

> **Note:** If there is no migration runner in the repo (check `app/api/admin/migrate/route.ts` from recent PRs), you may need to add the column via a raw SQL migration. Check the existing migration pattern used in the repo. If Drizzle `db.execute(sql`...`)` is the pattern, use it. If the column already exists (schema was added ahead of this work), skip this step.

### Step 3: Modify lib/work-items.ts

Add spike validation and persistence support. The changes follow this pattern:

**3a. Import SpikeMetadata type** (if not already imported):
```typescript
import type { SpikeMetadata } from './types';
```

**3b. Update the input type for `createWorkItem`** to accept optional `spikeMetadata` and allow `type: 'spike'`:

The `WorkItem` type in `lib/types.ts` likely already models this. Ensure the function parameter type reflects it. If the function uses an inline object type rather than the shared `WorkItem` type, extend it:

```typescript
// Example pattern — adapt to what already exists:
type CreateWorkItemInput = {
  // ... existing fields ...
  type?: WorkItem['type']; // must support 'spike'
  spikeMetadata?: SpikeMetadata;
};
```

**3c. Add spike validation** near the top of `createWorkItem`, before the DB insert:

```typescript
// Spike-specific validation
if (input.type === 'spike') {
  if (!input.spikeMetadata) {
    throw new Error('Spike work items must include spikeMetadata');
  }
  if (!input.spikeMetadata.parentPrdId) {
    throw new Error('Spike work items must have spikeMetadata.parentPrdId');
  }
  if (!input.spikeMetadata.technicalQuestion) {
    throw new Error('Spike work items must have spikeMetadata.technicalQuestion');
  }
}
```

**3d. Persist spikeMetadata** in the DB insert:

```typescript
// Inside the db.insert(...).values({...}) call, add:
spikeMetadata: input.spikeMetadata ?? null,
```

### Step 4: Modify app/api/work-items/route.ts POST handler

**4a. Extract `spikeMetadata` from the request body** alongside existing fields:

```typescript
const { /* ...existing fields... */, type, spikeMetadata } = await req.json();
```

**4b. Add API-level spike validation** (returns HTTP 400 with a descriptive message):

```typescript
if (type === 'spike') {
  if (!spikeMetadata || !spikeMetadata.parentPrdId || !spikeMetadata.technicalQuestion) {
    return NextResponse.json(
      {
        error:
          'Spike work items require spikeMetadata with parentPrdId and technicalQuestion',
      },
      { status: 400 }
    );
  }
}
```

**4c. Pass `type` and `spikeMetadata` to the store function**:

```typescript
await createWorkItem({
  // ...existing fields...
  type,
  spikeMetadata,
});
```

Ensure `spikeMetadata` is only passed when present (undefined/null is fine for non-spike items — the store must remain backward compatible).

### Step 5: Handle database migration (if schema changed)

Check whether there is an admin migration endpoint (`app/api/admin/migrate/route.ts` was referenced in a recent PR). If the `spike_metadata` column doesn't exist in the DB yet, follow the established migration pattern:

```bash
# Check if a migration route exists:
cat app/api/admin/migrate/route.ts 2>/dev/null || echo "No migration route"
```

If the project uses Drizzle `push` or a migration file approach, add the migration for the new column. If a raw SQL approach is used, add:

```sql
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS spike_metadata jsonb;
```

Use whatever mechanism is already established in the codebase.

### Step 6: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Run tests if present
npm test 2>/dev/null || echo "No test suite configured"
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- `spikeMetadata` column type mismatch between schema and `WorkItem` type
- Drizzle insert rejecting a field that's not in the schema definition
- `type` field being too narrowly typed in the existing insert (e.g., a union that doesn't include `'spike'`)

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add spike work item support to CRUD and API

- Accept type: 'spike' and spikeMetadata in createWorkItem
- Validate spike items require parentPrdId and technicalQuestion
- POST /api/work-items validates and passes through spikeMetadata
- Backward compatible: non-spike items unchanged
- Add spike_metadata JSONB column to work_items schema (if not present)"

git push origin feat/spike-work-item-crud-and-api

gh pr create \
  --title "feat: add spike work item support to work-items CRUD and API" \
  --body "## Summary

Wires spike work item support into the persistence layer and REST API.

## Changes
- \`lib/work-items.ts\`: \`createWorkItem\` now accepts \`type: 'spike'\` and \`spikeMetadata\`, with validation requiring \`parentPrdId\` and \`technicalQuestion\`
- \`app/api/work-items/route.ts\`: POST handler accepts and validates spike fields, returns HTTP 400 on missing required spike metadata
- \`lib/db/schema.ts\`: Added \`spike_metadata\` JSONB column (if not already present)

## Backward Compatibility
Non-spike work items are fully unchanged. \`spikeMetadata\` is optional and only validated when \`type === 'spike'\`.

## Acceptance Criteria
- [x] createWorkItem accepts and persists type: 'spike' and spikeMetadata
- [x] Validation rejects spike items missing parentPrdId or technicalQuestion
- [x] POST /api/work-items accepts type: 'spike' with spikeMetadata
- [x] Non-spike work items unchanged
- [x] TypeScript compiles without errors

## Notes
No file overlap with concurrent branch \`fix/create-spike-findings-template-and-parser-utility\` (that branch only touches \`lib/spike-template.ts\`)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/spike-work-item-crud-and-api
FILES CHANGED: [list files actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "migration not applied", "spikeMetadata not persisted"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., the Drizzle schema uses a migration system requiring DB credentials not available in CI, or `SpikeMetadata` type in `lib/types.ts` is missing required fields and needs a human decision on the shape), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "spike-work-item-crud-and-api",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/work-items.ts", "app/api/work-items/route.ts", "lib/db/schema.ts"]
    }
  }'
```