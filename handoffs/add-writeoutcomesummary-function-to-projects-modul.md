# Agent Forge -- Add writeOutcomeSummary function to projects module

## Metadata
- **Branch:** `feat/write-outcome-summary`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/projects.ts

## Context

Agent Forge's `lib/projects.ts` manages project lifecycle transitions (Complete/Failed). When a project reaches a terminal state, it's valuable to write a structured outcome summary back to the originating Notion project page so stakeholders can see what shipped, what failed, and what remains.

The `appendPageContent` helper was recently added to `lib/notion.ts`. The `listWorkItems` function in `lib/work-items.ts` supports filtering. This task adds `writeOutcomeSummary` to `lib/projects.ts` that ties these together.

## Requirements

1. Export `writeOutcomeSummary(projectId: string, status: 'Complete' | 'Failed'): Promise<void>` from `lib/projects.ts`
2. Function must fetch all work items for the project. Use `listWorkItems` from `lib/work-items.ts` and filter by `projectId`. If `listWorkItems` accepts a filter parameter, use it; otherwise filter client-side.
3. Look up the project's Notion page ID. Find the existing project getter in `lib/projects.ts` (e.g., `getProject`, `getProjectById`, or filter `listProjects`). If `notionPageId` (or equivalent) is missing, log a warning and return early.
4. Compute stats:
   - **Merged count**: items with `status === 'merged'`
   - **Failed count**: items with `status === 'failed'`
   - **Remaining count**: items with status in `['ready', 'blocked', 'queued', 'parked']`
   - **Total count**: all items
   - **Estimated cost**: sum of `budget` fields where present (handle both number and string types)
5. Compute duration from earliest `createdAt` to latest `updatedAt` among all work items. Format as human-readable: `"3d 4h"` for multi-day, `"2h 15m"` for multi-hour, `"15m"` for sub-hour. Show `"unknown"` if timestamps insufficient.
6. **Complete status markdown** must include:
   - `## Outcome Summary` header with status, duration, counts, estimated cost
   - `### Merged PRs` section listing each merged item as `- repoName#prNumber: title` (use `(no PR)` if prNumber missing)
   - `### Notes` section listing cancelled items if any
7. **Failed status markdown** must include the same header stats, plus:
   - `### What Shipped` — merged items formatted as above
   - `### What Failed` — failed items with failure reason if available on the WorkItem type (check for fields like `escalationReason`, `failureReason`, `error`, or similar; use `"No failure context recorded"` as fallback)
   - `### What Remains` — remaining items with their status
   - `### Recovery Assessment` with Retryable/Reason/Recommendation fields:
     - If no failed items: `N/A` / `No failures recorded` / `Review remaining items manually`
     - If ALL failure reason strings contain CI/transient keywords (`ci`, `timeout`, `network`, `rate limit`): `Yes` / `All failures appear to be transient CI/infrastructure issues` / `Retry`
     - If ANY failure reason contains conflict/plan keywords (`conflict`, `plan`, `merge conflict`, `design`, `dependency`): `Partial` / `Some failures involve conflicts or plan-level issues` / `Re-plan`
     - Otherwise: `No` / `Failures do not match known transient patterns` / `Abandon`
8. Call `appendPageContent(notionPageId, summaryMarkdown)` from `lib/notion.ts` to write to Notion
9. Handle zero work items: write minimal summary: `## Outcome Summary\n\n**Status:** {status}\n\n_No work items found for this project._`
10. `npx tsc --noEmit` passes with no new type errors

## Pre-flight Checks

Before writing any code, verify these exist. If any are missing, **escalate immediately** — do not attempt workarounds:

- [ ] `appendPageContent` is exported from `lib/notion.ts` (signature: takes a page ID string and markdown string)
- [ ] `listWorkItems` is exported from `lib/work-items.ts`
- [ ] A way to get a project by ID exists in `lib/projects.ts` (any getter or list function)
- [ ] The `Project` type has a field for Notion page ID (check `lib/types.ts`)

## Execution Steps

### Step 0: Branch setup