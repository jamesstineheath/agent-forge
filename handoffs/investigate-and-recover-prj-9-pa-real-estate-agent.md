<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Investigate and Recover PRJ-9 Decomposition Failure

## Metadata
- **Branch:** `fix/investigate-and-recover-prj-9-pa-real-estate-agent`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/decomposer.ts, lib/notion.ts, app/api/admin/recover-prj9/route.ts

## Context

Project PRJ-9 "PA Real Estate Agent v2" transitioned to `Failed` at 2026-03-18T01:55Z because ATC decomposition produced 0 work items. The ATC event logged was:

> "Decomposition produced 0 work items for 'PA Real Estate Agent v2', transitioning to Failed"

The decomposer (`lib/decomposer.ts`) reads a Notion plan page, parses its content into ordered work items with a dependency DAG, and creates those work items in the store. If it returns 0 items, the project fails immediately.

Root causes could be:
1. **Transient Notion API error** — empty response or timeout
2. **Plan page format mismatch** — the page uses a block/heading structure the parser doesn't recognize
3. **All items pre-marked complete** — parser skips items it considers done

**Key files:**
- `lib/decomposer.ts` — plan page → work items parser
- `lib/notion.ts` — Notion API client, `fetchPageContent(pageId)`
- `lib/projects.ts` — project status transitions
- `lib/atc.ts` — ATC dispatch, §13a self-healing for stuck projects

**Auth pattern:** API routes in this codebase use Bearer token auth with `AGENT_FORGE_API_SECRET`. Check existing admin routes (e.g., `app/api/admin/repair-index/route.ts`) for the exact pattern before writing new ones.

## Requirements

1. Add permanent diagnostic logging to `lib/decomposer.ts`: when 0 work items are produced, log the raw block count, block types, and any parsing context to `console.error` before returning.
2. Add a general trace log at the start of decomposition showing fetched block count and unique block types.
3. Create an authenticated admin endpoint `POST /api/admin/recover-prj9` that: (a) fetches PRJ-9's Notion page and logs its content structure, (b) resets PRJ-9's Notion status to `"Execute"` if the plan page has content and status is `"Failed"`.
4. If a `setNotionProjectStatus(pageId, status)` utility doesn't already exist in `lib/notion.ts` or `lib/projects.ts`, add one.
5. Improve the ATC 0-item decomposition log message to include project name and ID.
6. **No behavioral changes** to existing decomposer logic or ATC dispatch — only logging additions and the new admin endpoint.
7. TypeScript must compile: `npx tsc --noEmit` passes.
8. Build must succeed: `npm run build` passes.

## Execution Steps

### Step 0: Pre-flight — read existing code

Read ALL of these files before writing any code:
