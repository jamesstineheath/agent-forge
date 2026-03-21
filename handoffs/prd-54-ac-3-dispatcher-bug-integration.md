<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- PRD-54 AC-3: Dispatcher Bug Integration

## Metadata
- **Branch:** `feat/dispatcher-bug-integration-prd54-ac3`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/inngest/dispatcher.ts, lib/atc/dispatcher.ts, lib/notion.ts, lib/types.ts

## Context

Agent Forge's Dispatcher agent (Inngest function `dispatcher-cycle`) currently reads work items from the Neon Postgres `work_items` table and dispatches them to target repos based on priority and concurrency limits. This task extends the Dispatcher to also poll a Notion Bugs database for bugs with status "Triaged", create work items from them, and dispatch them with severity-aware priority ordering.

The Notion client lives in `lib/notion.ts` and already has an API key (`NOTION_API_KEY`) and project DB ID (`NOTION_PROJECTS_DB_ID`) configured. The Bugs database ID is `023f3621-2885-468d-a8cf-2e0bd1458bb3`.

The Inngest dispatcher function is defined in `lib/inngest/dispatcher.ts` and calls into `lib/atc/dispatcher.ts` for core dispatch logic. Work item CRUD is in `lib/work-items.ts` (Neon Postgres via Drizzle). The `WorkItem` type is in `lib/types.ts`.

The priority ordering requirement:
- **Critical** bugs → ahead of all non-executing PRD work items (highest priority)
- **High** bugs → interleave with PRD work (next available slot, same priority tier as PRD high)
- **Medium/Low** bugs → queue behind PRD work items
- Within same severity, oldest-first (by Notion `created_time`)

## Requirements

1. Add a `queryTriagedBugs()` function to `lib/notion.ts` that queries the Bugs database (`023f3621-2885-468d-a8cf-2e0bd1458bb3`) for pages with status "Triaged", returning structured bug records including: page ID, title, severity, context, affected files, and created time.
2. Add an `updateBugWorkItemId(pageId: string, workItemId: string)` function to `lib/notion.ts` that writes the work item ID to the bug's "Work Item ID" property.
3. Add an `updateBugStatus(pageId: string, status: string)` function to `lib/notion.ts` that updates the bug's "Status" property (e.g., to "In Progress").
4. In the Dispatcher's dispatch step (either `lib/inngest/dispatcher.ts` or `lib/atc/dispatcher.ts`), after fetching ready work items from Postgres, also call `queryTriagedBugs()`.
5. For each Triaged bug, create a work item via `lib/work-items.ts` with: `type: 'bug'`, `title` from bug title, `description` from bug's Context field, `affectedFiles` from bug's Affected Files field, `priority` mapped from severity (Critical→`critical`, High→`high`, Medium→`medium`, Low→`low`), `status: 'ready'`, and `metadata` containing `notionBugId: pageId`.
6. After creating the work item, call `updateBugWorkItemId()` and `updateBugStatus(pageId, 'In Progress')` on the Notion bug page.
7. Merge the bug-derived work items into the dispatch queue with severity-aware priority ordering: Critical bugs first (before all non-executing PRD items), High bugs interleaved at the same priority level as High PRD items, Medium/Low bugs appended after all PRD items. Within the same priority tier, sort oldest-first by `createdAt`.
8. Guard against duplicate work item creation: before creating a work item for a bug, check if a work item already exists with `metadata.notionBugId === pageId` (or if the bug's Work Item ID field is already populated). Skip if duplicate found.
9. Add error handling so that a failure to query or update Notion does not crash the dispatcher cycle — log the error and continue with existing work items.
10. The change must compile with `npx tsc --noEmit` and not break existing dispatcher behavior for non-bug work items.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dispatcher-bug-integration-prd54-ac3
```

### Step 1: Read existing code to understand current structure

Before writing any code, read these files in full:

```bash
cat lib/notion.ts
cat lib/types.ts
cat lib/work-items.ts
cat lib/inngest/dispatcher.ts
cat lib/atc/dispatcher.ts
```

Pay attention to:
- How `lib/notion.ts` currently makes API calls (fetch vs SDK, auth headers)
- The `WorkItem` type shape in `lib/types.ts` — especially `priority` enum values, `status` enum values, and `metadata` field type
- How `createWorkItem` is called in `lib/work-items.ts`
- Which file contains the actual dispatch queue assembly (`lib/inngest/dispatcher.ts` or `lib/atc/dispatcher.ts`)
- The existing Notion DB query pattern for `NOTION_PROJECTS_DB_ID`

### Step 2: Add Notion bug query and update functions to `lib/notion.ts`

Add the following functions. Model them after the existing Notion API call patterns in the file.

```typescript
// Type for a Triaged bug from Notion
export interface NotionBug {
  pageId: string;
  title: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low';
  context: string;
  affectedFiles: string[];
  createdTime: string; // ISO 8601
  workItemId: string | null; // existing Work Item ID if any
}

/**
 * Query the Bugs database for pages with status "Triaged".
 * Database ID: 023f3621-2885-468d-a8cf-2e0bd1458bb3
 */
export async function queryTriagedBugs(): Promise<NotionBug[]> {
  const BUGS_DB_ID = '023f3621-2885-468d-a8cf-2e0bd1458bb3';
  const response = await fetch(
    `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          property: 'Status',
          status: { equals: 'Triaged' },
        },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Notion bugs query failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();

  return (data.results ?? []).map((page: any) => {
    const props = page.properties;

    // Title — adjust property name if different in the actual DB schema
    const titleArr = props['Name']?.title ?? props['Title']?.title ?? [];
    const title = titleArr.map((t: any) => t.plain_text).join('');

    // Severity — select property
    const severity = (props['Severity']?.select?.name ?? 'Low') as NotionBug['severity'];

    // Context — rich text property
    const contextArr = props['Context']?.rich_text ?? [];
    const context = contextArr.map((t: any) => t.plain_text).join('');

    // Affected Files — rich text or multi-select; handle both
    const affectedFilesRaw = props['Affected Files'];
    let affectedFiles: string[] = [];
    if (affectedFilesRaw?.rich_text) {
      const raw = affectedFilesRaw.rich_text.map((t: any) => t.plain_text).join('');
      affectedFiles = raw.split(/[\n,]+/).map((s: string) => s.trim()).filter(Boolean);
    } else if (affectedFilesRaw?.multi_select) {
      affectedFiles = affectedFilesRaw.multi_select.map((s: any) => s.name);
    }

    // Work Item ID — rich text property (may be empty)
    const workItemIdArr = props['Work Item ID']?.rich_text ?? [];
    const workItemId = workItemIdArr.map((t: any) => t.plain_text).join('') || null;

    return {
      pageId: page.id,
      title,
      severity,
      context,
      affectedFiles,
      createdTime: page.created_time,
      workItemId,
    };
  });
}

/**
 * Write a work item ID to the bug page's "Work Item ID" property.
 */
export async function updateBugWorkItemId(pageId: string, workItemId: string): Promise<void> {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        'Work Item ID': {
          rich_text: [{ type: 'text', text: { content: workItemId } }],
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update bug work item ID: ${response.status} ${await response.text()}`);
  }
}

/**
 * Update the Status property of a bug page.
 */
export async function updateBugStatus(pageId: string, status: string): Promise<void> {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        'Status': {
          status: { name: status },
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update bug status: ${response.status} ${await response.text()}`);
  }
}
```

**Important:** After reading `lib/notion.ts`, adapt the property names and API call pattern to match what's already in the file. If the existing code uses the `@notionhq/client` SDK instead of raw fetch, rewrite the above functions using that SDK's pattern instead.

### Step 3: Add `WorkItemPriority` mapping helper and bug work item creation logic

Read `lib/types.ts` to confirm the exact `priority` enum values and `WorkItem` shape. Then read `lib/work-items.ts` to understand `createWorkItem`'s signature.

In the dispatcher logic file (likely `lib/atc/dispatcher.ts` or `lib/inngest/dispatcher.ts`), add a helper that:

1. Takes a `NotionBug[]` and the existing list of work items already in Postgres
2. Skips bugs where `bug.workItemId !== null` (already linked) — this is the duplicate guard
3. For each remaining bug, calls `createWorkItem(...)` with appropriate fields
4. Calls `updateBugWorkItemId` and `updateBugStatus` on success
5. Returns the newly created `WorkItem[]`

```typescript
import { queryTriagedBugs, updateBugWorkItemId, updateBugStatus } from '../notion';
import { createWorkItem, getWorkItems } from '../work-items';

// Map Notion severity to WorkItem priority
function severityToPriority(severity: string): string {
  switch (severity) {
    case 'Critical': return 'critical';
    case 'High': return 'high';
    case 'Medium': return 'medium';
    case 'Low': return 'low';
    default: return 'low';
  }
}

async function ingestTriagedBugs(existingWorkItems: WorkItem[]): Promise<WorkItem[]> {
  let bugs;
  try {
    bugs = await queryTriagedBugs();
  } catch (err) {
    console.error('[dispatcher] Failed to query Notion bugs:', err);
    return [];
  }

  const newWorkItems: WorkItem[] = [];

  for (const bug of bugs) {
    // Duplicate guard 1: bug already has a work item ID in Notion
    if (bug.workItemId) {
      continue;
    }

    // Duplicate guard 2: existing work item with this notionBugId in metadata
    const alreadyExists = existingWorkItems.some(
      (wi) => (wi.metadata as any)?.notionBugId === bug.pageId
    );
    if (alreadyExists) {
      continue;
    }

    try {
      const workItem = await createWorkItem({
        type: 'bug',
        title: bug.title || `Bug: ${bug.pageId}`,
        description: bug.context,
        priority: severityToPriority(bug.severity) as any,
        status: 'ready',
        // affectedFiles may or may not be a top-level field — check WorkItem type
        metadata: {
          notionBugId: bug.pageId,
          affectedFiles: bug.affectedFiles,
          severity: bug.severity,
          source: 'notion-bugs',
        },
      });

      await updateBugWorkItemId(bug.pageId, workItem.id);
      await updateBugStatus(bug.pageId, 'In Progress');

      newWorkItems.push(workItem);
      console.log(`[dispatcher] Created work item ${workItem.id} for bug ${bug.pageId} (${bug.severity})`);
    } catch (err) {
      console.error(`[dispatcher] Failed to create work item for bug ${bug.pageId}:`, err);
      // Continue processing remaining bugs
    }
  }

  return newWorkItems;
}
```

**Adjust** field names (`type`, `affectedFiles`, `metadata`) to match the actual `createWorkItem` signature you find in `lib/work-items.ts`.

### Step 4: Integrate bug work items into the dispatch queue with priority ordering

In the same dispatcher file, find where the dispatch queue is assembled (the array of work items sorted by priority before dispatch). Modify that section to:

1. Call `ingestTriagedBugs(existingWorkItems)` to get bug-derived work items
2. Merge them with the existing `ready` work items using severity-aware ordering

The priority merge logic:

```typescript
function mergeWithBugPriority(prdItems: WorkItem[], bugItems: WorkItem[]): WorkItem[] {
  // Separate bugs by severity
  const criticalBugs = bugItems.filter(wi => (wi.metadata as any)?.severity === 'Critical');
  const highBugs = bugItems.filter(wi => (wi.metadata as any)?.severity === 'High');
  const mediumLowBugs = bugItems.filter(wi =>
    (wi.metadata as any)?.severity === 'Medium' || (wi.metadata as any)?.severity === 'Low'
  );

  // Separate executing PRD items (don't reorder those)
  // PRD items that are not yet executing
  const nonExecutingPrd = prdItems.filter(wi => wi.status !== 'executing');
  const executingPrd = prdItems.filter(wi => wi.status === 'executing');

  // Sort each group oldest-first within same tier
  const byAge = (a: WorkItem, b: WorkItem) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();

  criticalBugs.sort(byAge);
  highBugs.sort(byAge);
  mediumLowBugs.sort(byAge);

  // High PRD items (for interleaving)
  const highPrd = nonExecutingPrd.filter(wi => wi.priority === 'high' || wi.priority === 'critical');
  const normalPrd = nonExecutingPrd.filter(wi => wi.priority !== 'high' && wi.priority !== 'critical');

  // Final order:
  // 1. Critical bugs (before all non-executing PRD)
  // 2. High PRD + High bugs interleaved (sort together by createdAt)
  // 3. Normal PRD items
  // 4. Medium/Low bugs
  const highTier = [...highPrd, ...highBugs].sort(byAge);

  return [
    ...executingPrd,      // executing items stay at top (already in flight)
    ...criticalBugs,      // critical bugs jump ahead
    ...highTier,          // high PRD + high bugs interleaved by age
    ...normalPrd,         // remaining PRD
    ...mediumLowBugs,     // medium/low bugs at end
  ];
}
```

Call this in the dispatch step:

```typescript
// Before: const queue = readyWorkItems.sort(...);
// After:
const bugWorkItems = await ingestTriagedBugs(allWorkItems);
const queue = mergeWithBugPriority(readyWorkItems, bugWorkItems);
```

**Adapt** this to the actual control flow you find in the dispatcher. The key invariant: existing dispatch logic for non-bug items must be preserved.

### Step 5: Verify the Inngest step structure is preserved

Read `lib/inngest/dispatcher.ts` to confirm the Inngest step function structure. Ensure:
- `ingestTriagedBugs` is called inside a `step.run(...)` block (not at top level of the function), so Inngest can handle retries and timeouts properly
- The Notion calls are wrapped in the error-catching pattern from Step 3 so a Notion outage doesn't abort the dispatch step

If the dispatcher uses `step.run('dispatch', async () => { ... })`, the bug ingestion should happen inside that same step or in a preceding named step, e.g.:

```typescript
const bugItems = await step.run('ingest-notion-bugs', async () => {
  return ingestTriagedBugs(existingWorkItems);
});
```

### Step 6: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `priority` field type mismatch (check the enum in `lib/types.ts`)
- `metadata` typed as `Record<string, unknown>` or `JsonValue` — cast appropriately
- `createWorkItem` input type not matching what you pass
- `NotionBug` import path

### Step 7: Run build

```bash
npm run build
```

Ensure no build errors. If there are Notion-related type issues with `any`, add explicit types or casts to satisfy the compiler without changing behavior.

### Step 8: Verification
```bash
npx tsc --noEmit
npm run build
```

There are no unit tests to run for this change (the dispatcher is integration-tested via actual Inngest runs). Verify manually that:
- `queryTriagedBugs` would hit the correct database ID
- The duplicate guard checks both `bug.workItemId !== null` and `metadata.notionBugId` in existing items
- The priority merge preserves executing items untouched
- All Notion errors are caught and logged without re-throwing

### Step 9: Commit, push, open PR
```bash
git add -A
git commit -m "feat: extend dispatcher to ingest Triaged bugs from Notion (PRD-54 AC-3)"
git push origin feat/dispatcher-bug-integration-prd54-ac3
gh pr create \
  --title "feat: dispatcher bug integration — PRD-54 AC-3" \
  --body "## Summary

Extends the Dispatcher Inngest function (\`dispatcher-cycle\`) to poll the Notion Bugs database for bugs with status 'Triaged', create work items from them, and dispatch them with severity-aware priority ordering.

## Changes
- \`lib/notion.ts\`: Added \`queryTriagedBugs()\`, \`updateBugWorkItemId()\`, \`updateBugStatus()\`
- \`lib/inngest/dispatcher.ts\` and/or \`lib/atc/dispatcher.ts\`: Added bug ingestion step, priority merge logic

## Priority Ordering
- Critical bugs → ahead of all non-executing PRD work items
- High bugs → interleaved with High PRD items (oldest-first)
- Medium/Low bugs → queued behind PRD items
- Within same tier: oldest-first

## Duplicate Guards
1. Skip bugs where Notion's 'Work Item ID' field is already populated
2. Skip bugs where a work item with \`metadata.notionBugId\` already exists in Postgres

## Error Handling
Notion failures are caught and logged; dispatcher continues with existing work items.

## Acceptance Criteria (PRD-54 AC-3)
- [x] Dispatcher polls Notion Bugs DB for Triaged bugs
- [x] Work item created with bug's Context + Affected Files
- [x] Bug's Work Item ID field populated after creation
- [x] Bug status updated to 'In Progress'
- [x] Critical bugs dispatched ahead of non-executing PRD items
- [x] High bugs interleaved with PRD High items
- [x] Medium/Low bugs queued behind PRD items
- [x] Oldest-first within same severity tier
- [x] Duplicate prevention
- [x] Notion errors don't crash dispatcher"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dispatcher-bug-integration-prd54-ac3
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If you hit a blocker that cannot be resolved autonomously (e.g., the Notion Bugs database schema has property names that cannot be determined from the codebase, the `createWorkItem` signature doesn't support `type: 'bug'`, or the Inngest step structure requires architectural decisions):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd54-ac3-dispatcher-bug-integration",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/notion.ts", "lib/inngest/dispatcher.ts", "lib/atc/dispatcher.ts"]
    }
  }'
```