# Agent Forge — Agents Page (Performance & Cost Monitoring)

## Metadata
- **Branch:** `feat/agents-page`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $10
- **Risk Level:** medium
- **Estimated files:** app/(app)/agents/page.tsx, app/api/agents/tlm-memory/route.ts, components/tlm-agent-card.tsx, components/pa-agent-row.tsx, components/cost-summary.tsx, components/quality-ring.tsx, components/sidebar.tsx, lib/hooks.ts, lib/types.ts
- **Dependencies:** None (can run in parallel with dashboard redesign)

## Context

Agent Forge has a three-layer evaluation framework (ADR-007): Action Ledger for logging consequential actions, Outcome Assessment for classifying results, and Agent Memory for per-agent learning. TLM agents (Code Reviewer, Spec Reviewer, Outcome Tracker) maintain shared memory in `docs/tlm-memory.md` with stats (total assessed, correct, caused_issues, reversed, missed), hot patterns, and lessons learned. PA agents have evaluation infrastructure in `lib/agents/evaluation/` in the personal-assistant repo with Action Ledger entries in Vercel Blob.

The Feedback Compiler (ADR-009) is in the pipeline as a fourth TLM agent that will analyze outcome patterns and propose prompt changes via PR.

Currently, none of this performance or cost data is surfaced in the Agent Forge UI. Work items have a `handoff.budget` field tracking the dollar budget per execution. There is no dedicated page for monitoring agent quality, cost efficiency, or the self-improvement loop.

## Requirements

### New API endpoint: GET /api/agents/tlm-memory

1. Create `app/api/agents/tlm-memory/route.ts` that:
   - Reads `docs/tlm-memory.md` from the agent-forge repo via GitHub API (using `GH_PAT` env var already available)
   - Parses the markdown to extract: Hot Patterns array, Recent Outcomes table, Lessons Learned array, Stats object
   - Returns structured JSON: `{ hotPatterns: [{date, pattern}], recentOutcomes: [{date, action, entity, outcome, notes}], lessonsLearned: [{date, lesson}], stats: {totalAssessed, correct, reversed, causedIssues, missed, lastAssessment} }`
   - Authenticated via session (same as other app routes)
   - Cache for 5 minutes (revalidate: 300) since memory file changes infrequently

### New SWR hook

2. Add `useTLMMemory()` hook to `lib/hooks.ts` that fetches `/api/agents/tlm-memory` with 60s refresh interval.

### New types

3. Add to `lib/types.ts`:
   - `TLMMemoryStats` with fields: totalAssessed, correct, reversed, causedIssues, missed, lastAssessment (string)
   - `TLMHotPattern` with fields: date, pattern
   - `TLMOutcome` with fields: date, action, entity, outcome, notes
   - `TLMLesson` with fields: date, lesson
   - `TLMMemory` combining all of the above

### Components

4. **QualityRing** (`components/quality-ring.tsx`): SVG circular progress indicator. Props: `{ rate: number | null, size?: number }`. Green >=80%, amber >=60%, red <60%, gray for null. Shows percentage text below.

5. **TLMAgentCard** (`components/tlm-agent-card.tsx`): Expandable card for each TLM agent. Props: `{ name, stats, hotPatterns, recentOutcomes, successRate, lastRun, status }`. Shows QualityRing, name, status badge, stats summary. Expands to show hot patterns (amber warning icons) and recent actions with outcome icons (green check for correct, red X for caused_issues, gray clock for premature).

6. **CostSummary** (`components/cost-summary.tsx`): Cost overview panel. Props: `{ workItems: WorkItem[] }`. Computes from work item data:
   - Today's spend: sum `handoff.budget` for items with `execution.startedAt` today
   - This week's spend: same for last 7 days
   - Average cost per item
   - Budget utilization bar
   - Waste callout: budget spent on items where `status === 'failed'` or `execution.outcome === 'failed'`
   - Per-repo breakdown

7. **PAAgentRow** (`components/pa-agent-row.tsx`): Compact row for PA agents. For now, shows placeholder data since PA evaluation data lives in the personal-assistant Blob store. Props: `{ name, tier, assessmentTier, status }`. Shows QualityRing (null for now), name, tier badge, assessment cadence, last run. Include a note that PA agent metrics will be available when the cross-repo evaluation API ships.

### Page

8. Create `app/(app)/agents/page.tsx` with sections:
   - **Cost overview** at top (CostSummary component)
   - **TLM Agents** section: render one TLMAgentCard per agent. For Code Reviewer, stats come from TLM memory API. Spec Reviewer and Outcome Tracker get synthetic stats derived from the same memory file (Spec Reviewer: items where spec-reviewed handoffs didn't lead to caused_issues; Outcome Tracker: always 100% since it classifies, doesn't decide). Feedback Compiler shows as "in pipeline" with null stats.
   - **PA Agents** section: render PAAgentRow for each known PA agent type (inbox-triage, calendar-triage, realestate-scout, funding-scanner, family-sync, gift-concierge, kids-activities, date-planner). All show placeholder metrics with a note about cross-repo API.
   - **Self-improvement loop** section at bottom: card explaining Feedback Compiler status and the observation-to-adaptation loop.

### Sidebar update

9. Add "Agents" nav item to `components/sidebar.tsx` between "Work Items" and "Pipeline". href: `/agents`.

## Execution Steps

### Step 0: Pre-flight checks and branch setup
- Read CLAUDE.md and docs/SYSTEM_MAP.md
- Create branch `feat/agents-page` from main
- Verify: `lib/types.ts`, `lib/hooks.ts`, `components/sidebar.tsx`, `app/api/` structure
- Run `npm run build` to verify clean baseline

### Step 1: Add types
- Add TLMMemory types to `lib/types.ts`

### Step 2: Create TLM memory API
- Create `app/api/agents/tlm-memory/route.ts`
- Use GitHub API to fetch `docs/tlm-memory.md` contents (use `GH_PAT` from env)
- Parse markdown sections (Hot Patterns, Recent Outcomes table, Lessons Learned, Stats)
- Return structured JSON
- Handle errors gracefully (repo not accessible, file missing)

### Step 3: Add SWR hook
- Add `useTLMMemory()` to `lib/hooks.ts`

### Step 4: Create UI components
- Create `components/quality-ring.tsx`
- Create `components/tlm-agent-card.tsx`
- Create `components/cost-summary.tsx`
- Create `components/pa-agent-row.tsx`

### Step 5: Create Agents page
- Create `app/(app)/agents/page.tsx`
- Wire up all components with data from hooks
- Handle loading states

### Step 6: Update sidebar
- Add "Agents" to navItems in `components/sidebar.tsx`

### Step 7: Verify
- Run `npm run build` -- must pass
- Run `npm run lint` -- must pass
- Verify page renders with loading states and with data

## Pre-flight Self-check
- [ ] `npm run build` passes
- [ ] No TypeScript errors
- [ ] TLM memory API parses the actual format in docs/tlm-memory.md
- [ ] CostSummary computes from real work item data
- [ ] Sidebar shows Agents link
- [ ] Page handles case where TLM memory API returns error

## Session Abort Protocol
If blocked or exceeding budget:
1. Commit whatever compiles to the branch
2. Write a structured comment on the PR describing what's done and what remains
3. Exit with code 0
