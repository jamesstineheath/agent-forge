# Agent Forge -- Add dispatch sort comparator with default priority constants

## Metadata
- **Branch:** `feat/dispatch-sort-comparator`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/atc/utils.ts

## Context

Agent Forge uses a work item pipeline where items are dispatched to target repos for execution. Currently, work items can have `priority` (`P0 | P1 | P2`) and `rank` (number) fields as of a recent PR that added `Priority` type and these fields to `WorkItem`. However, legacy items in the store may lack these fields entirely.

The Dispatcher (`lib/atc/dispatcher.ts`) needs a consistent way to sort work items before dispatching — P0 items should jump the queue, then rank ascending, then FIFO by creation time. The Dashboard also needs the same sort logic for display consistency.

This task adds three exported constants and a comparator function to `lib/atc/utils.ts`. That file already exists and contains other shared utilities (file parsing, overlap detection, timeout wrapper). This is a purely additive change — no existing code is modified, just new exports added.

**No file overlap with concurrent work item** ("Integrate Spend Monitor into Supervisor agent" touches `lib/atc/supervisor.ts`, `app/api/agents/supervisor/cron/route.ts`, `lib/escalation.ts`, `lib/vercel-spend-monitor.ts` — no conflict).

## Requirements

1. `lib/atc/utils.ts` exports `DEFAULT_PRIORITY` constant typed as `Priority` with value `'P1'`
2. `lib/atc/utils.ts` exports `DEFAULT_RANK` constant typed as `number` with value `999`
3. `lib/atc/utils.ts` exports `PRIORITY_ORDER` constant typed as `Record<Priority, number>` mapping `P0→0, P1→1, P2→2`
4. `lib/atc/utils.ts` exports `dispatchSortComparator(a: WorkItem, b: WorkItem): number` that:
   - Sorts by priority ascending using `PRIORITY_ORDER` (P0 first, P2 last)
   - Falls back to `DEFAULT_PRIORITY` when `priority` is `undefined`
   - If priority equal, sorts by rank ascending
   - Falls back to `DEFAULT_RANK` when `rank` is `undefined`
   - If rank equal, sorts by `createdAt` ascending (earliest first, string ISO comparison is sufficient)
5. Inline comments document that legacy items without `priority`/`rank` default to P1/999
6. TypeScript compiles without errors (`npx tsc --noEmit`)
7. No existing exports or behavior in `lib/atc/utils.ts` are modified

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dispatch-sort-comparator
```

### Step 1: Inspect existing lib/atc/utils.ts and lib/types.ts

Before editing, read the current state of both files to understand existing imports and the `Priority` / `WorkItem` type shapes:

```bash
cat lib/atc/utils.ts
cat lib/types.ts
```

Confirm:
- `Priority` is exported from `lib/types.ts` (it was added in the "add Priority type and priority/rank fields to WorkItem" PR)
- `WorkItem` has optional `priority?: Priority` and `rank?: number` fields
- `lib/atc/utils.ts` already imports from `lib/types.ts` (or determine what it imports so you can add to the same import statement)

### Step 2: Add constants and comparator to lib/atc/utils.ts

Append the following block to `lib/atc/utils.ts`. Place it **after** existing exports, before the final end of file. Adjust the import line if `Priority` and `WorkItem` aren't already imported — add them to the existing import from `'../types'` (or `'@/lib/types'`, match the existing convention in the file).

```typescript
// ---------------------------------------------------------------------------
// Dispatch sort constants and comparator
// ---------------------------------------------------------------------------

// Legacy work items that predate the priority/rank fields default to P1 / 999,
// placing them in the middle of the queue behind any explicitly filed P0 items.
export const DEFAULT_PRIORITY: Priority = 'P1';
export const DEFAULT_RANK = 999;

/** Maps Priority labels to numeric sort keys (lower = higher urgency). */
export const PRIORITY_ORDER: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
};

/**
 * Comparator for sorting WorkItems before dispatch.
 *
 * Sort order (ascending):
 *   1. Priority:  P0 → P1 → P2  (undefined treated as DEFAULT_PRIORITY = 'P1')
 *   2. Rank:      lower rank first (undefined treated as DEFAULT_RANK = 999)
 *   3. createdAt: earliest first (FIFO tiebreaker)
 *
 * Usage: workItems.sort(dispatchSortComparator)
 */
export function dispatchSortComparator(a: WorkItem, b: WorkItem): number {
  // 1. Priority comparison — legacy items without priority default to P1
  const aPriority = PRIORITY_ORDER[a.priority ?? DEFAULT_PRIORITY];
  const bPriority = PRIORITY_ORDER[b.priority ?? DEFAULT_PRIORITY];
  if (aPriority !== bPriority) return aPriority - bPriority;

  // 2. Rank comparison — legacy items without rank default to 999
  const aRank = a.rank ?? DEFAULT_RANK;
  const bRank = b.rank ?? DEFAULT_RANK;
  if (aRank !== bRank) return aRank - bRank;

  // 3. createdAt tiebreaker — earliest submitted wins (FIFO)
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
```

**Import adjustment:** If `Priority` and/or `WorkItem` are not already imported in `lib/atc/utils.ts`, add them. For example, if the file currently has:

```typescript
import { WorkItem } from '../types';
```

Change to:

```typescript
import { WorkItem, Priority } from '../types';
```

Match whatever path convention (`'../types'` vs `'@/lib/types'`) the file already uses. Do not introduce a new import style.

### Step 3: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

If there are errors:
- If `Priority` is not found: confirm it was exported from `lib/types.ts` in the earlier PR. If missing entirely, check git log: `git log --oneline --all | head -20` and `git show HEAD --stat`.
- If `WorkItem.priority` or `WorkItem.rank` don't exist: the fields may be named differently — check `lib/types.ts` and adjust property access accordingly.
- Fix any import path issues (tsconfig paths, relative vs alias).

### Step 4: Run build to confirm no module resolution issues

```bash
npm run build
```

A Next.js build confirms that module resolution, tree-shaking, and any framework-specific checks pass. If the build fails for reasons unrelated to this change (pre-existing failures), note them in the PR but do not attempt to fix them — stay scoped to `lib/atc/utils.ts`.

### Step 5: Verification — quick smoke test (optional but recommended)

If the project has a test runner configured, run it:

```bash
npm test 2>/dev/null || echo "No test suite configured"
```

If no tests exist, manually verify the logic is correct by reviewing the comparator one more time:
- P0 item vs P1 item → P0 comes first (0 < 1) ✓
- Two P1 items with ranks 5 and 10 → rank 5 first ✓
- Two P1 items, rank 999, createdAt "2024-01-01" vs "2024-01-02" → Jan 1 first ✓
- Item with `priority: undefined, rank: undefined` → treated as P1/999 ✓

### Step 6: Commit, push, open PR

```bash
git add lib/atc/utils.ts
git commit -m "feat: add dispatchSortComparator and priority constants to lib/atc/utils.ts"
git push origin feat/dispatch-sort-comparator
gh pr create \
  --title "feat: add dispatch sort comparator with default priority constants" \
  --body "## Summary

Adds shared dispatch sort comparator and priority constants to \`lib/atc/utils.ts\`.

### New exports

- \`DEFAULT_PRIORITY: Priority = 'P1'\` — fallback for legacy work items without priority
- \`DEFAULT_RANK = 999\` — fallback for legacy work items without rank
- \`PRIORITY_ORDER: Record<Priority, number>\` — maps P0→0, P1→1, P2→2
- \`dispatchSortComparator(a, b)\` — sorts by priority → rank → createdAt ascending

### Sort semantics

| Field | Default (legacy items) | Direction |
|-------|----------------------|-----------|
| priority | P1 | ascending (P0 first) |
| rank | 999 | ascending (lower first) |
| createdAt | — | ascending (FIFO) |

### Usage

\`\`\`typescript
import { dispatchSortComparator } from '@/lib/atc/utils';
readyItems.sort(dispatchSortComparator);
\`\`\`

### No breaking changes

Purely additive — no existing exports modified. No overlap with concurrent branch \`feat/integrate-spend-monitor-into-supervisor-agent\`.

### Acceptance criteria
- [x] \`DEFAULT_PRIORITY\` exported with value \`'P1'\`
- [x] \`DEFAULT_RANK\` exported with value \`999\`
- [x] \`PRIORITY_ORDER\` exported with P0=0, P1=1, P2=2
- [x] \`dispatchSortComparator\` sorts P0 before P1 before P2, then rank asc, then createdAt asc
- [x] \`undefined\` priority treated as P1, \`undefined\` rank treated as 999
- [x] \`npx tsc --noEmit\` passes
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "feat: partial - dispatch sort comparator (see PR for status)"
git push origin feat/dispatch-sort-comparator
```

2. Open the PR with partial status:
```bash
gh pr create --title "feat: add dispatch sort comparator [PARTIAL]" --body "Partial implementation - see ISSUES below"
```

3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dispatch-sort-comparator
FILES CHANGED: lib/atc/utils.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Escalation

If blocked by a fundamental issue (e.g., `Priority` type does not exist in `lib/types.ts` after checking git history, or `WorkItem` shape is incompatible in an unexpected way), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-dispatch-sort-comparator",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/atc/utils.ts"]
    }
  }'
```