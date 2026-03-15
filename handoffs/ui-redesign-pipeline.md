# Agent Forge — Pipeline Page Redesign (Stage Summary)

## Metadata
- **Branch:** `feat/pipeline-redesign`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $6
- **Risk Level:** low
- **Estimated files:** app/(app)/pipeline/page.tsx, components/pipeline-stages.tsx, components/blocked-summary.tsx
- **Dependencies:** None (can run in parallel with other UI redesign handoffs)

## Context

The current pipeline page (`app/(app)/pipeline/page.tsx`) has three sections: Active Executions (with concurrency gauges), Queue (flat list), and Event Timeline (ATCEventLog component). The Event Timeline is the biggest usability problem: with 26 queued items, the ATC logs 50+ nearly identical dependency_block events every sweep cycle. Each event shows a truncated work item UUID (e.g., "e58f42bb") that requires clicking through to understand. The same messages repeat every few minutes as the ATC re-evaluates.

For a PM user, the event log is noise. What matters is: how many items are in each stage, what's the bottleneck, and what happens next.

## Requirements

1. **Add a PipelineStages component** (`components/pipeline-stages.tsx`) at the top of the page that shows a 6-column stage summary:
   - Queued: count of items with status `ready` or `queued`
   - Executing: count with status `generating` or `executing`
   - Reviewing: count with status `reviewing`
   - Blocked: count with status `blocked`
   - Merged today: count with `execution.outcome === 'merged'` and `execution.completedAt` today
   - Failed: count with status `failed`
   - Each column shows: large number, label, colored bar segment
   - Below the columns, show a detail panel for each non-empty stage listing the item titles (not UUIDs)

2. **Add a BlockedSummary component** (`components/blocked-summary.tsx`) that provides a plain-language explanation of the bottleneck:
   - Analyze blocked items and their dependencies
   - Identify the root blocker(s): items that are blocking the most downstream items
   - Generate a sentence like: "Most items are waiting on '{title}' (currently {status}, {elapsed} elapsed). Once that completes, {n} items will unblock immediately."
   - If there are independent dependency chains, mention them: "The {project} chain is independently blocked on '{title}' which is {status}."
   - Data source: work items with `status === 'blocked'` and their `dependencies` array, cross-referenced with other work items to resolve dependency titles and statuses

3. **Collapse the Event Timeline by default.** Keep the ATCEventLog component but wrap it in a collapsible section that's closed by default. Label: "Event Log ({n} events)" with a toggle. This preserves the raw data for debugging without overwhelming the primary view.

4. **Keep Active Executions and Queue sections** as they are. They already show useful information (concurrency gauges, execution cards, priority-ordered queue).

5. **Reorder sections:** PipelineStages (new) > BlockedSummary (new) > Active Executions (existing) > Queue (existing) > Event Log (existing, collapsed).

## Execution Steps

### Step 0: Pre-flight checks and branch setup
- Read CLAUDE.md and docs/SYSTEM_MAP.md
- Create branch `feat/pipeline-redesign` from main
- Verify: `app/(app)/pipeline/page.tsx`, `components/atc-event-log.tsx`, `lib/hooks.ts`, `lib/types.ts`
- Run `npm run build` to verify clean baseline

### Step 1: Create PipelineStages component
- Create `components/pipeline-stages.tsx`
- Props: `{ workItems: WorkItem[] }`
- Compute counts per stage from work item statuses
- Render 6-column grid with counts, labels, color bars
- Render detail panels below listing item titles per stage

### Step 2: Create BlockedSummary component
- Create `components/blocked-summary.tsx`
- Props: `{ workItems: WorkItem[] }`
- Filter blocked items, resolve their dependency titles
- Find root blockers (items that appear most in dependency chains)
- Generate plain-language summary text
- Render in an orange-tinted card

### Step 3: Update pipeline page
- Edit `app/(app)/pipeline/page.tsx`
- Add PipelineStages at top
- Add BlockedSummary below it
- Wrap Event Timeline in a collapsible section (useState toggle, closed by default)
- Keep Active Executions and Queue sections unchanged

### Step 4: Verify
- Run `npm run build` -- must pass
- Run `npm run lint` -- must pass
- Verify page renders correctly with empty data and with data

## Pre-flight Self-check
- [ ] `npm run build` passes
- [ ] No TypeScript errors
- [ ] BlockedSummary correctly resolves dependency IDs to work item titles
- [ ] Event Timeline is collapsed by default but expandable
- [ ] PipelineStages counts match existing pipeline header counts

## Session Abort Protocol
If blocked or exceeding budget:
1. Commit whatever compiles to the branch
2. Write a structured comment on the PR describing what's done and what remains
3. Exit with code 0
