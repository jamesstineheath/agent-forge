<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Add retrying/verified/partial status lifecycle to work items

## Metadata
- **Branch:** `feat/retrying-verified-partial-status-lifecycle`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/atc/health-monitor.ts, lib/atc/dispatcher.ts, app/(app)/work-items/page.tsx, app/(app)/page.tsx, components/quick-stats.tsx, components/project-card.tsx

## Context

Work items currently only have the statuses defined in `lib/types.ts`. When the Health Monitor triggers a retry (code retry or infra retry via `rerunFailedJobs`), the work item remains at `failed` status, causing the dashboard to show red indicators even while the system is actively self-healing. This is misleading.

This task adds three new status values to the WorkItem union:
- **`retrying`** — active retry in progress (amber/yellow, not red, not re-dispatched)
- **`verified`** — post-merge acceptance criteria validated (placeholder for Intent Validation)
- **`partial`** — post-merge with gaps, remediation filed (placeholder for Intent Validation)

The Health Monitor already has retry logic (code retries and infra retries). We just need to update it to set `retrying` status when it triggers those retries. The Dispatcher already checks for in-progress statuses — we need to add `retrying` to that set. The dashboard needs color/icon treatment for all three new statuses.

Existing status flow from `lib/types.ts`:
```
filed → ready → queued → generating → executing → merged/failed/parked
```

New additions:
```
failed → retrying → executing (new run starts)
failed → retrying → parked (retries exhausted)
merged → verified (future: Intent Validation)
merged → partial (future: Intent Validation)
```

## Requirements

1. `lib/types.ts`: Add `'retrying' | 'verified' | 'partial'` to the `WorkItemStatus` type union
2. `lib/atc/health-monitor.ts`: When triggering a code retry (`rerunFailedJobs` or equivalent), set work item status to `retrying` via `updateWorkItem` before/during the retry trigger
3. `lib/atc/health-monitor.ts`: When triggering an infra retry, set status to `retrying` similarly
4. `lib/atc/dispatcher.ts`: Ensure `retrying` is treated as an in-progress/active status so items are not re-dispatched
5. Dashboard work items list (`app/(app)/work-items/page.tsx` or wherever status badges are rendered): Show `retrying` as amber/yellow with 🔄, `verified` as green with ✅, `partial` as orange with ⚠️
6. Any other dashboard files that render status colors (`app/(app)/page.tsx`, `components/quick-stats.tsx`, `components/project-card.tsx`) must handle the new statuses without throwing/defaulting to wrong colors
7. TypeScript compiles with no errors (`npx tsc --noEmit`)
8. Build succeeds (`npm run build`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/retrying-verified-partial-status-lifecycle
```

### Step 1: Update WorkItem status union in `lib/types.ts`

Find the `WorkItemStatus` type (or wherever status is defined as a union or enum). It likely looks like:

```typescript
export type WorkItemStatus =
  | 'filed'
  | 'ready'
  | 'queued'
  | 'generating'
  | 'executing'
  | 'merged'
  | 'failed'
  | 'parked'
  | 'blocked';
```

Add the three new statuses:

```typescript
export type WorkItemStatus =
  | 'filed'
  | 'ready'
  | 'queued'
  | 'generating'
  | 'executing'
  | 'merged'
  | 'failed'
  | 'retrying'    // Failed but system is auto-retrying
  | 'parked'
  | 'blocked'
  | 'verified'    // Merged + acceptance criteria validated (Intent Validation)
  | 'partial';    // Merged but some criteria unmet, remediation filed (Intent Validation)
```

Also check if there's a `TERMINAL_STATUSES` or `IN_PROGRESS_STATUSES` array/const in `lib/types.ts` or `lib/atc/types.ts` — update those accordingly:
- `retrying` is NOT terminal (it transitions to `executing` or `parked`)
- `verified` and `partial` ARE terminal
- `retrying` IS in-progress / active

### Step 2: Update Health Monitor to set `retrying` status

Open `lib/atc/health-monitor.ts`. Find the sections where retries are triggered. There will be code paths for:
1. **Code retry** — likely calls something like `rerunFailedJobs` or re-dispatches a handoff
2. **Infra retry** — likely calls GitHub API to rerun failed workflow jobs

Before each retry trigger, add a call to update the work item status to `retrying`. The pattern should be:

```typescript
// Before triggering code retry
await updateWorkItem(workItem.id, { status: 'retrying' });
// ... then trigger the retry ...
```

Look for comments like `// retry`, `rerunFailed`, or status transitions from `failed`. The health monitor likely calls `updateWorkItem` from `lib/work-items.ts` already for other transitions.

**Important:** After triggering the retry and the new execution starts, the status should transition back to `executing` (this likely already happens when the execute-handoff workflow runs and the orchestrator/dispatcher picks it up — verify this flow and don't break it).

Search for all places in `health-monitor.ts` that transition items FROM `failed` status — each of those that triggers a new attempt should set `retrying` first.

### Step 3: Update Dispatcher to treat `retrying` as in-progress

Open `lib/atc/dispatcher.ts`. Find where it checks for "active" or "in-progress" work items to enforce concurrency limits and avoid re-dispatching. It likely has something like:

```typescript
const IN_PROGRESS_STATUSES = ['queued', 'generating', 'executing'];
// or
if (['queued', 'generating', 'executing'].includes(item.status)) { ... }
```

Add `'retrying'` to all such arrays/checks:

```typescript
const IN_PROGRESS_STATUSES: WorkItemStatus[] = ['queued', 'generating', 'executing', 'retrying'];
```

Also ensure the dispatcher's dispatch eligibility check skips items with status `retrying` (don't re-dispatch them). The dispatcher should only dispatch items in `ready` status.

Also check `lib/atc/types.ts` for any `ACTIVE_STATUSES` or similar constants and add `retrying` there too.

### Step 4: Update dashboard status rendering

#### 4a: Find all status badge/color rendering locations

Search for patterns like `status === 'failed'` or `case 'merged':` or a `statusColor` / `getStatusBadge` helper function. Common locations based on the codebase:
- `app/(app)/work-items/page.tsx`
- `app/(app)/page.tsx`
- `components/quick-stats.tsx`
- `components/project-card.tsx`
- There may be a shared utility or component — check `components/ui/` or `lib/utils.ts`

#### 4b: Add color/style mappings for new statuses

For each location that maps status → color/style, add entries for the three new statuses. Use Tailwind classes consistent with the existing patterns:

```typescript
// Example additions to whatever status→color map exists:
retrying: 'bg-amber-100 text-amber-800 border-amber-200',   // amber/yellow
verified: 'bg-green-100 text-green-800 border-green-200',   // green (same family as merged, but distinct)
partial:  'bg-orange-100 text-orange-800 border-orange-200', // orange with warning tone
```

#### 4c: Add label/icon mappings

Where status labels or display text is mapped, add:
```typescript
retrying: 'Retrying',
verified: 'Verified',
partial:  'Partial',
```

Where icons or emoji are used:
```typescript
retrying: '🔄',
verified: '✅',
partial:  '⚠️',
```

#### 4d: Handle any exhaustive switch statements

If there are `switch (status)` statements, add cases for the three new statuses so TypeScript doesn't complain about unhandled values.

### Step 5: Check for any status filter dropdowns or lists

In `app/(app)/work-items/page.tsx` (or wherever filtering by status is implemented), there may be a list of all valid statuses for filter options. Add `retrying`, `verified`, and `partial` to these lists so they're filterable.

### Step 6: Check `lib/work-items.ts` for any status validation

If `lib/work-items.ts` has any allowlist of valid statuses (e.g., for validation on create/update), add the new statuses.

### Step 7: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Run tests if any exist
npm test 2>/dev/null || echo "No tests configured"
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- Exhaustive union checks in switch statements (add cases for all 3 new statuses)
- Any `Array<WorkItemStatus>` that needs updating
- Status comparison logic in health-monitor or dispatcher

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add retrying/verified/partial status lifecycle to work items

- Add retrying, verified, partial to WorkItemStatus union in lib/types.ts
- Health Monitor sets status to 'retrying' when triggering code/infra retries
- Dispatcher treats 'retrying' as in-progress (no re-dispatch)
- Dashboard renders retrying as amber, verified as green, partial as orange
- verified and partial are placeholder terminal states for Intent Validation

Resolves misleading red dashboard state during active self-healing retries."

git push origin feat/retrying-verified-partial-status-lifecycle

gh pr create \
  --title "feat: add retrying/verified/partial status lifecycle to work items" \
  --body "## Summary

Adds three new work item statuses to accurately reflect the system's self-healing behavior and future validation states.

### New Statuses

| Status | Color | Meaning |
|--------|-------|---------|
| \`retrying\` | Amber/yellow 🔄 | Failed but Health Monitor is auto-retrying |
| \`verified\` | Green ✅ | Merged + acceptance criteria validated (Intent Validation placeholder) |
| \`partial\` | Orange ⚠️ | Merged but some criteria unmet, remediation filed (Intent Validation placeholder) |

### Changes

- **\`lib/types.ts\`**: Added \`retrying | verified | partial\` to \`WorkItemStatus\` union
- **\`lib/atc/health-monitor.ts\`**: Sets \`retrying\` status before triggering code/infra retries (previously left at \`failed\`)
- **\`lib/atc/dispatcher.ts\`**: \`retrying\` treated as in-progress — items not re-dispatched
- **Dashboard files**: Amber/yellow for \`retrying\`, green for \`verified\`, orange for \`partial\`

### Why

The dashboard was showing red (failed) even while the Health Monitor was actively retrying. This caused false alarm signals and undermined confidence in the self-healing system. \`retrying\` status gives an accurate amber/yellow signal that recovery is in progress.

\`verified\` and \`partial\` are added now as placeholder terminal states. Intent Validation will implement the actual transitions (merged → verified / partial) in a future work item.

### Testing

- TypeScript compiles clean
- Build passes
- Manually verified status flow: failed → retrying → executing"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/retrying-verified-partial-status-lifecycle
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker (e.g., the Health Monitor retry logic is more complex than expected and the correct insertion point for `retrying` status is ambiguous, or the status union is defined differently than expected):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "retrying-verified-partial-status-lifecycle",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/atc/health-monitor.ts", "lib/atc/dispatcher.ts"]
    }
  }'
```