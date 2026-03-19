# Agent Forge -- Add priority and rank to dispatch event log entries

## Metadata
- **Branch:** `feat/dispatch-event-priority-rank`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/event-bus-types.ts, lib/atc/events.ts, lib/atc/dispatcher.ts

## Context

The Dispatcher agent (`lib/atc/dispatcher.ts`) emits events to the event log when it dispatches work items. Currently, these events do not include the dispatched item's priority or rank, nor any information about whether higher-priority items were dispatched ahead of lower-priority ones. Adding this information will improve observability in the Agent Forge dashboard and allow operators to understand dispatch ordering decisions.

The event system consists of:
- `lib/event-bus-types.ts` — TypeScript type definitions for all webhook/event types
- `lib/atc/events.ts` — Utilities for creating and appending event log entries
- `lib/atc/dispatcher.ts` — The Dispatcher agent that emits events when dispatching work items

The Dispatcher already ranks/sorts eligible work items by priority before selecting one to dispatch. The task is to surface that ranking information (and any priority-skip context) in the emitted event payload.

**Concurrent work awareness:** Another branch (`fix/cron-audit-summary-and-verceljson-schedule-optimiz`) is modifying `docs/cron-audit-summary.md` and `vercel.json`. There is no file overlap with this task.

## Requirements

1. The dispatch event type in `lib/event-bus-types.ts` must include three new optional fields: `priority?: string`, `rank?: number`, and `prioritySkipped?: { count: number; skippedItemIds: string[]; note: string }`.
2. The Dispatcher must include `priority` and `rank` in every dispatch event it emits.
3. Before dispatching, the Dispatcher must identify eligible items that were queued/created earlier but have a lower priority (higher P-number). If any such items exist, the emitted event must include a `prioritySkipped` object with `count`, `skippedItemIds`, and a human-readable `note` (e.g. `'P0 item dispatched ahead of 3 earlier-queued P2 items'`).
4. When all eligible items share the same priority level, no `prioritySkipped` field is emitted (field is omitted or `undefined`).
5. TypeScript compilation must pass with zero errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dispatch-event-priority-rank
```

### Step 1: Inspect current event type definitions

Read the relevant files to understand existing types before making changes:

```bash
cat lib/event-bus-types.ts
cat lib/atc/events.ts
grep -n "dispatch\|emitEvent\|logEvent\|WorkItemDispatched\|atc_dispatch" lib/atc/dispatcher.ts | head -60
```

Look for:
- The existing dispatch event type name (likely something like `WorkItemDispatchedEvent` or a union member with `type: 'atc_dispatch'` or similar)
- How the event payload is structured today
- How `priority` is stored on a `WorkItem` (likely `item.priority`, values like `"P0"`, `"P1"`, `"P2"`)
- How `rank` could be derived (the sorted index of the dispatched item within the eligible list)
- The signature of the event emission utility in `lib/atc/events.ts`

### Step 2: Update event type definitions in `lib/event-bus-types.ts`

Locate the dispatch event type (search for `dispatch` in the file). Add the three new optional fields to its payload:

```typescript
// Example — adjust the exact type name to match what exists in the file
priority?: string;        // e.g. "P0", "P1", "P2"
rank?: number;            // 0-based or 1-based rank in sorted eligible list
prioritySkipped?: {
  count: number;
  skippedItemIds: string[];
  note: string;           // e.g. "P0 item dispatched ahead of 3 earlier-queued P2 items"
};
```

Do **not** change any existing fields or rename types.

### Step 3: Update event creation utilities in `lib/atc/events.ts` (if needed)

Check whether the event creation helper for dispatch events needs to be updated to accept/forward the new fields. If the helper constructs a typed payload object, add the new optional fields to its parameter signature and pass them through. If events are created inline in the dispatcher, no changes to `events.ts` may be needed — confirm by reading the file.

### Step 4: Update the Dispatcher to populate the new fields in `lib/atc/dispatcher.ts`

Find the section where the Dispatcher:
1. Builds its sorted/ranked list of eligible work items
2. Selects the top item to dispatch
3. Emits the dispatch event

Make the following changes:

**A. Capture rank:** After sorting eligible items, record the 1-based rank of the dispatched item (it will be `1` if dispatched from the top of the list, but capture it explicitly for clarity).

**B. Compute prioritySkipped:** Before dispatching, compare the dispatched item's priority against all other eligible items. Items that were created/queued *earlier* (lower `createdAt` or `queuedAt` timestamp) but have a lower priority (higher P-number) are "skipped" by this dispatch decision.

```typescript
// Pseudocode — adapt to actual variable names in the file
const dispatchedItem = sortedEligible[0]; // highest priority
const dispatchedPriorityNum = parsePriorityNumber(dispatchedItem.priority); // e.g. "P0" → 0

const skippedItems = sortedEligible.slice(1).filter(item => {
  const itemPriorityNum = parsePriorityNumber(item.priority);
  const itemWasQueuedEarlier = (item.queuedAt ?? item.createdAt) < (dispatchedItem.queuedAt ?? dispatchedItem.createdAt);
  return itemPriorityNum > dispatchedPriorityNum && itemWasQueuedEarlier;
});

const prioritySkipped = skippedItems.length > 0
  ? {
      count: skippedItems.length,
      skippedItemIds: skippedItems.map(i => i.id),
      note: `${dispatchedItem.priority} item dispatched ahead of ${skippedItems.length} earlier-queued ${getMostCommonPriority(skippedItems)} item${skippedItems.length > 1 ? 's' : ''}`,
    }
  : undefined;
```

Helper to parse priority number (add as a local function or inline):
```typescript
function parsePriorityNumber(priority: string | undefined): number {
  if (!priority) return 99;
  const match = priority.match(/P(\d+)/i);
  return match ? parseInt(match[1], 10) : 99;
}
```

**C. Include fields in the emitted event:**
```typescript
// When emitting the dispatch event, spread in the new fields:
{
  // ...existing fields...
  priority: dispatchedItem.priority,
  rank: 1, // or the computed rank if items can be dispatched from non-top positions
  ...(prioritySkipped ? { prioritySkipped } : {}),
}
```

### Step 5: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- The `prioritySkipped` type must exactly match between `event-bus-types.ts` and the object constructed in `dispatcher.ts`
- If `priority` on `WorkItem` is typed differently than `string` (e.g. a union), adjust accordingly

### Step 6: Run build

```bash
npm run build
```

Resolve any build errors.

### Step 7: Verification checklist

Manually verify the following by reading the diff:
- [ ] `lib/event-bus-types.ts`: dispatch event type now has `priority?: string`, `rank?: number`, `prioritySkipped?: { count: number; skippedItemIds: string[]; note: string }`
- [ ] `lib/atc/dispatcher.ts`: every code path that emits a dispatch event includes `priority` and `rank`
- [ ] `lib/atc/dispatcher.ts`: `prioritySkipped` is only populated when earlier-queued items of lower priority exist
- [ ] `lib/atc/dispatcher.ts`: `prioritySkipped` is `undefined` / not included when all eligible items share the same priority
- [ ] `npx tsc --noEmit` exits with code 0

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add priority, rank, and prioritySkipped to dispatch event log entries"
git push origin feat/dispatch-event-priority-rank
gh pr create \
  --title "feat: add priority and rank to dispatch event log entries" \
  --body "## Summary

Adds observability fields to Dispatcher event emissions so operators can understand dispatch ordering decisions.

### Changes

- **\`lib/event-bus-types.ts\`**: Added \`priority?: string\`, \`rank?: number\`, and \`prioritySkipped?: { count: number; skippedItemIds: string[]; note: string }\` to the dispatch event payload type.
- **\`lib/atc/events.ts\`**: Updated event creation utility (if applicable) to accept and forward new optional fields.
- **\`lib/atc/dispatcher.ts\`**: Populated \`priority\` and \`rank\` on every dispatch event. Computed \`prioritySkipped\` when a higher-priority item is dispatched ahead of earlier-queued lower-priority items.

### Behaviour

- Every dispatch event now carries the dispatched item's \`priority\` (e.g. \`\"P0\"\`) and \`rank\` (position in the sorted eligible list).
- When a higher-priority item jumps ahead of earlier-queued lower-priority items, the event includes a \`prioritySkipped\` object with count, IDs, and a human-readable note (e.g. \`\"P0 item dispatched ahead of 3 earlier-queued P2 items\"\`).
- When all eligible items share the same priority, \`prioritySkipped\` is omitted.

### Testing

- \`npx tsc --noEmit\` passes with zero errors.
- \`npm run build\` succeeds.

No concurrent file conflicts (concurrent branch touches \`vercel.json\` and \`docs/cron-audit-summary.md\` only)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dispatch-event-priority-rank
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter a blocker that cannot be resolved autonomously (e.g. the dispatch event type does not exist in `lib/event-bus-types.ts`, the Dispatcher does not emit events at all, or the `WorkItem.priority` field is absent/typed unexpectedly), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-priority-rank-dispatch-event-log",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/event-bus-types.ts", "lib/atc/events.ts", "lib/atc/dispatcher.ts"]
    }
  }'
```