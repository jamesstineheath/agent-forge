# Agent Forge -- Dashboard UI

## Metadata
- **Branch:** `feat/dashboard`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $10
- **Risk Level:** low
- **Estimated files:** app/(app)/page.tsx, app/(app)/work-items/page.tsx, app/(app)/work-items/[id]/page.tsx, app/(app)/pipeline/page.tsx, app/(app)/repos/page.tsx, app/(app)/repos/new/page.tsx, components/work-item-card.tsx, components/dispatch-button.tsx, components/pipeline-status.tsx, components/repo-form.tsx, lib/hooks.ts

## Context

Agent Forge needs a functional dashboard for humans to manage work items, dispatch execution, monitor the pipeline, and register repos. This is the primary interface for Phase 2a: human-dispatched orchestration.

This handoff depends on both the work item store (01) and orchestrator (02) being merged first. It builds the UI layer on top of those APIs.

## Requirements

1. Dashboard home page with summary stats (total work items by status, active executions, registered repos)
2. Work items list page with filtering (status, priority, target repo) and a button to create new items
3. Work item detail page showing full item data, handoff content (if generated), execution status, and a dispatch button
4. Pipeline page showing active and recent executions with live status
5. Repos management page listing registered repos with an "add repo" form
6. Reusable components: WorkItemCard, DispatchButton, PipelineStatus, RepoForm
7. Client-side data fetching with SWR (or simple fetch + useState) for polling execution status
8. All pages use shadcn/ui components for consistent styling
9. TypeScript compiles with zero errors

## Execution Steps

### Step 0: Branch setup

```bash
git checkout main && git pull
git checkout -b feat/dashboard
```

Verify `lib/work-items.ts`, `lib/repos.ts`, and `lib/orchestrator.ts` exist (from previous handoffs).

### Step 1: Install SWR

```bash
npm install swr
```

### Step 2: Create data fetching hooks

Create `lib/hooks.ts`:

```typescript
// useWorkItems(filters?) -- fetches /api/work-items with query params, returns { data, error, isLoading, mutate }
// useWorkItem(id) -- fetches /api/work-items/[id]
// useRepos() -- fetches /api/repos
// usePipelineStatus() -- fetches /api/orchestrator/status, refreshInterval: 10000 (poll every 10s)
```

Use SWR for all hooks. Export typed return values matching the API response shapes from `lib/types.ts`.

### Step 3: Reusable components

Create `components/work-item-card.tsx`:
- Displays: title, target repo, status badge, priority badge, complexity badge
- Status badge colors: filed=gray, ready=blue, generating=yellow, executing=amber, reviewing=purple, merged=green, failed=red, parked=slate
- Priority badge: high=red, medium=yellow, low=gray
- Click navigates to `/work-items/[id]`
- Uses shadcn Card, Badge components

Create `components/dispatch-button.tsx`:
- Button that calls POST `/api/orchestrator/dispatch` with `{ workItemId }`
- Shows loading spinner during dispatch
- Disabled unless work item status is "ready"
- On success: show success toast, trigger SWR revalidation
- On failure: show error message
- Uses shadcn Button component

Create `components/pipeline-status.tsx`:
- Displays a list of recent dispatches (from `/api/orchestrator/status`)
- Each row: work item title, target repo, status, started time, elapsed time
- Active items (generating, executing, reviewing) show a pulsing dot indicator
- Uses shadcn Card, Badge, Separator components

Create `components/repo-form.tsx`:
- Form for creating/editing a repo config
- Fields: fullName (e.g. "owner/repo"), shortName, claudeMdPath (default "CLAUDE.md"), systemMapPath (optional), adrPath (optional), handoffDir (default "handoffs/"), executeWorkflow (default "execute-handoff.yml"), concurrencyLimit (default 1), defaultBudget (default 5)
- Submit calls POST `/api/repos` (create) or PATCH `/api/repos/[id]` (edit)
- Uses shadcn Input, Button, Card components

### Step 4: Dashboard home page

Update `app/(app)/page.tsx`:
- Hero section: "Agent Forge" heading with brief tagline
- Stats row (4 cards): Total Work Items, Ready to Dispatch, Active Executions, Registered Repos
- Stats fetched from `/api/work-items` (count by status) and `/api/repos` (count)
- Below stats: PipelineStatus component showing recent activity
- Quick action buttons: "New Work Item", "View Pipeline", "Manage Repos"

### Step 5: Work items list page

Update `app/(app)/work-items/page.tsx`:
- Header with "Work Items" title and "New Work Item" button
- Filter bar: status dropdown, priority dropdown, target repo dropdown (populated from repos list)
- Grid of WorkItemCard components
- Empty state if no items match filters
- "New Work Item" button opens a modal or navigates to a creation form
- Creation form: title, description, targetRepo (dropdown from repos), source type, priority, riskLevel, complexity
- Submit calls POST `/api/work-items`

### Step 6: Work item detail page

Create `app/(app)/work-items/[id]/page.tsx`:
- Header: work item title with status badge
- Metadata section: target repo, priority, risk, complexity, created date
- Description section (markdown-rendered if possible, plain text otherwise)
- Handoff section (if handoff exists): shows generated handoff content in a code block, branch name, generated timestamp
- Execution section (if execution exists): PR link, workflow status, started/completed timestamps, outcome
- Action bar: DispatchButton (if status is "ready"), "Edit" button, "Delete" button (with confirmation)
- Status timeline: visual representation of the item's lifecycle (filed -> ready -> generating -> executing -> reviewing -> merged)

### Step 7: Pipeline page

Update `app/(app)/pipeline/page.tsx`:
- Header: "Pipeline" with subtitle showing active execution count
- Two sections: "Active Executions" and "Recent Completions"
- Active section: cards for items in generating/executing/reviewing status, with live polling (10s interval)
- Each active card shows: title, repo, status, elapsed time, link to PR if available
- Recent section: last 20 completed items (merged/failed/parked) with outcome badge and completion time
- Auto-refreshes via SWR

### Step 8: Repos management page

Update `app/(app)/repos/page.tsx`:
- Header: "Registered Repos" with "Add Repo" button
- Grid of repo cards showing: fullName, shortName, concurrency limit, default budget, handoff dir
- Each card has "Edit" and "Delete" actions
- "Add Repo" navigates to `/repos/new`

Create `app/(app)/repos/new/page.tsx`:
- RepoForm component for creating a new repo
- On success: redirect to `/repos`

### Step 9: Verification

```bash
npx tsc --noEmit      # zero errors
npm run build          # succeeds
```

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "feat: dashboard UI for work items, pipeline, and repos

Adds the web interface for Agent Forge:
- Dashboard home with summary stats and pipeline activity
- Work items list with filtering + detail view with dispatch
- Pipeline monitoring with live status polling
- Repo management with add/edit forms
- Reusable components: WorkItemCard, DispatchButton, PipelineStatus, RepoForm
- SWR-based data fetching with auto-refresh"
git push origin feat/dashboard
gh pr create --title "feat: dashboard UI" --body "## Summary
Web interface for managing work items, dispatching execution, monitoring the pipeline, and registering repos.

## Files Changed
- app/(app)/page.tsx (dashboard home)
- app/(app)/work-items/page.tsx (work item list + create)
- app/(app)/work-items/[id]/page.tsx (work item detail + dispatch)
- app/(app)/pipeline/page.tsx (pipeline monitoring)
- app/(app)/repos/page.tsx (repo list)
- app/(app)/repos/new/page.tsx (add repo form)
- components/work-item-card.tsx
- components/dispatch-button.tsx
- components/pipeline-status.tsx
- components/repo-form.tsx
- lib/hooks.ts (SWR data fetching)

## Verification
- tsc --noEmit: pass
- npm run build: pass

## Risk
Low. New UI files only, no existing code modified. Consumes existing API routes.

## Dependencies
Requires 01-work-item-store and 02-orchestrator to be merged first."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```
