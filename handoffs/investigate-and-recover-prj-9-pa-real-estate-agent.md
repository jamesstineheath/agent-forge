<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Investigate and Recover PRJ-9 Decomposition Failure

## Metadata
- **Branch:** `feat/prj9-decomposition-recovery`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/decomposer.ts, lib/notion.ts, app/api/admin/repair-index/route.ts

## Context

Project PRJ-9 "PA Real Estate Agent v2" transitioned to `Failed` at 2026-03-18T01:55Z because ATC decomposition produced 0 work items. The ATC event logged was:

> "Decomposition produced 0 work items for 'PA Real Estate Agent v2', transitioning to Failed"

The decomposer (`lib/decomposer.ts`) reads a Notion plan page, parses its content into ordered work items with a dependency DAG, and creates those work items in the store. If it returns 0 items, the project fails immediately.

Root causes could be:
1. **Transient Notion API error** — empty response or timeout
2. **Plan page format mismatch** — the page uses a block/heading structure the parser doesn't recognize
3. **All items pre-marked complete** — parser skips items it considers done

The ATC section that handles this is in `lib/atc.ts` around the decomposition guard (§13a handles stuck projects). The decomposer is in `lib/decomposer.ts` and uses `lib/notion.ts` for Notion API calls.

**Key Notion details:**
- Projects DB: `b1eb06a469ac4a9eb3f01851611fb80b`
- PRJ-9 project Notion page: retrieve via projects DB query filtering for project ID `PRJ-9`

**Existing patterns to follow:**
- `lib/notion.ts` exports `fetchPageContent(pageId: string)` and a Notion client
- `lib/decomposer.ts` calls `fetchPageContent` and parses the result into `WorkItem[]`
- Project status transitions use `lib/projects.ts`
- The ATC `§13a` self-healing can reset stuck projects by reverting their status

## Requirements

1. Fetch the PRJ-9 plan page content from Notion via the existing `fetchPageContent` and related APIs, and log what was returned so the root cause is clear.
2. Add diagnostic logging to `lib/decomposer.ts` so that when 0 work items are produced, the raw Notion response (block count, block types) and parsing steps are logged to `console.error` before returning — this must survive the PR as permanent observability.
3. If the plan page has valid actionable content: reset PRJ-9's Notion status back to `"Execute"` programmatically (using the Notion API client in `lib/notion.ts`) so ATC will re-decompose on the next cycle.
4. If the plan page is empty or unparseable: add a comment in `lib/decomposer.ts` explaining what format is expected, and document the fix needed in the PR description.
5. The fix must not break existing decomposer behavior for valid plan pages — all existing logic is preserved, only logging is added.
6. TypeScript must compile with no errors (`npx tsc --noEmit`).
7. If a Notion status reset is performed, it must use the same `updateProjectStatus` / Notion client pattern already present in `lib/notion.ts` or `lib/projects.ts`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prj9-decomposition-recovery
```

### Step 1: Read existing decomposer and Notion client code

Read the full content of these files before making any changes:

```bash
cat lib/decomposer.ts
cat lib/notion.ts
cat lib/projects.ts
cat lib/atc.ts | grep -A 30 "decompos" | head -80
```

Understand:
- How `fetchPageContent` works and what it returns
- How the decomposer iterates blocks to build work items
- What block types / structures it expects
- How project status is updated (which Notion property name, which API call)

### Step 2: Fetch the PRJ-9 plan page content (diagnostic)

Write a small diagnostic script to fetch and inspect the PRJ-9 Notion data. Create `scripts/diagnose-prj9.ts`:

```typescript
// scripts/diagnose-prj9.ts
// Run with: npx ts-node --project tsconfig.json scripts/diagnose-prj9.ts
// Requires NOTION_API_KEY and NOTION_PROJECTS_DB_ID in environment

import { Client } from "@notionhq/client";

async function main() {
  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const dbId = process.env.NOTION_PROJECTS_DB_ID || "b1eb06a469ac4a9eb3f01851611fb80b";

  // Query for PRJ-9
  const response = await notion.databases.query({
    database_id: dbId,
    filter: {
      property: "ID", // adjust property name if different
      rich_text: { equals: "PRJ-9" },
    },
  });

  console.log("Query result page count:", response.results.length);

  if (response.results.length === 0) {
    console.error("PRJ-9 not found. Check filter property name.");
    // Try listing a few projects to see available properties
    const sample = await notion.databases.query({ database_id: dbId, page_size: 3 });
    console.log("Sample project properties:", JSON.stringify(
      sample.results[0] && "properties" in sample.results[0]
        ? Object.keys(sample.results[0].properties)
        : "no results",
      null,
      2
    ));
    return;
  }

  const project = response.results[0];
  if (!("properties" in project)) return;

  console.log("PRJ-9 properties:", JSON.stringify(project.properties, null, 2));
  console.log("PRJ-9 page ID:", project.id);

  // Find the plan page (look for a "Plan" relation or child page)
  const blocks = await notion.blocks.children.list({ block_id: project.id });
  console.log("Top-level block count:", blocks.results.length);
  console.log("Block types:", blocks.results.map((b: any) => b.type));
  console.log("Full blocks:", JSON.stringify(blocks.results, null, 2));
}

main().catch(console.error);
```

**Important:** Do NOT run this script (no credentials in this environment). Instead, review the output conceptually by reading `lib/notion.ts` to understand what `fetchPageContent` already returns, and reason about what the decomposer receives.

### Step 3: Add diagnostic logging to lib/decomposer.ts

Open `lib/decomposer.ts`. Locate the section where work items are collected/returned. Add logging **before** the `return []` or equivalent zero-result path, and also a general trace after parsing.

The pattern to add (adapt to actual variable names in the file):

```typescript
// After parsing blocks into work items, before returning:
if (workItems.length === 0) {
  console.error(
    `[Decomposer] PRJ decomposition produced 0 work items.`,
    JSON.stringify({
      projectId: project.id ?? "unknown",
      projectName: project.name ?? "unknown",
      rawBlockCount: blocks?.length ?? 0,
      rawBlockTypes: blocks?.map((b: any) => b.type) ?? [],
      parsedSections: parsedSections ?? "N/A", // adapt to actual var
    }, null, 2)
  );
}

// Also add at the top of the decompose function, after fetching blocks:
console.log(
  `[Decomposer] Fetched ${blocks?.length ?? 0} blocks for project "${project.name}". ` +
  `Block types: ${[...new Set(blocks?.map((b: any) => b.type) ?? [])].join(", ")}`
);
```

**Adapt these snippets to the actual variable names in `lib/decomposer.ts`.** Do not rename existing variables. The goal is to emit structured log output that will appear in Vercel function logs on the next decomposition run.

### Step 4: Add a Notion status reset utility in lib/notion.ts (if not already present)

Read `lib/notion.ts`. Check whether there is already a function to update a project's status property (e.g., `updateProjectStatus`, `setNotionProjectStatus`, or similar).

**If a status update function already exists**, skip to Step 5.

**If no such function exists**, add one at the bottom of `lib/notion.ts`:

```typescript
/**
 * Resets a Notion project page's Status property to a given value.
 * Used by recovery scripts and ATC self-healing to re-queue failed projects.
 */
export async function setNotionProjectStatus(
  pageId: string,
  status: string
): Promise<void> {
  // Use the existing notionClient (or Client instance already in this file)
  await notionClient.pages.update({
    page_id: pageId,
    properties: {
      Status: {
        select: { name: status },
      },
    },
  });
  console.log(`[Notion] Set project ${pageId} status to "${status}"`);
}
```

Adapt the property name (`Status`) and Notion client variable name to match what's already used in the file.

### Step 5: Create a PRJ-9 recovery API endpoint

Create `app/api/admin/recover-prj9/route.ts`. This provides a one-time authenticated endpoint to:
1. Fetch the PRJ-9 Notion page
2. Log its content
3. Reset its status to `"Execute"` if the plan page appears valid

```typescript
// app/api/admin/recover-prj9/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { Client } from "@notionhq/client";

export async function POST(req: Request) {
  // Auth check — only authenticated users
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const notion = new Client({ auth: process.env.NOTION_API_KEY });
  const dbId = process.env.NOTION_PROJECTS_DB_ID || "b1eb06a469ac4a9eb3f01851611fb80b";

  try {
    // 1. Find PRJ-9
    // Try common property names for the project identifier
    let projectPage: any = null;

    // Query the DB and find PRJ-9 by scanning results
    const dbResults = await notion.databases.query({
      database_id: dbId,
      page_size: 100,
    });

    for (const page of dbResults.results) {
      if (!("properties" in page)) continue;
      const props = page.properties as Record<string, any>;
      // Check common ID field names
      for (const key of ["ID", "Name", "Project ID", "id"]) {
        const prop = props[key];
        if (!prop) continue;
        const textVal =
          prop.title?.[0]?.plain_text ||
          prop.rich_text?.[0]?.plain_text ||
          prop.select?.name ||
          "";
        if (textVal.includes("PRJ-9") || textVal.includes("Real Estate Agent v2")) {
          projectPage = page;
          break;
        }
      }
      if (projectPage) break;
    }

    if (!projectPage) {
      return NextResponse.json({
        error: "PRJ-9 not found in Notion DB",
        hint: "Check NOTION_PROJECTS_DB_ID env var and property names",
        totalPages: dbResults.results.length,
      }, { status: 404 });
    }

    // 2. Fetch the page's blocks
    const blocks = await notion.blocks.children.list({ block_id: projectPage.id });
    const blockSummary = blocks.results.map((b: any) => ({
      type: b.type,
      text: b[b.type]?.rich_text?.[0]?.plain_text
        || b[b.type]?.text?.[0]?.plain_text
        || "",
    }));

    console.log("[recover-prj9] PRJ-9 page ID:", projectPage.id);
    console.log("[recover-prj9] Block count:", blocks.results.length);
    console.log("[recover-prj9] Blocks:", JSON.stringify(blockSummary, null, 2));

    // 3. Determine current status
    const props = projectPage.properties as Record<string, any>;
    const currentStatus =
      props["Status"]?.select?.name ||
      props["status"]?.select?.name ||
      "unknown";

    console.log("[recover-prj9] Current status:", currentStatus);

    // 4. If the page has blocks (potential plan content), reset to Execute
    const hasContent = blocks.results.length > 0;
    let resetPerformed = false;

    if (hasContent && currentStatus === "Failed") {
      // Reset to Execute so ATC will re-decompose
      await notion.pages.update({
        page_id: projectPage.id,
        properties: {
          Status: {
            select: { name: "Execute" },
          },
        },
      });
      resetPerformed = true;
      console.log("[recover-prj9] Reset PRJ-9 status to Execute");
    }

    return NextResponse.json({
      success: true,
      projectPageId: projectPage.id,
      currentStatus,
      blockCount: blocks.results.length,
      blockTypes: [...new Set(blocks.results.map((b: any) => (b as any).type))],
      blockSummary,
      resetPerformed,
      message: resetPerformed
        ? "PRJ-9 reset to Execute — ATC will re-decompose on next cycle"
        : hasContent
          ? `PRJ-9 has ${blocks.results.length} blocks but status is "${currentStatus}" — no reset needed`
          : "PRJ-9 plan page is empty — manual intervention required to add plan content",
    });
  } catch (error: any) {
    console.error("[recover-prj9] Error:", error);
    return NextResponse.json({
      error: error.message,
      stack: error.stack,
    }, { status: 500 });
  }
}
```

### Step 6: Update lib/work-items.ts or lib/atc.ts — improve ATC guard for 0-item decomposition

Open `lib/atc.ts`. Find the section that calls the decomposer and checks the result. Look for the guard that transitions projects to `Failed` when 0 items are produced.

The current pattern likely looks like:
```typescript
if (workItems.length === 0) {
  // transition to Failed
}
```

**Improve it** to add a retry attempt before failing permanently. If a dedup guard already exists, this may already be handled. Check `§13a` in the ATC logic. If the failing path goes directly to `Failed` without retry:

Add a comment and optionally a `console.error` with context:

```typescript
if (workItems.length === 0) {
  console.error(
    `[ATC] Decomposition produced 0 work items for "${project.name}" (${project.id}). ` +
    `Transitioning to Failed. Check Notion plan page format and decomposer logs.`
  );
  // Transition to Failed...
}
```

This is a low-risk, non-behavioral change — only adds logging.

### Step 7: TypeScript check and lint

```bash
npx tsc --noEmit
```

Fix any type errors introduced. Common issues:
- The `notion.pages.update` call may need a type cast if the Notion SDK types are strict
- The diagnostic endpoint uses `any` casts which are acceptable for admin utilities

### Step 8: Verification

```bash
npx tsc --noEmit
npm run build
```

Ensure:
- Build succeeds with no errors
- No new TypeScript errors in `lib/decomposer.ts`, `lib/notion.ts`, or `app/api/admin/recover-prj9/route.ts`
- The existing `lib/atc.ts` logic is unchanged except for added log lines

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "fix: add decomposer diagnostics and PRJ-9 recovery endpoint

- Add structured logging to lib/decomposer.ts when 0 work items produced
  (logs raw block count, types, and parsing trace for Vercel log visibility)
- Add /api/admin/recover-prj9 endpoint to inspect PRJ-9 Notion plan page
  and reset status to 'Execute' if page has valid content
- Optionally add setNotionProjectStatus() to lib/notion.ts if not present
- Improve ATC 0-item guard log message with project context

To recover PRJ-9: POST /api/admin/recover-prj9 (authenticated)
The endpoint will log page content and reset Notion status if page is non-empty."

git push origin feat/prj9-decomposition-recovery

gh pr create \
  --title "fix: PRJ-9 decomposition recovery + decomposer diagnostic logging" \
  --body "## Summary

Project PRJ-9 'PA Real Estate Agent v2' failed at 2026-03-18T01:55Z because ATC decomposition produced 0 work items.

## Changes

### lib/decomposer.ts
- Added structured \`console.error\` logging when 0 work items are produced, capturing raw block count, block types, and parsing trace
- Added trace log at the start of decomposition showing fetched block count and types
- These logs will appear in Vercel function logs on next decomposition run

### lib/notion.ts
- Added \`setNotionProjectStatus(pageId, status)\` utility if not already present

### app/api/admin/recover-prj9/route.ts (new)
- Authenticated POST endpoint to inspect PRJ-9's Notion plan page
- Returns block count, block types, and block summary
- Automatically resets status to 'Execute' if page has content and status is 'Failed'
- Call this endpoint to trigger recovery: \`POST /api/admin/recover-prj9\`

### lib/atc.ts
- Improved log message on 0-item decomposition to include project name and ID

## Recovery Instructions

1. Merge this PR
2. POST to \`/api/admin/recover-prj9\` (authenticated session required)
3. Check response: \`resetPerformed: true\` means PRJ-9 is queued for re-decomposition
4. On next ATC cycle, PRJ-9 will be decomposed again — check Vercel logs for decomposer output

## Root Cause Investigation

The endpoint response will reveal whether:
- The plan page is empty (needs content added in Notion)
- The plan page has blocks but in an unexpected format (needs decomposer parser fix)
- The plan page is valid (transient Notion API error — reset will fix it)

## Risk

Low — only adds logging and a new admin endpoint. No changes to existing decomposer logic or ATC dispatch behavior."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prj9-decomposition-recovery
FILES CHANGED: [list files modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "run POST /api/admin/recover-prj9 after deploy"]
```

## Escalation Protocol

If you encounter a blocker (e.g., Notion property names don't match any expected pattern, `lib/decomposer.ts` uses a completely different structure than anticipated, or the Notion client is not initialized in `lib/notion.ts`):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prj9-decomposition-recovery",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker>",
      "filesChanged": ["lib/decomposer.ts", "lib/notion.ts", "app/api/admin/recover-prj9/route.ts"]
    }
  }'
```