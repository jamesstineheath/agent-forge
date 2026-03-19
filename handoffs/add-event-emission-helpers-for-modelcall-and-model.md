# Agent Forge -- Add event emission helpers for model_call and model_escalation

## Metadata
- **Branch:** `feat/model-event-emission-helpers`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/events.ts, lib/atc/types.ts (read-only)

## Context

Agent Forge uses a durable event log infrastructure (`lib/atc/events.ts`) that writes to Vercel Blob with hourly partitions and a rolling log. The event bus is a core part of the autonomous agent architecture introduced in ADR-010.

The system already has event types for GitHub webhooks (`lib/event-bus-types.ts`) and ATC-specific events (`lib/atc/events.ts`). The goal of this task is to extend `lib/atc/events.ts` with helper functions for emitting and querying `model_call` and `model_escalation` events — two event types that already exist (or need to exist) in `lib/atc/types.ts`.

These helpers will power future analytics (cost tracking, escalation rate monitoring, prompt quality feedback loops) without requiring callers to know the internal event log structure.

**No overlap with concurrent work:** The concurrent branch `fix/create-episode-detail-page-episodesid` only touches `app/episodes/[id]/page.tsx`, which is completely separate from `lib/atc/events.ts`.

## Requirements

1. `emitModelCallEvent(event: Omit<ModelCallEvent, 'eventType' | 'timestamp'>): Promise<void>` is exported from `lib/atc/events.ts` and appends a fully-typed `ModelCallEvent` (with `eventType: 'model_call'` and `timestamp: new Date().toISOString()`) to the existing event log.
2. `emitModelEscalationEvent(event: Omit<ModelEscalationEvent, 'eventType' | 'timestamp'>): Promise<void>` is exported and appends a fully-typed `ModelEscalationEvent` (with `eventType: 'model_escalation'` and `timestamp: new Date().toISOString()`).
3. `queryModelCallEvents(filter: { startDate?: string; endDate?: string; taskType?: TaskType; model?: string; }): Promise<ModelCallEvent[]>` is exported and returns events filtered by the provided criteria.
4. `queryModelEscalationEvents(filter: { startDate?: string; endDate?: string; taskType?: TaskType; }): Promise<ModelEscalationEvent[]>` is exported and returns events filtered by the provided criteria.
5. `ModelCallEvent` and `ModelEscalationEvent` are imported from `lib/atc/types.ts`. If they don't exist there yet, define them in `lib/atc/types.ts` with appropriate fields.
6. Project compiles without errors: `npx tsc --noEmit` and `npm run build` both pass.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/model-event-emission-helpers
```

### Step 1: Inspect existing types and event infrastructure

Read the relevant files to understand the existing shape before writing any code:

```bash
cat lib/atc/types.ts
cat lib/atc/events.ts
cat lib/event-bus-types.ts
```

Pay close attention to:
- Whether `ModelCallEvent` and `ModelEscalationEvent` already exist in `lib/atc/types.ts`
- The `TaskType` type (it may be a union string literal type or an enum)
- The existing `appendEvent` / `appendToEventLog` function signature in `lib/atc/events.ts`
- The existing query helpers (e.g., how they read Blob partitions and filter)

### Step 2: Add ModelCallEvent and ModelEscalationEvent to lib/atc/types.ts (if missing)

If `ModelCallEvent` and/or `ModelEscalationEvent` do not already exist in `lib/atc/types.ts`, add them. Use the existing event type patterns in the file as a guide.

Typical shape (adjust field names to match existing conventions):

```typescript
export interface ModelCallEvent {
  eventType: 'model_call';
  timestamp: string;           // ISO 8601
  workItemId?: string;
  taskType: TaskType;
  model: string;               // e.g. 'claude-opus-4-5', 'claude-sonnet-4-5'
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  success: boolean;
  error?: string;
}

export interface ModelEscalationEvent {
  eventType: 'model_escalation';
  timestamp: string;           // ISO 8601
  workItemId?: string;
  taskType: TaskType;
  reason: string;
  confidenceScore?: number;
  step?: string;
}
```

Also ensure the discriminated union of all ATC event types (if one exists) includes `ModelCallEvent | ModelEscalationEvent`.

### Step 3: Add emit and query helpers to lib/atc/events.ts

At the bottom of `lib/atc/events.ts`, after the existing helpers, add the following (adapt to match existing import paths and internal function names):

```typescript
import type { ModelCallEvent, ModelEscalationEvent, TaskType } from './types';

// ── Emit helpers ──────────────────────────────────────────────────────────────

export async function emitModelCallEvent(
  event: Omit<ModelCallEvent, 'eventType' | 'timestamp'>
): Promise<void> {
  const fullEvent: ModelCallEvent = {
    ...event,
    eventType: 'model_call',
    timestamp: new Date().toISOString(),
  };
  await appendEvent(fullEvent); // use whatever the internal append function is called
}

export async function emitModelEscalationEvent(
  event: Omit<ModelEscalationEvent, 'eventType' | 'timestamp'>
): Promise<void> {
  const fullEvent: ModelEscalationEvent = {
    ...event,
    eventType: 'model_escalation',
    timestamp: new Date().toISOString(),
  };
  await appendEvent(fullEvent);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function queryModelCallEvents(filter: {
  startDate?: string;
  endDate?: string;
  taskType?: TaskType;
  model?: string;
}): Promise<ModelCallEvent[]> {
  // Use the existing query mechanism (e.g. queryEvents or readEventPartitions).
  // Filter by eventType first, then apply optional field filters.
  const allEvents = await queryEvents({ // adapt to the real function name
    startDate: filter.startDate,
    endDate: filter.endDate,
  });
  return allEvents.filter((e): e is ModelCallEvent => {
    if (e.eventType !== 'model_call') return false;
    if (filter.taskType && e.taskType !== filter.taskType) return false;
    if (filter.model && e.model !== filter.model) return false;
    return true;
  });
}

export async function queryModelEscalationEvents(filter: {
  startDate?: string;
  endDate?: string;
  taskType?: TaskType;
}): Promise<ModelEscalationEvent[]> {
  const allEvents = await queryEvents({
    startDate: filter.startDate,
    endDate: filter.endDate,
  });
  return allEvents.filter((e): e is ModelEscalationEvent => {
    if (e.eventType !== 'model_escalation') return false;
    if (filter.taskType && e.taskType !== filter.taskType) return false;
    return true;
  });
}
```

**Important:** The pseudo-code above uses `appendEvent` and `queryEvents` as placeholder names. Replace them with whatever the actual internal functions are called after reading the file in Step 1. Do not change the signatures of existing functions.

### Step 4: Verify the existing event type union includes the new types

In `lib/atc/types.ts` (or wherever the ATC event union is defined), ensure the discriminated union is updated:

```typescript
// Example — find the actual union and extend it:
export type ATCEvent =
  | ExistingEvent1
  | ExistingEvent2
  | ModelCallEvent        // add if not present
  | ModelEscalationEvent; // add if not present
```

If `eventType: 'model_call'` | `'model_escalation'` are not in `GitHubEventType` or the ATC event union, the `queryEvents` call's return type may need a cast. Prefer proper union membership over casts.

### Step 5: TypeScript compilation check
```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- `appendEvent` expects a specific union type — ensure `ModelCallEvent` and `ModelEscalationEvent` are members.
- `queryEvents` return type is too narrow — add the new event types to the union or use a type guard.

### Step 6: Build check
```bash
npm run build
```

Resolve any build errors. If the build fails due to an unrelated pre-existing issue, note it in the PR body.

### Step 7: Commit, push, open PR
```bash
git add lib/atc/events.ts lib/atc/types.ts
git commit -m "feat: add emitModelCallEvent and emitModelEscalationEvent helpers with query support"
git push origin feat/model-event-emission-helpers
gh pr create \
  --title "feat: add model_call and model_escalation event emission helpers" \
  --body "## Summary

Extends \`lib/atc/events.ts\` with typed emit and query helpers for \`model_call\` and \`model_escalation\` events.

## Changes
- \`lib/atc/types.ts\`: Added \`ModelCallEvent\` and \`ModelEscalationEvent\` interfaces (if not already present); extended ATC event union.
- \`lib/atc/events.ts\`: Added \`emitModelCallEvent\`, \`emitModelEscalationEvent\`, \`queryModelCallEvents\`, \`queryModelEscalationEvents\` exports.

## Acceptance Criteria
- [x] \`emitModelCallEvent\` exported and appends properly typed event
- [x] \`emitModelEscalationEvent\` exported and appends properly typed event
- [x] \`queryModelCallEvents\` returns filtered \`ModelCallEvent[]\`
- [x] \`queryModelEscalationEvents\` returns filtered \`ModelEscalationEvent[]\`
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes

## No conflicts
Concurrent branch \`fix/create-episode-detail-page-episodesid\` touches only \`app/episodes/[id]/page.tsx\` — no overlap."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/model-event-emission-helpers
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was left incomplete]
NEXT STEPS: [what remains to reach acceptance criteria]
```

## Escalation Protocol

If you encounter an unresolvable blocker (e.g., `ModelCallEvent`/`ModelEscalationEvent` types are defined in an unexpected location incompatible with the approach described, the internal append function has a fundamentally different signature requiring architectural decisions, or TypeScript errors persist after 3 fix attempts), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-event-emission-helpers-model-call-escalation",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/atc/events.ts", "lib/atc/types.ts"]
    }
  }'
```