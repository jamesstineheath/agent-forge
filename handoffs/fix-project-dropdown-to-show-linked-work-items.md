<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix Project Dropdown to Show Linked Work Items

## Metadata
- **Branch:** `feat/fix-project-dropdown-linked-work-items`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** TBD after diagnosis (likely 1-3 files in app/(app)/, lib/hooks.ts, or components/)

## Context

The project dropdown in the Agent Forge dashboard is not showing linked work items. PR #139 attempted to fix this but was closed due to merge conflicts. This task re-implements the fix from scratch against current main.

Key patterns in this repo:
- React data fetching is done via SWR hooks defined in `lib/hooks.ts`
- Work item storage uses Vercel Blob (`lib/work-items.ts`, `lib/storage.ts`) — all filtering is client-side
- The dashboard uses Next.js App Router (`app/(app)/`)
- Types are defined in `lib/types.ts` (WorkItem has a `projectId` field linking it to a project)
- UI components are shadcn/ui in `components/ui/`

## Requirements

1. Identify the project dropdown component and the code path responsible for filtering/displaying linked work items.
2. Fix the bug so that selecting a project in the dropdown correctly shows all work items linked to that project.
3. Ensure the fix works for the pipeline view, dashboard, and any other view that uses the project dropdown filter.
4. Do not break existing functionality (work items with no project, the "all projects" / unfiltered view, etc.).
5. The fix must compile with zero TypeScript errors (`npx tsc --noEmit`).
6. The fix must not introduce new lint or build errors (`npm run build`).

## Execution Steps

### Step 0: Branch setup