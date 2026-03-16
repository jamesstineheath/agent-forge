# Agent Forge -- C4: Add project-level terminal state detection

## Metadata
- **Branch:** `feat/project-terminal-state-detection`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/projects.ts, lib/atc.ts

## Context

Agent Forge is a dev orchestration platform where projects in Notion are decomposed into work items that get executed autonomously. Currently, when all work items for a project reach terminal states (merged, parked, cancelled, failed), the system does not automatically transition the parent Notion project to Complete or Failed — this must be done manually.

This task implements §13b of the system map: automatic project completion detection at the end of each ATC (Air Traffic Controller) cycle.

The ATC runs as a Vercel cron job (`lib/atc.ts`, `runATCCycle()`). Projects live in Notion and have a Status property. Work items are stored in Vercel Blob (`lib/work-items.ts`). The Notion client is already implemented in `lib/notion.ts`. ATC event logging is done via `logATCEvent()`.

Relevant existing patterns:
- `lib/projects.ts` already exists with project lifecycle logic (transition to Complete/Failed is already partially referenced in SYSTEM_MAP.md under §13)
- `lib/notion.ts` has `fetchPageContent()` and Notion API client setup
- `lib/work-items.ts` has `listWorkItems()` or similar for loading work items
- `lib/atc.ts` has numbered sections (§1, §2, etc.) and calls `logATCEvent()` for events

## Requirements

1. `lib/projects.ts` must define `const TERMINAL_STATES = ['merged', 'parked', 'cancelled', 'failed'] as const`
2. `lib/projects.ts` must export `checkProjectCompletion(projectId: string, workItems: WorkItem[]): Promise<{isTerminal: boolean, status: 'Complete' | 'Failed' | null, summary: string}>` with the logic described below
3. `checkProjectCompletion` returns `{isTerminal: false, status: null, summary: ''}` when any work items for the project are in non-terminal states
4. `checkProjectCompletion` returns `{isTerminal: true, status: 'Complete', summary: 'All N items merged'}` when all work items are 'merged'
5. `checkProjectCompletion` returns `{isTerminal: true, status: 'Failed', summary: '...'}` with a summary listing failed/parked item titles when any work item is not merged
6. `lib/projects.ts` must export `transitionProject(projectId: string, status: 'Complete' | 'Failed', summary: string): Promise<void>` using the Notion API to update the project's Status property
7. `lib/atc.ts` must include a §13b section at the end of `runATCCycle()` that queries Executing projects, checks each for terminal state, and calls `transitionProject()` if terminal
8. Project transitions must be logged as ATC events with projectId, new status, and summary

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/project-terminal-state-detection
```

### Step 1: Read existing code to understand current patterns

Before writing any code, read the following files to understand existing patterns:

```bash
cat lib/projects.ts
cat lib/notion.ts
cat lib/atc.ts
cat lib/work-items.ts
cat lib/types.ts
```

Key things to look for:
- How is the Notion API client instantiated in `lib/notion.ts`? (likely `new Client({ auth: process.env.NOTION_API_KEY })`)
- What is the exact shape of the `WorkItem` type in `lib/types.ts`? (need `projectId` and `status` fields)
- What project status values exist? (need the exact string for "Executing" in Notion)
- How does `logATCEvent()` work in `lib/atc.ts`?
- Does `lib/projects.ts` already import from `lib/notion.ts`?
- What function exists to list work items? (e.g., `getAllWorkItems()`, `listWorkItems()`)
- Does a function already exist to fetch projects in a given Notion status?

### Step 2: Update `lib/projects.ts`

Add the following to `lib/projects.ts`. Insert after existing imports and before existing functions:

```typescript
import { Client } from '@notionhq/client';
import type { WorkItem } from './types';

const TERMINAL_STATES = ['merged', 'parked', 'cancelled', 'failed'] as const;
type TerminalState = typeof TERMINAL_STATES[number];

function isTerminalState(status: string): status is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(status);
}

export async function checkProjectCompletion(
  projectId: string,
  workItems: WorkItem[]
): Promise<{ isTerminal: boolean; status: 'Complete' | 'Failed' | null; summary: string }> {
  const projectItems = workItems.filter(item => item.projectId === projectId);

  // If no items, not terminal (no items to complete)
  if (projectItems.length === 0) {
    return { isTerminal: false, status: null, summary: '' };
  }

  // If any item is not in a terminal state, project is not done
  const nonTerminal = projectItems.filter(item => !isTerminalState(item.status));
  if (nonTerminal.length > 0) {
    return { isTerminal: false, status: null, summary: '' };
  }

  // All items are in terminal states
  const mergedItems = projectItems.filter(item => item.status === 'merged');
  const failedItems = projectItems.filter(item => item.status !== 'merged');

  if (failedItems.length === 0) {
    // All merged
    return {
      isTerminal: true,
      status: 'Complete',
      summary: `All ${mergedItems.length} items merged`,
    };
  }

  // Mix or all failed
  const failedTitles = failedItems.map(item => item.title || item.id).join(', ');
  const summary =
    mergedItems.length > 0
      ? `${mergedItems.length} merged, ${failedItems.length} failed/parked: ${failedTitles}`
      : `All items failed/parked: ${failedTitles}`;

  return {
    isTerminal: true,
    status: 'Failed',
    summary,
  };
}

export async function transitionProject(
  projectId: string,
  status: 'Complete' | 'Failed',
  summary: string
): Promise<void> {
  const notion = new Client({ auth: process.env.NOTION_API_KEY });

  await notion.pages.update({
    page_id: projectId,
    properties: {
      Status: {
        select: {
          name: status,
        },
      },
    },
  });

  console.log(`[projects] Transitioned project ${projectId} to ${status}: ${summary}`);
}
```

**Important notes for Step 2:**
- Check the actual field names on `WorkItem` in `lib/types.ts`. The field linking a work item to a project may be `projectId`, `project`, or `notionProjectId` — use whatever exists.
- Check the actual field name for work item title (may be `title`, `name`, or `description`).
- If `lib/projects.ts` already imports `Client` from `@notionhq/client` or has a Notion client instance, reuse it rather than creating a new one.
- If `lib/projects.ts` already has `TERMINAL_STATES` or similar, adapt rather than duplicate.
- The Notion Status property select name may differ from 'Complete'/'Failed'. Check `lib/notion.ts` or existing project transition code for the exact strings used.
- If the Notion property is a `status` type (not `select`), the update payload differs: `Status: { status: { name: status } }`. Inspect existing Notion update calls in the codebase.

### Step 3: Update `lib/atc.ts` — Add §13b

Find `runATCCycle()` in `lib/atc.ts`. Add §13b near the end of the function, after all existing dispatch/monitoring sections but before the final return/log.

First, add the import at the top of `lib/atc.ts` if not already present:
```typescript
import { checkProjectCompletion, transitionProject } from './projects';
```

Also ensure `getAllWorkItems` (or whatever the work item listing function is) is imported:
```typescript
import { getAllWorkItems } from './work-items'; // adjust function name as needed
```

Then add the §13b section inside `runATCCycle()`:

```typescript
  // ── §13b: Project completion detection ──────────────────────────────────
  try {
    // Fetch all projects currently in 'Executing' status from Notion
    const executingProjects = await getProjectsByStatus('Executing'); // adjust to actual function
    
    if (executingProjects.length > 0) {
      const allWorkItems = await getAllWorkItems(); // adjust to actual function name
      
      for (const project of executingProjects) {
        const projectId = project.id; // adjust to actual field name
        
        const result = await checkProjectCompletion(projectId, allWorkItems);
        
        if (result.isTerminal && result.status) {
          await transitionProject(projectId, result.status, result.summary);
          
          await logATCEvent({
            type: 'project_transition',
            projectId,
            status: result.status,
            summary: result.summary,
            timestamp: new Date().toISOString(),
          });
          
          console.log(
            `[ATC §13b] Project ${projectId} transitioned to ${result.status}: ${result.summary}`
          );
        }
      }
    }
  } catch (err) {
    console.error('[ATC §13b] Project completion check failed:', err);
    // Non-fatal: log and continue
  }
  // ── end §13b ─────────────────────────────────────────────────────────────
```

**Important notes for Step 3:**
- Find the actual function to fetch projects by Notion status. It may be in `lib/notion.ts` (e.g., `queryProjectsByStatus()`, `getExecutingProjects()`) or in `lib/projects.ts` itself. If none exists, you may need to add one using the Notion API: query the projects database filtering by Status = 'Executing'.
- The `logATCEvent()` signature may differ — check existing calls in `lib/atc.ts` for the exact shape (it may take `(eventType: string, data: object)` or similar).
- The project object shape from Notion queries may use `project.id` or `project.notionId` — check the existing code.
- `getAllWorkItems()` may be named differently. Check `lib/work-items.ts` exports.

### Step 4: Add `getProjectsByStatus` if missing

If no function exists to query Notion projects by status, add one to `lib/projects.ts` (or `lib/notion.ts` if that's where Notion queries live):

```typescript
export async function getProjectsByStatus(status: string): Promise<Array<{ id: string; title: string }>> {
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  
  const response = await notion.databases.query({
    database_id: process.env.NOTION_PROJECTS_DB_ID!,
    filter: {
      property: 'Status',
      select: {
        equals: status,
      },
    },
  });

  return response.results.map((page: any) => ({
    id: page.id,
    title: page.properties?.Name?.title?.[0]?.plain_text ?? page.id,
  }));
}
```

Note: If the Status property is type `status` (not `select`) in Notion, use:
```typescript
filter: {
  property: 'Status',
  status: {
    equals: status,
  },
},
```

Check `lib/notion.ts` for existing Notion database queries to confirm the filter syntax.

### Step 5: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Run tests if they exist
npm test 2>/dev/null || echo "No tests to run"
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- `WorkItem` type missing `projectId` field — check actual field name in `lib/types.ts`
- `logATCEvent` type mismatch — match the existing call signature exactly
- Notion API property type mismatch (select vs status) — check existing Notion updates in codebase

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add project-level terminal state detection (§13b)

- Add TERMINAL_STATES constant and checkProjectCompletion() to lib/projects.ts
- Add transitionProject() using Notion API to update project Status
- Add §13b to runATCCycle() in lib/atc.ts to auto-transition Executing projects
- Log ATC events for project status transitions
- Non-fatal error handling so ATC cycle continues on §13b failure"

git push origin feat/project-terminal-state-detection

gh pr create \
  --title "feat: add project-level terminal state detection (§13b)" \
  --body "## Summary
Implements §13b from the system map: automatic project completion detection at the end of each ATC cycle.

## Changes
- **lib/projects.ts**: Added \`TERMINAL_STATES\`, \`checkProjectCompletion()\`, \`transitionProject()\`, and \`getProjectsByStatus()\`
- **lib/atc.ts**: Added §13b section to \`runATCCycle()\` that detects terminal project state and auto-transitions Notion projects to Complete or Failed

## Behavior
- All work items merged → project transitions to **Complete** (\`All N items merged\`)
- Any work item failed/parked → project transitions to **Failed** (lists failed item titles)
- Any work item still active → no transition

## Testing
- TypeScript compiles cleanly
- Non-fatal: §13b errors are caught and logged without aborting the ATC cycle

Closes: C4"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/project-terminal-state-detection
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "getProjectsByStatus not implemented", "logATCEvent signature mismatch"]
```

## Escalation

If blocked on architectural decisions (e.g., the Notion Status property type is neither `select` nor `status`, or `WorkItem` has no `projectId`-equivalent field), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "C4",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/projects.ts", "lib/atc.ts"]
    }
  }'
```