# Agent Forge -- Add Wave Event Types and Emission Helpers

## Metadata
- **Branch:** `feat/wave-event-types-and-emission-helpers`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/events.ts, lib/atc/types.ts

## Context

Agent Forge uses a structured event log system (`lib/atc/events.ts`) to track work item lifecycle transitions across the pipeline. Existing helpers like `emitWorkItemDispatched`, `emitWorkItemStalled`, etc. follow a consistent pattern: each function constructs an event object with typed metadata and calls a shared `emitEvent` (or equivalent) function that appends to the rolling global log and per-item history.

A wave scheduler was recently implemented (`lib/wave-scheduler.ts`) and a `waveNumber` column was added to the work items schema. The next step is to wire observability into wave lifecycle events so the dashboard, supervisor, and health monitor can reason about wave progress.

This task adds three new event emission helpers to `lib/atc/events.ts` and a new `WaveDispatchState` interface to `lib/atc/types.ts`. No existing logic needs to change — this is purely additive.

**No file overlap with concurrent work:** The concurrent branch `fix/prd-54-ac-7-agent-bugfix-work-items-write-through-` touches `app/api/work-items/route.ts` and `lib/bugs.ts` — no overlap with `lib/atc/events.ts` or `lib/atc/types.ts`.

## Requirements

1. `lib/atc/events.ts` exports `emitWaveAssigned(projectId: string, waveNumber: number, itemIds: string[], totalWaves: number): void` (or `Promise<void>` if async, matching existing pattern)
2. `lib/atc/events.ts` exports `emitWaveDispatched(projectId: string, waveNumber: number, waveSize: number, concurrentDispatches: number): void` (or `Promise<void>`)
3. `lib/atc/events.ts` exports `emitWaveCompleted(projectId: string, waveNumber: number, successCount: number, failCount: number): void` (or `Promise<void>`)
4. Each emission function produces a well-structured event with all relevant wave metadata fields (`waveNumber`, `waveSize` where applicable, `projectId`)
5. Event type names for the three new events follow the existing naming convention (e.g. snake_case or the convention already used in the file)
6. `lib/atc/types.ts` exports `WaveDispatchState` interface with fields: `projectId: string`, `currentWave: number`, `waveSize: number`, `dispatchedAt: string`, `globalConcurrencyBudget: number`
7. `npx tsc --noEmit` passes with zero errors
8. `npm run build` succeeds

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-event-types-and-emission-helpers
```

### Step 1: Inspect existing event patterns in lib/atc/events.ts

Read the file carefully before making changes:

```bash
cat lib/atc/events.ts
```

Note:
- The shape of the `ATCEvent` (or equivalent) type — specifically the `type` field's union and the `metadata` / `data` / `payload` shape
- Whether emission helpers are `async` or synchronous
- How the event `type` discriminant strings are named (e.g. `"work_item_dispatched"`, `"stall_detected"`, etc.)
- Whether there is a union type for all event type strings that needs to be extended

Also inspect `lib/atc/types.ts` to understand existing interfaces and locate where to add `WaveDispatchState`:

```bash
cat lib/atc/types.ts
```

### Step 2: Extend the event type union (if applicable)

If `lib/atc/events.ts` (or `lib/atc/types.ts`) defines a discriminated union or string literal union for event types (e.g. `type ATCEventType = "work_item_dispatched" | "stall_detected" | ...`), add three new members:

```typescript
| "wave_assigned"
| "wave_dispatched"
| "wave_completed"
```

If event types are plain strings (no union), skip this step.

### Step 3: Add emission helpers to lib/atc/events.ts

Following the exact same pattern as existing helpers in the file, add the three new functions. The implementation below is a reference — **adapt signatures, async/sync, and event construction to match the existing patterns exactly**:

```typescript
// Emitted when wave scheduler assigns work items to waves for a project
export async function emitWaveAssigned(
  projectId: string,
  waveNumber: number,
  itemIds: string[],
  totalWaves: number
): Promise<void> {
  await emitEvent({
    type: "wave_assigned",
    // use the same timestamp / id / metadata shape as existing helpers
    metadata: {
      projectId,
      waveNumber,
      itemIds,
      totalWaves,
    },
  });
}

// Emitted when a wave begins executing (items dispatched to target repos)
export async function emitWaveDispatched(
  projectId: string,
  waveNumber: number,
  waveSize: number,
  concurrentDispatches: number
): Promise<void> {
  await emitEvent({
    type: "wave_dispatched",
    metadata: {
      projectId,
      waveNumber,
      waveSize,
      concurrentDispatches,
    },
  });
}

// Emitted when all items in a wave reach a terminal state
export async function emitWaveCompleted(
  projectId: string,
  waveNumber: number,
  successCount: number,
  failCount: number
): Promise<void> {
  await emitEvent({
    type: "wave_completed",
    metadata: {
      projectId,
      waveNumber,
      successCount,
      failCount,
    },
  });
}
```

**Important:** Mirror the exact call site structure of an existing emitter. If existing helpers pass `source`, `workItemId`, `timestamp`, `id`, or any other envelope fields, include them in the same way. Do not invent new patterns.

### Step 4: Add WaveDispatchState to lib/atc/types.ts

Locate a logical grouping (e.g. near other dispatch-related interfaces) and add:

```typescript
export interface WaveDispatchState {
  projectId: string;
  currentWave: number;
  waveSize: number;
  dispatchedAt: string; // ISO 8601 timestamp
  globalConcurrencyBudget: number;
}
```

### Step 5: Verification

```bash
# Type check — must pass with zero errors
npx tsc --noEmit

# Build — must succeed
npm run build

# Confirm exports are visible
node -e "
const e = require('./lib/atc/events');
const t = require('./lib/atc/types');
console.log('emitWaveAssigned:', typeof e.emitWaveAssigned);
console.log('emitWaveDispatched:', typeof e.emitWaveDispatched);
console.log('emitWaveCompleted:', typeof e.emitWaveCompleted);
" 2>/dev/null || echo "(TS-only exports confirmed via tsc)"
```

If `tsc` reports errors:
- Missing union members → add the new event type strings to any discriminated union
- Implicit `any` on metadata → cast to the existing metadata type or add a typed metadata interface matching the existing pattern
- Unknown property on event object → adjust the object shape to match the existing event envelope

### Step 6: Commit, push, open PR

```bash
git add lib/atc/events.ts lib/atc/types.ts
git commit -m "feat: add wave event types and emission helpers

- Add emitWaveAssigned, emitWaveDispatched, emitWaveCompleted to lib/atc/events.ts
- Add WaveDispatchState interface to lib/atc/types.ts
- Follows existing event emission patterns for consistency"

git push origin feat/wave-event-types-and-emission-helpers

gh pr create \
  --title "feat: add wave event types and emission helpers" \
  --body "## Summary
Extends the event log system to support wave lifecycle observability.

### Changes
- \`lib/atc/events.ts\`: Adds three new emission helpers — \`emitWaveAssigned\`, \`emitWaveDispatched\`, \`emitWaveCompleted\` — following existing emitter patterns
- \`lib/atc/types.ts\`: Adds \`WaveDispatchState\` interface used by the wave dispatcher

### Event types added
| Type | When emitted | Key metadata |
|------|-------------|--------------|
| \`wave_assigned\` | Wave scheduler computes waves for a project | projectId, waveNumber, itemIds, totalWaves |
| \`wave_dispatched\` | A wave begins executing | projectId, waveNumber, waveSize, concurrentDispatches |
| \`wave_completed\` | All items in a wave reach terminal state | projectId, waveNumber, successCount, failCount |

### No breaking changes
Purely additive. No existing logic modified.

### Acceptance Criteria
- [x] emitWaveAssigned exported from lib/atc/events.ts
- [x] emitWaveDispatched exported from lib/atc/events.ts
- [x] emitWaveCompleted exported from lib/atc/events.ts
- [x] WaveDispatchState interface exported from lib/atc/types.ts
- [x] Build passes, no type errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wave-event-types-and-emission-helpers
FILES CHANGED: [lib/atc/events.ts, lib/atc/types.ts — list only what was actually modified]
SUMMARY: [what was done]
ISSUES: [what failed — include tsc error output if applicable]
NEXT STEPS: [what remains — e.g. "extend ATCEventType union to include wave_assigned | wave_dispatched | wave_completed"]
```

If you encounter a blocker that cannot be resolved autonomously (e.g. the event system uses a pattern that is fundamentally incompatible with the described approach, or the event type union is auto-generated and cannot be manually extended), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-wave-event-types-and-emission-helpers",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/events.ts", "lib/atc/types.ts"]
    }
  }'
```