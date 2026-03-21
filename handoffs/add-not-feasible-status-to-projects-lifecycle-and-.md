# Agent Forge -- Add 'Not Feasible' Status to Projects Lifecycle and Notion Integration

## Metadata
- **Branch:** `feat/not-feasible-status`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/projects.ts, lib/notion.ts, lib/pm-agent.ts, lib/inngest/pm-cycle.ts, lib/inngest/pipeline-oversight.ts (grep may reveal additional files)

## Context

Agent Forge manages projects through a lifecycle with terminal statuses (`Complete`, `Failed`). A new terminal status `Not Feasible` needs to be added to the project lifecycle logic and Notion integration. This status should behave identically to `Complete` and `Failed` — once a project reaches `Not Feasible`, no further transitions are allowed out of it.

**Important:** The `ProjectStatus` type is likely defined in `lib/types.ts` (the shared types file), not in `lib/projects.ts`. Terminal status checks may also appear in `lib/pm-agent.ts` (PM agent logic), `lib/inngest/pm-cycle.ts` (completion detection), `lib/inngest/pipeline-oversight.ts` (intent validation), and `lib/atc/health-monitor.ts`. A codebase-wide grep is required — do not assume the change is limited to two files.

**Note:** `lib/types.ts` is a high-churn file. Review your changes carefully for compatibility with existing consumers.

There are no new dependencies required. This is a purely additive change.

## Requirements

1. The `ProjectStatus` type (wherever defined — likely `lib/types.ts`) must include `'Not Feasible'` in its union.
2. `lib/projects.ts` must treat `'Not Feasible'` as a terminal status — no valid outbound transitions exist from it.
3. **Every file in the codebase** that checks for terminal project statuses must include `'Not Feasible'`. This includes but is not limited to: `lib/projects.ts`, `lib/pm-agent.ts`, `lib/inngest/pm-cycle.ts`, `lib/inngest/pipeline-oversight.ts`.
4. `lib/notion.ts` must accept and correctly pass `'Not Feasible'` as a status value when updating a Notion page's status property.
5. Any status allow-lists, type unions, or validation arrays in `lib/notion.ts` must include `'Not Feasible'`.
6. Existing transitions for `Complete` and `Failed` must remain unchanged.
7. TypeScript must compile without errors (`npx tsc --noEmit`).
8. Build must pass (`npm run build`).

## Execution Steps

### Step 0: Branch setup