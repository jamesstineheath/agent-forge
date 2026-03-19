# Agent Forge -- Sort Dashboard Queue by Priority and Add Priority Badges

## Metadata
- **Branch:** `feat/dashboard-queue-priority-sort-badges`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/dashboard/page.tsx, app/api/work-items/route.ts, lib/hooks.ts

## Context

The Agent Forge dashboard displays a work item queue/backlog, but currently items are not sorted by priority. A shared `dispatchSortComparator` already exists in `lib/atc/utils.ts` (added as part of the "add priority and rank to dispatch event log entries" PR). This task wires that comparator into the dashboard UI, the work items API, and the SWR client hook, and adds visual priority badges (P0/P1/P2) with rank numbers to each queue item.

**Existing comparator** (from `lib/atc/utils.ts`):
```ts
export function dispatchSortComparator(a: WorkItem, b: WorkItem): number {
  // priority order: 0 (P0) < 1 (P1) < 2 (P2) < undefined
  const pa = a.priority ?? 99;
  const pb = b.priority ?? 99;
  if (pa !== pb) return pa - pb;
  // then rank ascending (undefined sorts last)
  const ra = a.rank ?? Infinity;
  const rb = b.rank ?? Infinity;
  if (ra !== rb) return ra - rb;
  // then createdAt ascending
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}
```

> If the function signature or name differs, read the actual file and adapt accordingly.

**Priority badge colors:**
- P0 → red (`bg-red-100 text-red-700` or similar Tailwind)
- P1 → yellow (`bg-yellow-100 text-yellow-700`)
- P2 → gray (`bg-gray-100 text-gray-600`)
- undefined/unknown → gray, label "P?"

The codebase uses Tailwind CSS and Next.js App Router. Auth is Google OAuth via Auth.js v5. Work items are stored in Vercel Blob and exposed via `lib/work-items.ts`.

## Requirements

1. `app/api/work-items/route.ts` GET handler returns work items sorted by priority ascending, then rank ascending, then createdAt ascending using `dispatchSortComparator`.
2. `app/dashboard/page.tsx` imports `dispatchSortComparator` and applies it before rendering the queue list (covers server-rendered path).
3. Each work item row in the dashboard queue shows a colored priority badge (P0 red, P1 yellow, P2 gray/unknown).
4. Each work item row in the dashboard queue shows its rank number (display `#<rank>` or `—` if undefined).
5. `lib/hooks.ts` — if the `useWorkItems` (or equivalent) SWR hook applies any sort, it uses `dispatchSortComparator`. If no client-side sort exists, leave the hook as-is (API already returns sorted data).
6. TypeScript compilation passes with zero errors (`npx tsc --noEmit`).
7. No existing tests are broken.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-queue-priority-sort-badges
```

### Step 1: Inspect existing files

Read the actual implementations before making changes:

```bash
cat lib/atc/utils.ts | grep -A 20 "dispatchSortComparator\|SortComparator"
cat app/api/work-items/route.ts
cat app/dashboard/page.tsx
cat lib/hooks.ts
cat lib/types.ts | grep -A 10 "priority\|rank\|WorkItem"
```

Note the exact function name and export style of the sort comparator. Note whether `priority` is typed as `number | undefined`, `0 | 1 | 2 | undefined`, or a string enum. Note how dashboard renders its work item list (server component? client component? which list variable?).

### Step 2: Update `app/api/work-items/route.ts`

In the GET handler, after fetching work items, apply the sort comparator before returning:

```ts
import { dispatchSortComparator } from '@/lib/atc/utils';

// Inside GET handler, before returning:
const sorted = items.slice().sort(dispatchSortComparator);
return NextResponse.json(sorted);
```

**Important:** Use `.slice()` before `.sort()` to avoid mutating the original array. Adapt the variable name to match the existing code. If the file already applies some sorting, replace it with `dispatchSortComparator`.

### Step 3: Update `app/dashboard/page.tsx`

**3a. Add import:**
```ts
import { dispatchSortComparator } from '@/lib/atc/utils';
```

**3b. Apply sort to the queue list variable** (before mapping over items to render). Adapt the variable name to whatever holds the work items in the queue section:
```ts
const sortedItems = queueItems.slice().sort(dispatchSortComparator);
```

**3c. Add priority badge and rank to each work item row.** Find the JSX that maps over queue items and add badge + rank. Example pattern to insert inside the existing item row:

```tsx
{/* Priority badge */}
{(() => {
  const p = item.priority;
  if (p === 0) return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-red-100 text-red-700">P0</span>;
  if (p === 1) return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-yellow-100 text-yellow-700">P1</span>;
  if (p === 2) return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-600">P2</span>;
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-500">P?</span>;
})()}

{/* Rank */}
<span className="text-xs text-gray-400 ml-1">
  {item.rank !== undefined && item.rank !== null ? `#${item.rank}` : '—'}
</span>
```

Place badges before the item title/name for visual prominence. Match the existing Tailwind class style in the file (check whether it uses `rounded`, `rounded-md`, etc.).

### Step 4: Update `lib/hooks.ts` (conditional)

Inspect the SWR hook for work items:

```bash
grep -n "useWorkItems\|work-items\|sort\|comparator" lib/hooks.ts
```

- **If there is client-side sorting in the hook:** replace it with `dispatchSortComparator` imported from `@/lib/atc/utils`.
- **If there is no client-side sorting:** leave the hook unchanged (the API now returns sorted data; no changes needed).

If you add the import, use:
```ts
import { dispatchSortComparator } from '@/lib/atc/utils';
```

### Step 5: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- `priority` typed as string in some places but number in others — adapt badge logic to match actual type.
- Missing `rank` on `WorkItem` type — check `lib/types.ts`; if `rank` is missing, add it as `rank?: number`.

### Step 6: Build verification

```bash
npm run build
```

Resolve any build errors. Do not commit with a broken build.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: sort dashboard queue by priority and add priority badges"
git push origin feat/dashboard-queue-priority-sort-badges
gh pr create \
  --title "feat: sort dashboard queue by priority and add priority badges" \
  --body "## Summary
Sorts the dashboard work item queue by priority (P0 first), then rank ascending, then createdAt ascending using the existing \`dispatchSortComparator\` from \`lib/atc/utils.ts\`.

## Changes
- \`app/api/work-items/route.ts\`: Apply \`dispatchSortComparator\` in GET handler before returning items
- \`app/dashboard/page.tsx\`: Sort queue items with comparator; add P0/P1/P2 color badges and rank numbers to each row
- \`lib/hooks.ts\`: Apply comparator to client-side sort if present (no-op otherwise)

## Acceptance Criteria
- [x] Dashboard queue sorted by priority then rank then createdAt
- [x] P0 (red), P1 (yellow), P2 (gray) badges visible on each queue item
- [x] Rank number shown per item
- [x] GET /api/work-items returns sorted list
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-queue-priority-sort-badges
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., `dispatchSortComparator` does not exist in `lib/atc/utils.ts`, the `WorkItem` type is missing `priority`/`rank` fields entirely, or the dashboard page structure is fundamentally different from what's described):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "sort-dashboard-queue-priority-badges",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/dashboard/page.tsx", "app/api/work-items/route.ts", "lib/hooks.ts"]
    }
  }'
```