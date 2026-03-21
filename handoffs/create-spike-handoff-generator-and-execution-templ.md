# Agent Forge -- Create Spike Handoff Generator and Execution Template

## Metadata
- **Branch:** `feat/spike-handoff-generator`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/spike-handoff.ts, handoffs/templates/spike-execution.md, lib/orchestrator.ts

## Context

Agent Forge already has spike work item support in the data layer (schema, types, CRUD) and a spike findings template/parser utility in `lib/spike-template.ts`. The next step is to close the loop on the execution side: when the Orchestrator dispatches a spike-type work item, it should generate a handoff file that instructs Claude Code to investigate a technical question and write findings — without touching production code.

Key existing files to understand before implementing:
- `lib/spike-template.ts` — exports the spike findings template structure and parser
- `lib/orchestrator.ts` — the main handoff generation + dispatch pipeline; needs a routing branch for `type === 'spike'`
- `lib/types.ts` — `WorkItem` type definition including `type` and `spikeMetadata` fields (added in recent PR)
- `lib/work-items.ts` — CRUD for work items, including spike fields

The spike handoff generator must produce a self-contained handoff string that:
1. Directs Claude Code to create `spikes/` directory if absent
2. Uses the spike template from `lib/spike-template.ts` as the output format
3. Commits findings to `spikes/<work-item-id>.md`
4. Explicitly prohibits touching any production code

## Pre-flight Checks

Before starting implementation, verify these conditions. **Abort if any fail.**

1. **Concurrent modification on `lib/orchestrator.ts`**: An active work item ("Remove status-tracking commits to main from Health Monitor and Orchestrator", branch `feat/remove-status-tracking-commits-to-main-from-health`) is currently modifying `lib/orchestrator.ts`. Before proceeding:
   - Check if that branch's PR has been merged: `gh pr list --search "remove-status-tracking-commits-to-main-from-health" --state all`
   - If still open/executing, pull latest `main` and check that `lib/orchestrator.ts` is stable. If it was recently modified (within last few hours), proceed with caution — your changes should be a minimal addition (one import + one early-return guard), which is unlikely to conflict.

2. **`lib/spike-template.ts` exists and exports what we need**:
   ```bash
   cat lib/spike-template.ts
   ```
   If this file doesn't exist or doesn't export a template string/function, **ABORT** and escalate.

3. **`WorkItem` type includes spike-related fields**:
   ```bash
   grep -A 5 'spikeMetadata\|type.*spike' lib/types.ts lib/db/schema.ts
   ```
   If `spikeMetadata` or a spike `type` discriminator doesn't exist on `WorkItem`, **ABORT** and escalate.

## Requirements

1. `lib/spike-handoff.ts` exports a `generateSpikeHandoff(workItem: WorkItem): string` function that returns a complete handoff markdown string for spike-type work items
2. The generated handoff includes the spike template structure (sourced from `lib/spike-template.ts`) so the executing agent knows exactly what to fill in
3. The generated handoff explicitly instructs the agent NOT to modify production code files (only write to `spikes/` directory)
4. The generated handoff directs the agent to: create `spikes/` if missing, investigate the technical question from `workItem.spikeMetadata`, fill the template, commit to `spikes/<workItem.id>.md`
5. `lib/orchestrator.ts` detects `workItem.type === 'spike'` and routes to `generateSpikeHandoff()` instead of the normal handoff generation path
6. `handoffs/templates/spike-execution.md` exists and documents the spike execution protocol (what spike handoffs do, what agents must/must not do, output format)
7. TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup