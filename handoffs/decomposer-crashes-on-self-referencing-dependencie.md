<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Decomposer crashes on self-referencing dependencies instead of auto-correcting

## Metadata
- **Branch:** `fix/decomposer-self-reference-autocorrect`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/decomposer.ts

## Context

The decomposer (`lib/decomposer.ts`) validates dependencies when building a work item DAG. When it encounters a work item that lists its own ID as a dependency (self-reference), it currently throws an error. This causes the entire decomposition to fail, resulting in 0 work items being created, the project transitioning to "Failed", and an escalation being filed.

This has happened twice:
- PRJ-9, Item 17: self-reference → project Failed → escalation `esc_1773798905776` filed
- PRJ-20, Item 7: self-reference → project Failed

The fix is simple: instead of throwing, detect the self-reference, log a warning, remove it from the dependency list, and continue. No items should be lost and no projects should fail due to this recoverable data quality issue.

Additionally, after fixing the code, we need to:
1. Resolve escalation `esc_1773798905776` (PRJ-9)
2. Reset PRJ-9's Notion project status from "Failed" back to "Execute" so the ATC will re-decompose it on the next cycle

## Requirements

1. In `lib/decomposer.ts`, find the code that detects self-referencing dependencies and throws an error.
2. Replace the `throw` with a `console.warn` logging `[decomposer] WARN: item N self-references itself in dependencies, removing` (where N is the item number/ID).
3. Filter out the self-reference from the dependency list and continue decomposition normally.
4. The fix must not break the topological sort or any other dependency validation — only self-references are auto-corrected; cycles between different items should still throw (or handle per existing logic).
5. Resolve escalation `esc_1773798905776` via the escalation API/storage to mark it resolved.
6. Reset PRJ-9's Notion project status from "Failed" to "Execute" via `lib/notion.ts` or the Notion API so ATC picks it up for re-decomposition.
7. TypeScript must compile without errors (`npx tsc --noEmit`).
8. The fix should be minimal and surgical — change only what is needed.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/decomposer-self-reference-autocorrect
```

### Step 1: Locate and fix the self-reference check in `lib/decomposer.ts`

Open `lib/decomposer.ts` and search for the self-reference detection logic. It will look something like:

```typescript
if (dep === item.id || dep === item.title || /* some self-check */) {
  throw new Error(`Item ${item.id}: self-reference in dependencies`);
}
```

Or it may be in a loop over dependencies:

```typescript
for (const dep of item.dependencies) {
  if (dep === item.id) {
    throw new Error(`Item ${item.id}: self-reference in dependencies`);
  }
}
```

**Replace** the throw with a warn+filter pattern. The exact implementation depends on how the loop is structured, but the result should be:

```typescript
// Before building the DAG / processing dependencies for each item:
if (item.dependencies && item.dependencies.includes(item.id)) {
  console.warn(`[decomposer] WARN: item ${item.id} self-references itself in dependencies, removing`);
  item.dependencies = item.dependencies.filter((dep: string) => dep !== item.id);
}
```

If the check is inside a loop that processes each dependency individually, restructure to filter the array before the loop:

```typescript
// Filter self-references before validation
const selfRefs = rawDependencies.filter(dep => dep === itemId);
if (selfRefs.length > 0) {
  console.warn(`[decomposer] WARN: item ${itemId} self-references itself in dependencies, removing`);
}
const dependencies = rawDependencies.filter(dep => dep !== itemId);
```

Adapt to the actual code structure you find. The key invariant: **self-references are silently removed with a warning; all other dependency validation logic is preserved unchanged**.

### Step 2: Resolve escalation `esc_1773798905776`

Escalations are stored in Vercel Blob at `escalations/*`. In development/local context, look at `lib/escalation.ts` to understand the data model and resolution mechanism.

Check for an existing API route or `lib/escalation.ts` function that can resolve an escalation. If a `resolveEscalation(id, resolution)` function exists, use it in a one-time script or directly inspect the storage approach.

Look at `lib/escalation.ts` for a function like:
```typescript
export async function resolveEscalation(id: string, resolution: string): Promise<void>
```

If such a function exists, create a small admin script at `scripts/resolve-esc-1773798905776.ts`:

```typescript
import { resolveEscalation } from '../lib/escalation';

async function main() {
  await resolveEscalation('esc_1773798905776', 'Auto-resolved: decomposer self-reference bug fixed. PRJ-9 reset to Execute for re-decomposition.');
  console.log('Escalation resolved.');
}

main().catch(console.error);
```

Alternatively, if there is an admin API route (e.g., `app/api/admin/escalations/[id]/resolve/route.ts` or similar), document it in the PR but do not add a new route if one already exists.

**If no programmatic resolution path exists in the codebase**, add a `PATCH /api/escalations/[id]` route that sets `status: 'resolved'` and `resolvedAt`. Check `app/api/escalations/` for existing patterns first.

### Step 3: Reset PRJ-9 Notion status to "Execute"

Look at `lib/notion.ts` for a function that updates a project's status. It likely looks like:

```typescript
export async function updateProjectStatus(projectId: string, status: string): Promise<void>
```

Check how other parts of the codebase (e.g., `lib/projects.ts`, `lib/atc.ts`) call Notion status updates to find the PRJ-9 project ID and the correct status string for "Execute".

The PRJ-9 Notion page ID can be found by:
1. Searching `lib/` for how projects are stored/referenced
2. Checking `data/` directory for local project files that might contain the Notion page ID
3. Looking at ATC or decomposer logs (the existing recovery route at `app/api/admin/recover-prj9/route.ts` may already have the project ID hardcoded)

Create a one-time admin API route at `app/api/admin/reset-prj9-execute/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
// import notion update function from lib/notion.ts or lib/projects.ts

export async function POST() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // Find PRJ-9 project ID from storage or hardcode from recover-prj9 route
    // Call the Notion status update function with status = "Execute"
    // Also resolve the escalation here if the script approach isn't viable
    
    return NextResponse.json({ success: true, message: 'PRJ-9 reset to Execute' });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
```

**Important:** Look at the existing `app/api/admin/recover-prj9/route.ts` before creating anything new — it may already do part of this work or contain the Notion page ID you need. Build on it rather than duplicating.

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 5: Manual verification of the fix logic

Review the patched section of `lib/decomposer.ts` to confirm:
- [ ] Self-reference removal happens before topological sort
- [ ] The warning log format is exactly: `[decomposer] WARN: item N self-references itself in dependencies, removing`
- [ ] No other dependency checks were accidentally modified
- [ ] The rest of the decomposition flow (cycle detection between different items, DAG construction) is untouched

### Step 6: Build check

```bash
npm run build
```

Resolve any build errors. Since this is a Next.js project on Vercel, the build must pass cleanly.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "fix: auto-correct self-referencing dependencies in decomposer instead of throwing

- Replace throw with warn+filter for self-reference detection in lib/decomposer.ts
- Logs [decomposer] WARN: item N self-references itself in dependencies, removing
- Decomposition continues with self-reference removed from dep list
- Add admin route to resolve esc_1773798905776 and reset PRJ-9 to Execute
- Fixes PRJ-9 (Item 17) and PRJ-20 (Item 7) crash patterns"

git push origin fix/decomposer-self-reference-autocorrect

gh pr create \
  --title "fix: decomposer auto-corrects self-referencing dependencies instead of crashing" \
  --body "## Problem
The decomposer throws when a work item lists itself as a dependency, causing 0 items to be created and the project to transition to Failed. This happened for PRJ-9 (Item 17) and PRJ-20 (Item 7).

## Fix
- **\`lib/decomposer.ts\`**: Replace \`throw\` for self-reference detection with \`console.warn\` + filter. Self-references are silently removed and decomposition continues.
- **Admin route**: Reset PRJ-9 Notion status to Execute and resolve escalation \`esc_1773798905776\`.

## Behavior change
- **Before:** Item N self-reference → throw → 0 items → project Failed → escalation filed
- **After:** Item N self-reference → warn → filter dep → continue → items created normally

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Logic reviewed: only self-references removed; cross-item cycle detection untouched

## Follow-up
After merge, trigger the admin route \`POST /api/admin/reset-prj9-execute\` to reset PRJ-9 and resolve the escalation, then verify ATC picks up PRJ-9 for re-decomposition on the next cycle."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/decomposer-self-reference-autocorrect
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker (e.g., cannot find the self-reference check, PRJ-9 Notion ID is inaccessible, escalation storage schema is unclear):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<this-work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/decomposer.ts"]
    }
  }'
```