<!-- dispatch: feat/pipeline-redesign -->
# Agent Forge — Pipeline Page Redesign (Stage Summary)

## Metadata
- **Branch:** `feat/pipeline-redesign`
- **Priority:** medium
- **Model:** opus
- **Type:** feature
- **Max Budget:** $6
- **Risk Level:** medium
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
   - Merged today: count of items whose status is `merged` and whose completion timestamp falls within the current UTC day. **Check `lib/types.ts` for the actual field names** -- the spec assumes `execution.outcome` and `execution.completedAt` but adapt to whatever the `WorkItem` type actually uses.
   - Failed: count with status `failed`
   - Each column shows: large number, label, colored bar segment (use Tailwind bg colors consistent with existing status colors in the codebase)
   - Below the columns, render a detail panel for each non-empty stage listing the item titles (not UUIDs)

2. **Add a BlockedSummary component** (`components/blocked-summary.tsx`) that provides a plain-language explanation of the bottleneck:
   - Analyze blocked items and their `dependencies` array
   - Identify the root blocker(s): items that appear most frequently in dependency arrays of blocked items
   - Generate a sentence like: "Most items are waiting on '{title}' (currently {status}, {elapsed} elapsed). Once that completes, {n} items will unblock immediately."
   - If there are independent dependency chains, mention them: "The {project} chain is independently blocked on '{title}' which is {status}."
   - Data source: work items with `status === 'blocked'` and their `dependencies` array, cross-referenced with other work items to resolve dependency titles and statuses
   - **Edge cases:**
     - If no items are blocked, render nothing (return `null`)
     - If a dependency ID cannot be resolved to a work item (e.g., deleted or missing), show the truncated ID with "(unknown)" instead of crashing
     - If all blocked items share the same single blocker, simplify to one sentence

3. **Collapse the Event Timeline by default.** Keep the ATCEventLog component but wrap it in a collapsible section that's closed by default. Label: "Event Log ({n} events)" with a toggle button. This preserves the raw data for debugging without overwhelming the primary view.

4. **Keep Active Executions and Queue sections** as they are. They already show useful information (concurrency gauges, execution cards, priority-ordered queue). Do not modify their code.

5. **Reorder sections:** PipelineStages (new) > BlockedSummary (new) > Active Executions (existing) > Queue (existing) > Event Log (existing, collapsed).

## Execution Steps

### Step 0: Pre-flight checks and branch setup
- Read `CLAUDE.md` and `docs/SYSTEM_MAP.md`
- Create branch `feat/pipeline-redesign` from main
- Run `npm run build` to verify clean baseline
- **Read these files to understand current patterns before writing any code:**
  - `app/(app)/pipeline/page.tsx` -- understand how work items are fetched and passed to child components
  - `components/atc-event-log.tsx` -- understand the event log component interface
  - `lib/types.ts` -- confirm `WorkItem` type shape, especially status enum values, dependency fields, and execution/completion fields
  - `lib/hooks.ts` -- identify existing data-fetching hooks (e.g., `useWorkItems`, `useATCState`)
  - Look at 1-2 other existing components in `components/` to match styling conventions (Tailwind patterns, card structure, etc.)

### Step 1: Create PipelineStages component
- Create `components/pipeline-stages.tsx`
- Props: `{ workItems: WorkItem[] }` (use the same `WorkItem` type used by the pipeline page)
- Compute counts per stage from work item statuses using the actual status values found in `lib/types.ts`
- Render 6-column responsive grid (collapse to 3x2 on mobile) with counts, labels, color bars
- Render expandable detail panels below listing item titles per non-empty stage
- Use existing Tailwind/styling patterns from the codebase

### Step 2: Create BlockedSummary component
- Create `components/blocked-summary.tsx`
- Props: `{ workItems: WorkItem[] }` (needs all items, not just blocked ones, to resolve dependency titles)
- Filter blocked items, resolve their dependency IDs to titles by looking up in the full work items array
- Find root blockers (items that appear most frequently in dependency arrays of blocked items)
- Generate plain-language summary text
- Render in a warning-styled card (amber/orange tint)
- Return `null` if no items are blocked

### Step 3: Update pipeline page
- Edit `app/(app)/pipeline/page.tsx`
- Import and add PipelineStages at top, passing work items from whatever data source the page already uses
- Import and add BlockedSummary below it, passing the same work items
- Wrap the existing ATCEventLog in a collapsible section using `useState` (closed by default). Include event count in the header label.
- Keep Active Executions and Queue sections unchanged -- do not modify their code
- Reorder sections per Requirement 5

### Step 4: Verify
- Run `npm run build` -- must pass with zero errors
- Run `npm run lint` -- must pass
- Manually review the rendered output mentally or via build output:
  - PipelineStages shows correct stage groupings
  - BlockedSummary handles both "items blocked" and "no items blocked" cases
  - Event Timeline is collapsed by default but the toggle opens it
  - Active Executions and Queue sections are unchanged

## Pre-flight Self-check
- [ ] `npm run build` passes
- [ ] No TypeScript errors
- [ ] BlockedSummary correctly resolves dependency IDs to work item titles (with fallback for unresolvable IDs)
- [ ] BlockedSummary returns null when no items are blocked
- [ ] Event Timeline is collapsed by default but expandable via toggle
- [ ] PipelineStages counts are derived from actual `WorkItem` status values in `lib/types.ts`
- [ ] No modifications to Active Executions or Queue section code

## Session Abort Protocol
If blocked or exceeding budget:
1. Commit whatever compiles to the branch
2. Write a structured comment on the PR describing what's done and what remains
3. Exit with code 0
