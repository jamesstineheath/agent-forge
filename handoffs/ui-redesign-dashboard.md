<!-- dispatch: feat/dashboard-redesign -->
# Agent Forge — Dashboard Redesign (Project-First Layout)

## Metadata
- **Branch:** `feat/dashboard-redesign`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Estimated files:** app/(app)/page.tsx, components/project-card.tsx, components/progress-bar.tsx, components/quick-stats.tsx, components/escalation-card.tsx
- **Dependencies:** None

## Context

The current dashboard (`app/(app)/page.tsx`) is oriented around infrastructure metrics: six stat cards (Total Work Items, Ready to Dispatch, Active Executions, Registered Repos, Blocked, ATC Status), a flat project list from Notion, escalations with raw API links, and a PipelineStatus component showing recent activity.

For a PM user, this layout doesn't answer the primary question: "What's the status of the things I care about, and is anything stuck?" The stat cards show counts without context. The project list shows complexity and status badges but no progress indication. Escalations link to `/api/escalations/{id}/resolve` which requires API knowledge. The PipelineStatus component at the bottom mixes merged wins with failures with no visual hierarchy.

This handoff restructures the dashboard to be project-first with progress visualization, a quick-stats strip, and human-friendly escalation cards.

## Design Reference

An interactive React mock was created in a Cowork session showing the target layout with:
- A compact quick-stats strip (4 cards: TLM quality rate, today's spend, active executions, waste %)
- "Needs attention" section with escalation cards that have action buttons ("Register repo", "Dismiss") instead of API links
- Project cards with segmented progress bars (done/running/failed/blocked) that expand to show work items
- Cost per project shown inline (spent/budget with color coding)
- "Merged today" section at bottom

## Requirements

1. **Replace the 6-card stat grid** with a compact 4-card quick-stats strip. Cards: (a) TLM quality rate (compute from work items: merged vs failed+reverted), (b) today's spend (sum handoff.budget for items that started today), (c) active executions count, (d) waste percentage (budget spent on failed items / total budget spent). Create `components/quick-stats.tsx`.

2. **Restructure projects section.** Each project gets a `ProjectCard` component (`components/project-card.tsx`) that:
   - Shows project name, status badge, and repo name
   - Includes a segmented `ProgressBar` (`components/progress-bar.tsx`) with colored segments: emerald for completed/merged, amber for executing, red for failed, orange for blocked
   - Shows counts below the bar: "1 done, 2 running, 1 failed, 6 blocked" with "1/12" on the right
   - Shows cost inline: "$14.20 / $60" with color coding (red >90%, amber >70%)
   - Cost is computed by summing `handoff.budget` for items in the project that have execution data
   - Is expandable (click to toggle) to show a list of work items with status icons, names, and contextual metadata (elapsed time for executing, PR number for reviewing, blocker name for blocked, error for failed, merge time for merged)
   - Has a red-tinted border when any child item has failed status
   - Work items within the expanded view should be computed by filtering `workItems` where `source.type === "project"` and `source.sourceId` matches the project ID

3. **Improve escalation cards.** Replace the current `<a href="/api/escalations/{id}/resolve">` link with an `EscalationCard` component (`components/escalation-card.tsx`) that:
   - Shows amber warning styling (amber border, amber-tinted background)
   - Displays a human-readable summary and detail text
   - Has action buttons: primary action (e.g., "Register repo") that calls POST to the resolve endpoint, and secondary "Dismiss" button
   - Shows project ID and relative time
   - The resolve action should call `fetch('/api/escalations/{id}/resolve', { method: 'POST' })` and mutate the escalations SWR cache

4. **Move escalations above projects** in the page layout, under a "Needs attention" header. These are action items and should be seen first.

5. **Keep the "Merged today" section** at the bottom. Filter work items where `execution.outcome === 'merged'` and `execution.completedAt` is today. Show with a green check icon, item name, repo, and time.

6. **Remove** the current PipelineStatus component import and the bottom action buttons (New Work Item, View Pipeline, Manage Repos). The sidebar already has these nav links.

7. **Add a SystemHealth strip** below the page title: a single line showing "ATC: healthy, last sweep {time} | Concurrency: {active}/{limit} on {repo} | {n} queued across all repos". Data from `useATCState()` and `useRepos()`.

## Execution Steps

### Step 0: Pre-flight checks and branch setup
- Read CLAUDE.md and docs/SYSTEM_MAP.md for project structure
- Create branch `feat/dashboard-redesign` from main
- Verify existing files: `app/(app)/page.tsx`, `components/pipeline-status.tsx`, `lib/hooks.ts`, `lib/types.ts`
- Run `npm run build` to verify clean baseline

### Step 1: Create ProgressBar component
- Create `components/progress-bar.tsx`
- Props: `{ total, completed, executing, failed, blocked }`
- Segmented horizontal bar with emerald/amber/red/orange colors
- Count labels below with color-coded text
- Handle `total === 0` case with "No work items yet" text

### Step 2: Create ProjectCard component
- Create `components/project-card.tsx`
- Props: `{ project: Project, workItems: WorkItem[], expanded: boolean, onToggle: () => void }`
- Compute progress counts from workItems array
- Compute cost from workItems with handoff data
- Expandable work item list with status-specific icons and metadata
- Red border when any work item has `status === 'failed'`

### Step 3: Create EscalationCard component
- Create `components/escalation-card.tsx`
- Props: `{ escalation: Escalation, workItemTitle?: string, onResolve: () => void, onDismiss: () => void }`
- Amber warning styling, action buttons
- Wire resolve to POST `/api/escalations/{id}/resolve`

### Step 4: Create QuickStats component
- Create `components/quick-stats.tsx`
- Props: `{ workItems: WorkItem[] }`
- Compute the four metrics from work item data
- 4-column grid of compact stat cards

### Step 5: Rewrite dashboard page
- Rewrite `app/(app)/page.tsx` using new components
- Layout order: title + SystemHealth strip, QuickStats, Needs Attention (escalations), Projects, Merged Today
- Remove PipelineStatus import and bottom action buttons
- Keep all existing SWR hooks (useWorkItems, useProjects, useEscalations, useATCState, useRepos)

### Step 6: Verify
- Run `npm run build` -- must pass with zero errors
- Run `npm run lint` -- must pass
- Verify the page renders with empty data (loading states) and with data

## Pre-flight Self-check
Before committing, verify:
- [ ] `npm run build` passes
- [ ] No TypeScript errors
- [ ] All imports resolve
- [ ] Existing hooks are reused, no new API endpoints needed
- [ ] ProjectCard correctly filters work items by project source
- [ ] EscalationCard resolve action uses POST method

## Session Abort Protocol
If blocked or exceeding budget:
1. Commit whatever compiles to the branch
2. Write a structured comment on the PR describing what's done and what remains
3. Exit with code 0
