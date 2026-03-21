# Agent Forge -- Add WaveProgress Dashboard Component

## Metadata
- **Branch:** `feat/wave-progress-dashboard-component`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** components/wave-progress.tsx, app/projects/[id]/page.tsx, lib/hooks.ts, app/api/work-items/route.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel). A wave scheduler has recently been implemented (see merged PRs: `implement-wave-scheduler-algorithm-dag-topological`, `add-wavenumber-column-to-workitems-schema`, `add-wave-event-types-and-emission-helpers`). The `work_items` table now has a `waveNumber` column (Drizzle schema in `lib/db/schema.ts`). The `WaveProgressData` type was added in `lib/types.ts`.

This task adds a `WaveProgress` React component to visualize per-wave execution progress on the project detail page, backed by a new API grouping and SWR hook.

**Existing patterns to follow:**
- Components use Tailwind CSS and shadcn/ui (`components/ui/`)
- SWR hooks live in `lib/hooks.ts` and call `fetcher` (already defined there)
- Work items API is at `app/api/work-items/route.ts` using Drizzle + Neon Postgres
- `lib/db/schema.ts` defines the `workItems` table; `lib/types.ts` defines shared types
- `lib/work-items.ts` has work item CRUD helpers

## Requirements

1. `components/wave-progress.tsx` renders a wave-by-wave visualization with wave number, status (pending/active/complete), progress bar, item count, and individual item cards with status badges.
2. `lib/hooks.ts` exports `useWaveProgress(projectId: string)` SWR hook that fetches from `/api/work-items?projectId=X&groupByWave=true`.
3. `GET /api/work-items` supports `groupByWave=true` query parameter and returns items grouped by `waveNumber` with per-wave status computed.
4. `WaveProgress` is imported and rendered in `app/projects/[id]/page.tsx` when the project has work items with `waveNumber` assigned.
5. The project builds successfully with no TypeScript errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/wave-progress-dashboard-component
```

### Step 1: Inspect existing types and schema

Read the following files to understand the current shape of data before writing code:

```bash
cat lib/types.ts          # Look for WorkItem, WaveProgressData types
cat lib/db/schema.ts      # Look for workItems table columns including waveNumber
cat lib/hooks.ts          # Look for existing hooks pattern (fetcher, useWorkItems, etc.)
cat app/api/work-items/route.ts   # Look for existing GET handler
cat app/projects/\[id\]/page.tsx  # Look for project detail page structure
```

Also check what shadcn/ui components are available:
```bash
ls components/ui/
```

### Step 2: Update `lib/types.ts` — add wave grouping types

Add the following types if they don't already exist (check first):

```typescript
// Wave status for a group of work items in a wave
export type WaveStatus = 'pending' | 'active' | 'complete' | 'failed';

// Per-wave grouping returned by API when groupByWave=true
export interface WaveGroup {
  waveNumber: number;
  status: WaveStatus;
  items: WorkItem[];
  totalItems: number;
  completedItems: number;
  progressPercent: number;
}

// Full response shape when groupByWave=true
export interface WaveProgressData {
  projectId: string;
  waves: WaveGroup[];
  currentWave: number | null;
  totalWaves: number;
}
```

If `WaveProgressData` already exists in `lib/types.ts`, reconcile with what's there — extend rather than replace.

### Step 3: Update `app/api/work-items/route.ts` — add groupByWave support

In the GET handler, add support for `?groupByWave=true&projectId=X`. The handler should:

1. Detect `groupByWave=true` in search params
2. Require `projectId` to be present when `groupByWave=true`
3. Fetch all work items for the project (no other filters needed)
4. Group them by `waveNumber`, compute per-wave status, and return `WaveProgressData`

Wave status computation logic:
- A wave is **complete** if all items are in terminal states (`merged`, `verified`, `partial`)
- A wave is **failed** if any item is in state `failed` or `parked` and none are active
- A wave is **active** if any item is in states `queued`, `generating`, `executing`, `reviewing`, `retrying`
- A wave is **pending** if all items are in `filed`, `ready`, or `blocked`

Items with `waveNumber = null` (no wave assigned) should be omitted from the wave grouping response.

Example addition to the GET handler (adapt to existing code style):

```typescript
const groupByWave = searchParams.get('groupByWave') === 'true';

if (groupByWave) {
  const projectIdParam = searchParams.get('projectId');
  if (!projectIdParam) {
    return NextResponse.json({ error: 'projectId required when groupByWave=true' }, { status: 400 });
  }

  // Fetch all work items for this project that have a waveNumber
  const items = await db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.projectId, projectIdParam),
        isNotNull(workItems.waveNumber)
      )
    )
    .orderBy(workItems.waveNumber, workItems.createdAt);

  // Group by waveNumber
  const waveMap = new Map<number, WorkItem[]>();
  for (const item of items) {
    const wn = item.waveNumber as number;
    if (!waveMap.has(wn)) waveMap.set(wn, []);
    waveMap.get(wn)!.push(item as WorkItem);
  }

  const TERMINAL_STATES = new Set(['merged', 'verified', 'partial']);
  const ACTIVE_STATES = new Set(['queued', 'generating', 'executing', 'reviewing', 'retrying']);
  const FAILED_STATES = new Set(['failed', 'parked']);

  const computeWaveStatus = (waveItems: WorkItem[]): WaveStatus => {
    const statuses = waveItems.map(i => i.status);
    if (statuses.every(s => TERMINAL_STATES.has(s))) return 'complete';
    if (statuses.some(s => ACTIVE_STATES.has(s))) return 'active';
    if (statuses.some(s => FAILED_STATES.has(s)) && !statuses.some(s => ACTIVE_STATES.has(s))) return 'failed';
    return 'pending';
  };

  const sortedWaveNumbers = [...waveMap.keys()].sort((a, b) => a - b);

  const waves: WaveGroup[] = sortedWaveNumbers.map(wn => {
    const waveItems = waveMap.get(wn)!;
    const completedItems = waveItems.filter(i => TERMINAL_STATES.has(i.status)).length;
    const status = computeWaveStatus(waveItems);
    return {
      waveNumber: wn,
      status,
      items: waveItems,
      totalItems: waveItems.length,
      completedItems,
      progressPercent: waveItems.length > 0 ? Math.round((completedItems / waveItems.length) * 100) : 0,
    };
  });

  const activeWave = waves.find(w => w.status === 'active');
  const currentWave = activeWave?.waveNumber ?? null;

  const response: WaveProgressData = {
    projectId: projectIdParam,
    waves,
    currentWave,
    totalWaves: waves.length,
  };

  return NextResponse.json(response);
}
```

Make sure to import `isNotNull` from `drizzle-orm` if not already imported.

### Step 4: Update `lib/hooks.ts` — add useWaveProgress hook

Add the following hook after the existing work item hooks:

```typescript
export function useWaveProgress(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR<WaveProgressData>(
    projectId ? `/api/work-items?projectId=${projectId}&groupByWave=true` : null,
    fetcher,
    { refreshInterval: 15000 } // refresh every 15s for active tracking
  );
  return { data, error, isLoading, mutate };
}
```

Import `WaveProgressData` from `lib/types` at the top of the file (add to existing import if present).

### Step 5: Create `components/wave-progress.tsx`

Check which shadcn/ui components exist (`ls components/ui/`) and use available ones. The component should gracefully handle unavailable components with plain Tailwind alternatives.

```tsx
'use client';

import { useWaveProgress } from '@/lib/hooks';
import { WaveGroup } from '@/lib/types';

// Helper: map status to Tailwind color classes
function waveStatusColor(status: WaveGroup['status']) {
  switch (status) {
    case 'complete': return 'text-green-600 bg-green-50 border-green-200';
    case 'active':   return 'text-blue-600 bg-blue-50 border-blue-200';
    case 'failed':   return 'text-red-600 bg-red-50 border-red-200';
    default:         return 'text-gray-500 bg-gray-50 border-gray-200';
  }
}

function itemStatusBadge(status: string) {
  const map: Record<string, string> = {
    merged:    'bg-green-100 text-green-800',
    verified:  'bg-emerald-100 text-emerald-800',
    partial:   'bg-yellow-100 text-yellow-800',
    executing: 'bg-blue-100 text-blue-800',
    reviewing: 'bg-indigo-100 text-indigo-800',
    queued:    'bg-sky-100 text-sky-800',
    generating:'bg-cyan-100 text-cyan-800',
    retrying:  'bg-orange-100 text-orange-800',
    failed:    'bg-red-100 text-red-800',
    parked:    'bg-rose-100 text-rose-800',
    blocked:   'bg-purple-100 text-purple-800',
    ready:     'bg-slate-100 text-slate-800',
    filed:     'bg-gray-100 text-gray-800',
  };
  return map[status] ?? 'bg-gray-100 text-gray-700';
}

function WaveCard({ wave }: { wave: WaveGroup }) {
  return (
    <div className={`rounded-lg border p-4 mb-3 ${waveStatusColor(wave.status)}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">Wave {wave.waveNumber}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize border ${waveStatusColor(wave.status)}`}>
            {wave.status}
          </span>
        </div>
        <span className="text-xs font-medium">
          {wave.completedItems} / {wave.totalItems} done
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full bg-gray-200 rounded-full h-1.5 mb-3">
        <div
          className={`h-1.5 rounded-full transition-all ${
            wave.status === 'complete' ? 'bg-green-500' :
            wave.status === 'active'   ? 'bg-blue-500' :
            wave.status === 'failed'   ? 'bg-red-500' :
            'bg-gray-400'
          }`}
          style={{ width: `${wave.progressPercent}%` }}
        />
      </div>

      {/* Item list */}
      <div className="space-y-1.5">
        {wave.items.map(item => (
          <div key={item.id} className="flex items-center justify-between bg-white/60 rounded px-2 py-1">
            <span className="text-xs text-gray-700 truncate max-w-[70%]" title={item.title}>
              {item.title}
            </span>
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${itemStatusBadge(item.status)}`}>
              {item.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface WaveProgressProps {
  projectId: string;
}

export function WaveProgress({ projectId }: WaveProgressProps) {
  const { data, error, isLoading } = useWaveProgress(projectId);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-gray-200 p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-1/3 mb-4" />
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 bg-gray-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600">
        Failed to load wave progress.
      </div>
    );
  }

  if (!data || data.totalWaves === 0) {
    return null; // No waves assigned yet — caller should gate rendering
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Wave Progress</h3>
        <span className="text-xs text-gray-500">
          {data.totalWaves} wave{data.totalWaves !== 1 ? 's' : ''}
          {data.currentWave !== null ? ` · Wave ${data.currentWave} active` : ''}
        </span>
      </div>
      {data.waves.map(wave => (
        <WaveCard key={wave.waveNumber} wave={wave} />
      ))}
    </div>
  );
}
```

### Step 6: Integrate into `app/projects/[id]/page.tsx`

Read the existing project detail page first to understand its structure, then integrate the component appropriately.

Add the import at the top of the file:
```typescript
import { WaveProgress } from '@/components/wave-progress';
```

Find where project work items or details are rendered. Add the `WaveProgress` component in a logical location (e.g., after the project status section, before or after the work items list). Gate it to only show when the project has `waveNumber`-assigned work items.

The simplest correct integration (adapt to existing page structure):

```tsx
{/* Show wave progress visualization if project has wave-assigned items */}
{project && (
  <WaveProgress projectId={project.id} />
)}
```

The component itself returns `null` when no wave data is available, so the gate can be simple. If the page already fetches work items and you can check for `waveNumber`, an explicit gate like the following is also acceptable:

```tsx
{project && workItems?.some(i => i.waveNumber !== null) && (
  <WaveProgress projectId={project.id} />
)}
```

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues to watch for:
- Missing imports (`isNotNull` from `drizzle-orm`, `WaveProgressData`/`WaveGroup` from `lib/types`)
- `waveNumber` column type in schema (may be `number | null` — cast appropriately)
- Shadcn/ui imports for components that may not exist (use plain Tailwind fallbacks)
- Page component prop types if `project.id` needs to be typed differently

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add WaveProgress dashboard component with wave grouping API"
git push origin feat/wave-progress-dashboard-component
gh pr create \
  --title "feat: add WaveProgress dashboard component" \
  --body "## Summary

Adds wave-level progress visualization to the project detail page.

## Changes

- **\`components/wave-progress.tsx\`** (new): React component showing per-wave status, progress bars, and item-level status badges. Uses \`useWaveProgress\` SWR hook.
- **\`lib/hooks.ts\`**: Added \`useWaveProgress(projectId)\` SWR hook fetching \`/api/work-items?projectId=X&groupByWave=true\` with 15s refresh.
- **\`app/api/work-items/route.ts\`**: Added \`groupByWave=true\` query param support. Groups items by \`waveNumber\`, computes per-wave status (pending/active/complete/failed), returns \`WaveProgressData\`.
- **\`app/projects/[id]/page.tsx\`**: Renders \`<WaveProgress projectId={project.id} />\` when project is loaded.
- **\`lib/types.ts\`**: Added \`WaveStatus\`, \`WaveGroup\`, \`WaveProgressData\` types (if not already present).

## Acceptance Criteria
- [x] WaveProgress component renders wave-by-wave visualization
- [x] \`useWaveProgress\` hook exported from \`lib/hooks.ts\`
- [x] GET /api/work-items supports \`groupByWave=true\`
- [x] WaveProgress integrated into project detail page
- [x] Builds with no type errors
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/wave-progress-dashboard-component
FILES CHANGED: [list files modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains to complete the feature]
```

### Escalation

If you hit a blocker you cannot resolve (e.g., `waveNumber` column missing from schema, `WaveProgressData` type conflicts, or project detail page has no accessible `project.id`), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "wave-progress-dashboard-component",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["components/wave-progress.tsx", "lib/hooks.ts", "app/api/work-items/route.ts", "app/projects/[id]/page.tsx"]
    }
  }'
```