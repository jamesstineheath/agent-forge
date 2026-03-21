<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- PRD-54 AC-4: Auto-close bugs in Notion when work item PR merges

## Metadata
- **Branch:** `feat/prd-54-ac-4-auto-close-bugs-on-pr-merge`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/event-reactor.ts, lib/bugs.ts

## Context

Agent Forge tracks bugs in a Notion Bugs database (`023f3621-2885-468d-a8cf-2e0bd1458bb3`). AC-3 (concurrent branch `feat/prd-54-ac-3-dispatcher-picks-up-triaged-bugs-from-`) wired up the Dispatcher to pick up Triaged bugs and set `source.type === "bug"` on work items created from them.

AC-4 closes the loop: when a work item's PR merges, if that work item originated from a bug, the corresponding Notion bug page should be marked "Fixed" and linked to the merge PR.

The event reactor (`lib/event-reactor.ts`) already handles `handlePRMerged()` and calls `updateWorkItem(item.id, { status: "merged", ... })`. We need to add a post-merge hook after that call.

**Key constraint:** `lib/notion.ts` and `lib/bugs.ts` are being modified by the concurrent AC-3 branch. To avoid conflicts:
- Add the `findBugByWorkItemId` helper to `lib/bugs.ts` **only if that file already exists and is not being actively modified in a conflicting way**, otherwise add a minimal helper directly in `lib/event-reactor.ts` or to a new file `lib/bug-closer.ts`.
- **Do not modify `lib/notion.ts`** — use the existing Notion API wrapper already present there, or call the Notion REST API directly via `fetch` if needed.

The Notion Bugs database ID is: `023f3621-2885-468d-a8cf-2e0bd1458bb3`

## Requirements

1. After `updateWorkItem(item.id, { status: "merged", ... })` in `handlePRMerged()`, add logic to auto-close the associated Notion bug.
2. Only attempt bug closure if `item.source?.type === "bug"`.
3. Query the Notion Bugs database for a page where the "Work Item ID" property equals `item.id`.
4. If a matching bug page is found, update it: set Status to `"Fixed"` and set the Fix PR URL property to `https://github.com/${event.repo}/pull/${event.payload.prNumber}`.
5. Wrap the entire bug-close block in `try/catch`. Failures must not throw, must not block the rest of `handlePRMerged()`, and must log errors with the `[event-reactor]` prefix.
6. The Notion query and update logic should live in a helper function `findAndCloseBug(workItemId: string, prUrl: string): Promise<void>` — placed in `lib/bugs.ts` if that file exists and is safe to extend, otherwise in a new `lib/bug-closer.ts`.
7. No modifications to `lib/notion.ts` or `lib/atc/dispatcher.ts` (concurrent AC-3 files).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prd-54-ac-4-auto-close-bugs-on-pr-merge
```

### Step 1: Inspect existing files to understand current patterns

```bash
# Check if lib/bugs.ts exists and what it exports
cat lib/bugs.ts 2>/dev/null || echo "FILE NOT FOUND"

# Check the Notion client/wrapper to understand how to make API calls
cat lib/notion.ts | head -80

# Understand the current handlePRMerged structure
cat lib/event-reactor.ts
```

Look for:
- How `lib/notion.ts` wraps the Notion client (does it export a `notion` client instance, or raw fetch helpers?)
- What `item.source` looks like (type definition in `lib/types.ts`)
- The exact signature of `updateWorkItem` and the shape of `event` in `handlePRMerged`

```bash
# Check types to understand WorkItem.source shape
grep -n "source" lib/types.ts | head -20

# Check how Notion is imported/used elsewhere
grep -rn "notion" lib/ --include="*.ts" | grep -v "node_modules" | head -20
```

### Step 2: Add `findAndCloseBug` helper

**Decision tree:**
- If `lib/bugs.ts` exists → add `findAndCloseBug` there
- If `lib/bugs.ts` does not exist → create `lib/bug-closer.ts` with just this helper

The helper must:
1. Query the Bugs Notion database for a page matching the given `workItemId`
2. If found, update it with Status = "Fixed" and Fix PR URL

Use the Notion API directly via the Notion SDK client (check how `lib/notion.ts` exports it — likely `export const notion = new Client(...)`) or via raw fetch if the client isn't exported.

**Template for `findAndCloseBug` (adapt based on what you find in Step 1):**

```typescript
// If adding to lib/bugs.ts (or lib/bug-closer.ts if bugs.ts doesn't exist):

const BUGS_DB_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

/**
 * Finds a bug in the Notion Bugs database by work item ID and marks it Fixed.
 * No-ops silently if no matching bug is found.
 */
export async function findAndCloseBug(
  workItemId: string,
  prUrl: string
): Promise<void> {
  // Import the notion client — adjust import path based on what lib/notion.ts exports
  const { notion } = await import("./notion");

  // Query for the bug page matching this work item ID
  const response = await notion.databases.query({
    database_id: BUGS_DB_ID,
    filter: {
      property: "Work Item ID",
      rich_text: {
        equals: workItemId,
      },
    },
    page_size: 1,
  });

  if (response.results.length === 0) {
    // No matching bug — nothing to do
    return;
  }

  const bugPageId = response.results[0].id;

  // Update the bug page: mark Fixed and link the PR
  await notion.pages.update({
    page_id: bugPageId,
    properties: {
      Status: {
        select: {
          name: "Fixed",
        },
      },
      "Fix PR URL": {
        url: prUrl,
      },
    },
  });
}
```

> **Important:** The exact property names ("Work Item ID", "Status", "Fix PR URL") and their types (rich_text, select, url) must match the actual Notion database schema. If you can inspect the database schema via the Notion API or from existing code in `lib/bugs.ts` / `lib/notion.ts`, verify these names. If you cannot verify, use the names as specified above — they come from the PRD specification.

> **If `notion` is not directly exported from `lib/notion.ts`:** Check if there's a `queryDatabase`, `updatePage`, or similar wrapper function already exported. Use those wrappers instead of the raw client. If only raw fetch is available, use the Notion REST API:
>
> ```typescript
> const NOTION_TOKEN = process.env.NOTION_API_KEY;
>
> async function notionFetch(path: string, method: string, body?: unknown) {
>   const res = await fetch(`https://api.notion.com/v1/${path}`, {
>     method,
>     headers: {
>       Authorization: `Bearer ${NOTION_TOKEN}`,
>       "Content-Type": "application/json",
>       "Notion-Version": "2022-06-28",
>     },
>     body: body ? JSON.stringify(body) : undefined,
>   });
>   if (!res.ok) throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
>   return res.json();
> }
> ```

### Step 3: Wire into `handlePRMerged` in `lib/event-reactor.ts`

Locate the `handlePRMerged` function. After the `updateWorkItem(item.id, { status: "merged", ... })` call, add:

```typescript
// Auto-close associated Notion bug if this work item originated from a bug report
if (item.source?.type === "bug") {
  try {
    const prUrl = `https://github.com/${event.repo}/pull/${event.payload.prNumber}`;
    // Import from lib/bugs.ts or lib/bug-closer.ts depending on where you placed it
    const { findAndCloseBug } = await import("./bugs"); // or "./bug-closer"
    await findAndCloseBug(item.id, prUrl);
    console.log(`[event-reactor] Closed Notion bug for work item ${item.id}`);
  } catch (err) {
    console.error(`[event-reactor] Failed to close Notion bug for work item ${item.id}:`, err);
  }
}
```

> **Note on dynamic import vs static import:** If `lib/event-reactor.ts` already imports from `lib/bugs.ts`, use a static import at the top of the file instead. Dynamic `import()` is used here only as a safe default if you're unsure about circular dependencies. Prefer static imports matching the existing file's pattern.

**Verify the exact variable names in `handlePRMerged`:**
- `event.repo` — the repo identifier (e.g. `"jamesstineheath/agent-forge"`)
- `event.payload.prNumber` — the PR number
- `item.source?.type` — from the WorkItem type
- `item.id` — the work item ID

Adjust the property accesses to match what's actually in scope if they differ from the above.

### Step 4: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `item.source` might need a type guard if `source` is typed as optional or a union
- The Notion SDK types may require specific property value shapes

### Step 5: Verify no accidental modifications to concurrent files

```bash
git diff --name-only
```

Confirm the output does **not** include:
- `lib/notion.ts`
- `lib/atc/dispatcher.ts`

If either file appears in the diff, revert those changes:
```bash
git checkout lib/notion.ts
git checkout lib/atc/dispatcher.ts
```

### Step 6: Build check

```bash
npm run build
```

### Step 7: Run tests (if present)

```bash
npm test 2>/dev/null || echo "No test runner configured"
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: auto-close Notion bugs when work item PR merges (PRD-54 AC-4)"
git push origin feat/prd-54-ac-4-auto-close-bugs-on-pr-merge
gh pr create \
  --title "feat: PRD-54 AC-4 — auto-close Notion bugs on PR merge" \
  --body "## Summary

Closes the bug lifecycle loop: when a work item's PR merges, if the work item originated from a Notion bug report (\`source.type === 'bug'\`), the corresponding Notion bug page is automatically marked 'Fixed' and linked to the merge PR.

## Changes
- \`lib/event-reactor.ts\`: Added bug-close hook in \`handlePRMerged()\` after work item status update
- \`lib/bugs.ts\` or \`lib/bug-closer.ts\`: Added \`findAndCloseBug(workItemId, prUrl)\` helper

## Behavior
- Only triggers if \`item.source?.type === 'bug'\`
- Queries Notion Bugs DB (\`023f3621-2885-468d-a8cf-2e0bd1458bb3\`) for page where Work Item ID = item.id
- Sets Status = 'Fixed', Fix PR URL = merged PR URL
- Wrapped in try/catch — failures are logged but never block the merge flow

## Files not touched (concurrent AC-3)
- \`lib/notion.ts\` — not modified
- \`lib/atc/dispatcher.ts\` — not modified

## Part of PRD-54
- AC-3: Dispatcher picks up Triaged bugs (concurrent, separate branch)
- AC-4: This PR"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prd-54-ac-4-auto-close-bugs-on-pr-merge
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked on any of the following, call the escalation API:
- Cannot determine the Notion property names/types for the Bugs database schema
- `lib/notion.ts` does not export a usable Notion client or fetch helper
- Merge conflict with AC-3 branch that cannot be resolved without coordinating with that branch's changes

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-54-ac-4",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/event-reactor.ts", "lib/bugs.ts"]
    }
  }'
```