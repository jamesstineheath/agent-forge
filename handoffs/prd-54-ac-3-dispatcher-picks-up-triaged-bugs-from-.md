<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- PRD-54 AC-3: Dispatcher picks up Triaged bugs from Notion DB

## Metadata
- **Branch:** `feat/prd-54-ac-3-dispatcher-triaged-bugs`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/dispatcher.ts, lib/notion.ts, lib/bugs.ts

## Context

Agent Forge's Dispatcher agent (`lib/atc/dispatcher.ts`) currently dispatches work items from Postgres (`getAllDispatchable()`). This AC extends the dispatcher to also pick up **Triaged** bugs from a Notion Bugs database (`023f3621-2885-468d-a8cf-2e0bd1458bb3`) and convert them into work items automatically.

The Notion API pattern already exists in `lib/notion.ts` (used for project plans). The work item creation API is in `lib/work-items.ts`. The goal is:
1. Query Notion Bugs DB for Status="Triaged"
2. Sort by severity (Critical > High > Medium/Low), then by age (oldest first)
3. Create a work item per bug, update the Notion bug page with the work item ID + set Status="In Progress"
4. Critical bugs get dispatched **before** PRD work items; High/Medium/Low **after**

A shared `lib/bugs.ts` helper should be created so AC-4, AC-5, and AC-6 can reuse the query logic.

### Key existing patterns

**lib/notion.ts** — uses `Client` from `@notionhq/client`, environment variable `NOTION_API_KEY`. Database queries use `notion.databases.query(...)`. Page updates use `notion.pages.update(...)`.

**lib/work-items.ts** — `createWorkItem(params)` returns a `WorkItem`. Accepts `title`, `description`, `targetRepo`, `source`, `priority`, `status`.

**lib/atc/dispatcher.ts** — `runDispatcher(ctx: CycleContext)` is the main entry point. Phase 1 uses `getAllDispatchable()` then dispatches within concurrency limits via a `concurrencyMap` and `activeExecutions` array. The function tracks `slotsRemaining` (total concurrency cap minus active).

## Requirements

1. Add `BUGS_DATABASE_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3"` as a constant in `lib/bugs.ts`.
2. Create `lib/bugs.ts` with a `queryTriagedBugs()` function that queries the Notion Bugs DB for pages with Status="Triaged", returning structured bug objects with: `id`, `title`, `severity`, `context`, `targetRepo`, `createdTime`.
3. Create `updateBugPage(pageId, workItemId)` in `lib/bugs.ts` that sets the bug's `Work Item ID` property to `workItemId` and `Status` to `"In Progress"`.
4. Add `dispatchTriagedBugs(ctx, slotsRemaining, concurrencyMap, activeExecutions, severityFilter)` to `lib/atc/dispatcher.ts` — `severityFilter` parameter allows filtering to just `["Critical"]` or `["High", "Medium", "Low"]`.
5. Sort queried bugs: Critical first, then High, then Medium/Low; within same severity oldest `created_time` first.
6. Map severity to work item priority: `Critical` → `priority: "high"` with `expedite: true` (or tag in description if expedite field doesn't exist); `High` → `priority: "high"`; `Medium`/`Low` → `priority: "medium"`.
7. Call `dispatchTriagedBugs` with `["Critical"]` **before** the main `getAllDispatchable()` PRD dispatch loop in `runDispatcher`.
8. Call `dispatchTriagedBugs` with `["High", "Medium", "Low"]` **after** the main `getAllDispatchable()` dispatch loop.
9. Each bug dispatched: create work item with `source: "bug"`, set status to `"ready"` on creation, update Notion bug page with new work item ID and Status="In Progress".
10. Respect `slotsRemaining` — stop dispatching bugs if slots are exhausted.
11. Emit events via `ctx.emit(...)` for each bug work item created (follow existing dispatcher event patterns).
12. Do not break existing dispatcher behavior for PRD work items.
13. TypeScript compiles with no errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prd-54-ac-3-dispatcher-triaged-bugs
```

### Step 1: Understand existing code

Read these files carefully before writing any code:

```bash
cat lib/notion.ts
cat lib/atc/dispatcher.ts
cat lib/work-items.ts
cat lib/atc/types.ts
cat lib/atc/events.ts
```

Pay attention to:
- How `lib/notion.ts` constructs the Notion client and queries databases
- The exact signature of `createWorkItem()` in `lib/work-items.ts` (field names, required vs optional)
- How `runDispatcher` tracks `slotsRemaining`, `concurrencyMap`, `activeExecutions`
- The `ctx.emit(...)` pattern used in dispatcher events
- Whether a `priority` field of type `"high" | "medium" | "low"` exists, or whether it's different

### Step 2: Create `lib/bugs.ts`

Create a new file `lib/bugs.ts` with the following structure:

```typescript
import { Client } from "@notionhq/client";

export const BUGS_DATABASE_ID = "023f3621-2885-468d-a8cf-2e0bd1458bb3";

export interface TriagedBug {
  id: string;          // Notion page ID
  title: string;
  severity: "Critical" | "High" | "Medium" | "Low";
  context: string;     // Notion "Context" property (rich text)
  targetRepo: string;  // Notion "Target Repo" property (select or rich text)
  createdTime: string; // ISO timestamp from page created_time
}

function getNotionClient(): Client {
  return new Client({ auth: process.env.NOTION_API_KEY });
}

/**
 * Query the Bugs database for pages where Status = "Triaged".
 * Returns structured bug objects sorted by severity (Critical first) then age (oldest first).
 */
export async function queryTriagedBugs(): Promise<TriagedBug[]> {
  const notion = getNotionClient();
  
  const response = await notion.databases.query({
    database_id: BUGS_DATABASE_ID,
    filter: {
      property: "Status",
      status: {
        equals: "Triaged",
      },
    },
  });

  const bugs: TriagedBug[] = [];

  for (const page of response.results) {
    if (page.object !== "page") continue;
    
    // NOTE: After reading lib/notion.ts, adjust property access patterns
    // to match the actual Notion property types used in this codebase.
    // Common patterns: page.properties.Title.title[0].plain_text
    //                  page.properties.Severity.select?.name
    //                  page.properties.Context.rich_text[0]?.plain_text
    //                  page.properties["Target Repo"].select?.name
    
    const props = (page as any).properties;
    
    const title =
      props?.Title?.title?.[0]?.plain_text ||
      props?.Name?.title?.[0]?.plain_text ||
      "Untitled Bug";
    
    const severity: TriagedBug["severity"] =
      (props?.Severity?.select?.name as TriagedBug["severity"]) || "Medium";
    
    const context =
      props?.Context?.rich_text?.map((r: any) => r.plain_text).join("") || "";
    
    const targetRepo =
      props?.["Target Repo"]?.select?.name ||
      props?.["Target Repo"]?.rich_text?.[0]?.plain_text ||
      "";

    bugs.push({
      id: page.id,
      title,
      severity,
      context,
      targetRepo,
      createdTime: (page as any).created_time,
    });
  }

  // Sort: Critical > High > Medium > Low, then oldest first within same severity
  const severityOrder: Record<TriagedBug["severity"], number> = {
    Critical: 0,
    High: 1,
    Medium: 2,
    Low: 3,
  };

  bugs.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return new Date(a.createdTime).getTime() - new Date(b.createdTime).getTime();
  });

  return bugs;
}

/**
 * Update a Notion bug page: set Work Item ID and transition Status to "In Progress".
 */
export async function updateBugPage(
  pageId: string,
  workItemId: string
): Promise<void> {
  const notion = getNotionClient();

  await notion.pages.update({
    page_id: pageId,
    properties: {
      // Adjust property names/types to match the actual Notion DB schema.
      // "Work Item ID" is likely a rich_text or number property.
      "Work Item ID": {
        rich_text: [
          {
            type: "text",
            text: { content: workItemId },
          },
        ],
      },
      Status: {
        status: {
          name: "In Progress",
        },
      },
    },
  });
}
```

**Important:** After reading `lib/notion.ts`, adjust the Notion property access patterns if the existing code uses a different approach (e.g., if it casts pages differently or uses a helper to extract text). Mirror the existing patterns exactly.

### Step 3: Add `dispatchTriagedBugs` to `lib/atc/dispatcher.ts`

After reading the dispatcher file, add the following function. Adjust types/imports to match what's already in the file:

```typescript
import { queryTriagedBugs, updateBugPage, TriagedBug, BUGS_DATABASE_ID } from "../bugs";
// Also import createWorkItem if not already imported:
import { createWorkItem } from "../work-items";
```

Add this function before `runDispatcher`:

```typescript
async function dispatchTriagedBugs(
  ctx: CycleContext,
  slotsRemaining: { count: number }, // pass as object so mutations are visible to caller
  concurrencyMap: Map<string, number>,
  activeExecutions: string[],
  severityFilter: Array<"Critical" | "High" | "Medium" | "Low">
): Promise<void> {
  if (slotsRemaining.count <= 0) return;

  let bugs: import("../bugs").TriagedBug[];
  try {
    bugs = await queryTriagedBugs();
  } catch (err) {
    ctx.emit({
      type: "dispatcher.bugs.query_failed",
      error: String(err),
    });
    return;
  }

  // Filter to requested severities
  const filtered = bugs.filter((b) => severityFilter.includes(b.severity));

  for (const bug of filtered) {
    if (slotsRemaining.count <= 0) break;

    // Check per-repo concurrency
    const repoKey = bug.targetRepo;
    const repoActive = concurrencyMap.get(repoKey) ?? 0;
    // Use same per-repo concurrency limit as existing dispatcher logic
    // (read from ctx or use a default of 2)
    const perRepoCap = ctx.config?.perRepoConcurrency ?? 2;
    if (repoActive >= perRepoCap) {
      ctx.emit({
        type: "dispatcher.bugs.skipped_concurrency",
        bugId: bug.id,
        title: bug.title,
        repo: bug.targetRepo,
      });
      continue;
    }

    // Map severity to priority
    const priority =
      bug.severity === "Critical" || bug.severity === "High" ? "high" : "medium";
    
    const descriptionPrefix =
      bug.severity === "Critical"
        ? "[CRITICAL BUG] "
        : bug.severity === "High"
        ? "[HIGH BUG] "
        : "";
    
    const description = `${descriptionPrefix}${bug.context || bug.title}`;

    try {
      // Create the work item
      const workItem = await createWorkItem({
        title: bug.title,
        description,
        targetRepo: bug.targetRepo,
        source: "bug",
        priority,
        status: "ready",
      });

      // Update Notion bug page
      await updateBugPage(bug.id, workItem.id);

      // Track concurrency
      concurrencyMap.set(repoKey, repoActive + 1);
      activeExecutions.push(workItem.id);
      slotsRemaining.count--;

      ctx.emit({
        type: "dispatcher.bugs.dispatched",
        bugId: bug.id,
        workItemId: workItem.id,
        title: bug.title,
        severity: bug.severity,
        priority,
        repo: bug.targetRepo,
      });
    } catch (err) {
      ctx.emit({
        type: "dispatcher.bugs.dispatch_failed",
        bugId: bug.id,
        title: bug.title,
        error: String(err),
      });
    }
  }
}
```

### Step 4: Integrate into `runDispatcher`

In the `runDispatcher` function, integrate the two calls around the existing Phase 1 dispatch loop.

Find the section where `getAllDispatchable()` is called and PRD items are dispatched. Wrap it like this:

```typescript
// --- BEFORE existing Phase 1 loop ---

// Track slots as a mutable object so dispatchTriagedBugs can update it
const slotsObj = { count: slotsRemaining };

// Critical bugs first — before PRD work items
await dispatchTriagedBugs(ctx, slotsObj, concurrencyMap, activeExecutions, ["Critical"]);
slotsRemaining = slotsObj.count;

// --- EXISTING Phase 1: getAllDispatchable() loop goes here ---
// (keep the existing loop unchanged)

// High/Medium/Low bugs after PRD items
slotsObj.count = slotsRemaining;
await dispatchTriagedBugs(ctx, slotsObj, concurrencyMap, activeExecutions, ["High", "Medium", "Low"]);
slotsRemaining = slotsObj.count;
```

**Note:** The exact variable names (`slotsRemaining`, `concurrencyMap`, `activeExecutions`) depend on what you find in the actual file. Mirror the exact names used there.

### Step 5: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- `createWorkItem` may not accept a `source: "bug"` — check the union type in `lib/types.ts` and add `"bug"` if missing
- `status: "ready"` on creation — check if `createWorkItem` accepts an initial status or if that needs to be set via a separate `updateWorkItem` call
- The `ctx.emit` signature — check what event shape the existing dispatcher uses and conform to it
- `ctx.config?.perRepoConcurrency` may not exist — check `CycleContext` in `lib/atc/types.ts` and use the correct field

### Step 6: Handle edge cases found during reading

After reading the actual files, address any of these that apply:

- If `createWorkItem` doesn't accept `status`, call `updateWorkItemStatus(workItem.id, "ready")` after creation
- If `source` union type doesn't include `"bug"`, add it to `lib/types.ts`
- If the Notion property types for the Bugs DB differ from what's assumed (e.g., Status is a "select" not "status"), update `lib/bugs.ts` accordingly
- If `lib/notion.ts` uses a different Notion client initialization pattern, mirror it in `lib/bugs.ts`
- If `concurrencyMap` keys are formatted differently (e.g., `owner/repo` slugs), match that format

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build 2>&1 | head -50
```

Also do a quick sanity check:
```bash
grep -n "dispatchTriagedBugs" lib/atc/dispatcher.ts
grep -n "BUGS_DATABASE_ID" lib/bugs.ts
grep -n "queryTriagedBugs\|updateBugPage" lib/bugs.ts
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: PRD-54 AC-3 — dispatcher picks up Triaged bugs from Notion DB"
git push origin feat/prd-54-ac-3-dispatcher-triaged-bugs
gh pr create \
  --title "feat: PRD-54 AC-3 — Dispatcher picks up Triaged bugs from Notion DB" \
  --body "## Summary

Extends the Dispatcher agent to automatically convert Triaged bugs from the Notion Bugs database into work items and dispatch them alongside PRD work items.

## Changes

- **lib/bugs.ts** (new): \`queryTriagedBugs()\`, \`updateBugPage()\`, \`BUGS_DATABASE_ID\` constant — reusable by AC-4, AC-5, AC-6
- **lib/atc/dispatcher.ts**: \`dispatchTriagedBugs()\` function + integration into \`runDispatcher()\`
  - Critical bugs dispatched **before** PRD work items
  - High/Medium/Low bugs dispatched **after** PRD work items
  - Respects existing concurrency limits

## Behavior

1. Queries Notion Bugs DB (\`023f3621-2885-468d-a8cf-2e0bd1458bb3\`) for Status=Triaged
2. Sorts by severity (Critical→High→Medium→Low), then oldest first
3. Creates a work item per bug (source=bug, status=ready)
4. Updates Notion page: sets Work Item ID + Status=In Progress
5. Emits dispatcher events for observability

## Testing

- TypeScript compiles clean
- Existing PRD dispatch flow unchanged
- Concurrency limits respected

Closes PRD-54 AC-3"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prd-54-ac-3-dispatcher-triaged-bugs
FILES CHANGED: [list what was modified]
SUMMARY: [what was completed]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "createWorkItem doesn't accept source:'bug', need to update lib/types.ts"]
```

## Escalation Protocol

If you hit a blocker you cannot resolve (e.g., Notion Bugs DB schema is completely different from what's assumed, `createWorkItem` has an incompatible signature, or the dispatcher's concurrency model has changed significantly):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-54-ac-3",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/bugs.ts", "lib/atc/dispatcher.ts"]
    }
  }'
```