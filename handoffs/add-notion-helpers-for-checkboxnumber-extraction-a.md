# Agent Forge -- Add Notion helpers for checkbox/number extraction and retry queries

## Metadata
- **Branch:** `feat/notion-retry-helpers`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/notion.ts, lib/types.ts

## Context

Agent Forge uses Notion as a project management backend. `lib/notion.ts` contains the Notion API client, property extractors (e.g., `extractText`, `extractSelect`), and `pageToProject()` which maps raw Notion API responses to typed `Project` objects.

A recent work item (`feat: extend types with retry fields and project_retry event`) added `retry: boolean` and `retryCount: number` fields to the `Project` type in `lib/types.ts`. However, `pageToProject()` does not yet populate these fields from Notion page properties. This handoff adds the missing helpers and wires them up.

The existing pattern in `lib/notion.ts` for property extraction looks like:

```typescript
function extractText(page: any, propertyName: string): string {
  const prop = page.properties?.[propertyName];
  if (!prop) return '';
  // handle rich_text, title, etc.
  return '';
}
```

And queries follow:

```typescript
export async function queryProjects(filter?: any): Promise<Project[]> {
  const response = await notion.databases.query({
    database_id: notionProjectsDbId,
    filter,
  });
  return response.results.map(pageToProject);
}
```

This task adds `extractCheckbox`, `extractNumber`, updates `pageToProject`, adds `queryRetryProjects`, and adds `updateProjectProperties` — all following these established patterns.

## Requirements

1. `extractCheckbox(page: any, propertyName: string): boolean` — reads `page.properties?.[propertyName]?.checkbox` and returns it as a boolean; returns `false` for missing or null properties
2. `extractNumber(page: any, propertyName: string): number` — reads `page.properties?.[propertyName]?.number` and returns it; returns `0` for missing or null properties
3. `pageToProject()` must populate `retry` using `extractCheckbox(page, 'Retry')` and `retryCount` using `extractNumber(page, 'RetryCount')` on the returned `Project` object
4. `queryRetryProjects(): Promise<Project[]>` queries the Projects database with `filter: { property: 'Retry', checkbox: { equals: true } }` and returns mapped `Project[]`
5. `updateProjectProperties(pageId: string, properties: Record<string, any>): Promise<void>` wraps `notion.pages.update({ page_id: pageId, properties })` with no return value
6. `npx tsc --noEmit` passes with no errors
7. All new functions are exported

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/notion-retry-helpers
```

### Step 1: Inspect current lib/notion.ts and lib/types.ts

Read both files in full before making changes:

```bash
cat lib/notion.ts
cat lib/types.ts
```

Confirm:
- The `Project` type has `retry?: boolean` and `retryCount?: number` fields (added by the recent retry-fields work item). If not present, add them to `lib/types.ts` as optional fields.
- The `notion` client is initialized (likely `new Client({ auth: process.env.NOTION_API_KEY })`).
- The `notionProjectsDbId` variable is set from `process.env.NOTION_PROJECTS_DB_ID`.
- Identify the existing property extractor helpers to match their style.

### Step 2: Add extractCheckbox and extractNumber helpers to lib/notion.ts

Locate the section where other `extract*` helpers are defined (e.g., `extractText`, `extractSelect`, `extractStatus`). Add the two new helpers immediately after the existing ones, following the same private (non-exported) pattern:

```typescript
function extractCheckbox(page: any, propertyName: string): boolean {
  const prop = page.properties?.[propertyName];
  if (!prop) return false;
  return prop.checkbox === true;
}

function extractNumber(page: any, propertyName: string): number {
  const prop = page.properties?.[propertyName];
  if (!prop || prop.number === null || prop.number === undefined) return 0;
  return prop.number;
}
```

### Step 3: Update pageToProject() to populate retry fields

Find the `pageToProject` function. It constructs and returns a `Project` object. Add the `retry` and `retryCount` fields:

```typescript
// Inside pageToProject, add to the returned object:
retry: extractCheckbox(page, 'Retry'),
retryCount: extractNumber(page, 'RetryCount'),
```

The exact property names `'Retry'` and `'RetryCount'` must match the Notion database column names. These are the canonical names per the work item description.

If `pageToProject` uses a spread or explicit object literal, add these two fields to the object literal. Example of what the addition looks like in context:

```typescript
function pageToProject(page: any): Project {
  return {
    id: page.id,
    // ... other existing fields ...
    retry: extractCheckbox(page, 'Retry'),
    retryCount: extractNumber(page, 'RetryCount'),
  };
}
```

### Step 4: Add queryRetryProjects export

Locate existing query functions (e.g., `queryProjects`, or similar). Add the new function after them:

```typescript
export async function queryRetryProjects(): Promise<Project[]> {
  const response = await notion.databases.query({
    database_id: notionProjectsDbId,
    filter: {
      property: 'Retry',
      checkbox: {
        equals: true,
      },
    },
  });
  return response.results.map(pageToProject);
}
```

### Step 5: Add updateProjectProperties export

Add this function after `queryRetryProjects`:

```typescript
export async function updateProjectProperties(
  pageId: string,
  properties: Record<string, any>
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties,
  });
}
```

### Step 6: Verify types are correct

Check `lib/types.ts` — ensure the `Project` interface/type includes:

```typescript
retry?: boolean;
retryCount?: number;
```

If these fields are missing (the prior work item may not have landed, or they may be named differently), add them now. If they exist but are not optional (`boolean` vs `boolean | undefined`), adjust `pageToProject` to always return concrete values (which `extractCheckbox` and `extractNumber` already do — they never return undefined).

If the `Project` type uses strict non-optional fields and `retry`/`retryCount` are already there as required fields, `extractCheckbox` and `extractNumber` returning `false`/`0` by default satisfies the type contract.

### Step 7: Verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- `notion.pages.update` signature: ensure `page_id` (not `id`) is used
- `response.results` type: cast with `response.results.map((page: any) => pageToProject(page))` if TypeScript complains about the Notion SDK's result union type
- If `notionProjectsDbId` could be undefined, the existing code already handles this pattern — follow suit

```bash
npm run build 2>&1 | head -50
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add Notion helpers for checkbox/number extraction and retry queries"
git push origin feat/notion-retry-helpers
gh pr create \
  --title "feat: add Notion helpers for checkbox/number extraction and retry queries" \
  --body "## Summary

Extends \`lib/notion.ts\` with helpers to read checkbox and number Notion properties, wires retry fields into \`pageToProject()\`, and adds functions for querying and updating retry-related Notion properties.

## Changes

- \`extractCheckbox(page, propertyName)\` — safely reads Notion checkbox property, returns \`false\` for missing
- \`extractNumber(page, propertyName)\` — safely reads Notion number property, returns \`0\` for missing/null
- \`pageToProject()\` now populates \`retry\` and \`retryCount\` fields from Notion page properties
- \`queryRetryProjects()\` — queries Projects DB for pages where Retry checkbox is checked
- \`updateProjectProperties(pageId, properties)\` — generic Notion page property updater

## Testing

- \`npx tsc --noEmit\` passes
- Follows existing patterns for property extraction and database queries in \`lib/notion.ts\`

## Risk

Low — additive changes only, no existing behavior modified except \`pageToProject\` gaining two new fields."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/notion-retry-helpers
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If blocked on ambiguous Notion property names, TypeScript errors that cannot be resolved, or the `Project` type not having `retry`/`retryCount` fields at all:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "notion-retry-helpers",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/notion.ts", "lib/types.ts"]
    }
  }'
```