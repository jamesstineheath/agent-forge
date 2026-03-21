<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- PRD-54 AC-5: Dashboard Bug Tracking Section with Severity Counts

## Metadata
- **Branch:** `feat/prd-54-ac-5-dashboard-bug-tracking-section`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/bugs/route.ts, lib/hooks.ts, app/(app)/page.tsx, components/bug-summary.tsx

## Context

Agent Forge dashboard is a Next.js App Router app. The home page (`app/(app)/page.tsx`) shows pipeline health, Work Items summary cards, and a Queue section. We need to add a Bug Tracking section between the Work Items cards and the Queue.

**Concurrent work warning:** AC-4 (`fix/prd-54-ac-4-auto-close-bugs-in-notion-when-work-it`) touches `lib/event-reactor.ts` and `lib/bugs.ts`. This handoff does **not** touch those files. If `lib/bugs.ts` already exists on `main` with a Notion query helper, prefer importing from it rather than duplicating Notion query logic — but do not modify it.

**Notion integration patterns:** The codebase uses `lib/notion.ts` for Notion API calls. The Notion API key is available via `process.env.NOTION_API_KEY`. The Bugs database ID is `023f3621-2885-468d-a8cf-2e0bd1458bb3`.

**Auth pattern for API routes:** Other dashboard API routes use NextAuth session auth (e.g. `getServerSession` / `auth()` from `lib/auth.ts` or `next-auth`). Check `app/api/pm-agent/route.ts` or `app/api/events/route.ts` for the exact pattern used and replicate it.

**SWR hooks pattern:** `lib/hooks.ts` exports hooks like `useWorkItems()` and `useEscalations()` using `useSWR` with a fetcher. Match that pattern exactly for `useBugs()`.

**UI patterns:**
- Cards use `card-elevated bg-surface-1` classes
- Section headers use `text-[10px] font-semibold uppercase tracking-widest`
- Icons from `lucide-react`
- Color conventions: Critical = red (`text-red-400`), High = amber (`text-amber-400`), Open = blue/neutral, Fixed = green (`text-green-400`)
- Badge on section headers matches the Queue badge style
- List items in Queue show: icon/badge, identifier, title, relative time

## Requirements

1. **`app/api/bugs/route.ts`** — GET endpoint that queries the Notion Bugs database (`023f3621-2885-468d-a8cf-2e0bd1458bb3`) and returns a JSON array. Each bug object must include: `title`, `status`, `severity`, `target_repo`, `bug_id`, `created_time`, `work_item_id`, `fix_pr_url`. Auth-gated using the same session auth pattern as other dashboard API routes. Returns `{ bugs: Bug[] }`.

2. **`lib/hooks.ts`** — Add `useBugs()` hook following the existing `useWorkItems` / `useEscalations` pattern. Calls `/api/bugs`, returns `{ bugs, isLoading, error }`.

3. **`components/bug-summary.tsx`** — A client component that accepts `bugs: Bug[]` and renders:
   - 4 summary cards: Critical count (red), High count (amber), Open total (all non-closed statuses), Fixed last 7 days (green)
   - A list of recent open bugs (status not in `['Fixed', "Won't Fix"]`), showing severity badge, bug ID, title, relative time
   - Uses `card-elevated bg-surface-1`, `lucide-react` icons, matches existing dashboard aesthetics

4. **`app/(app)/page.tsx`** — Add a "Bugs" section between the Work Items summary cards and the Queue section:
   - Section header with "Bugs" label and a count badge (count of open bugs)
   - Renders `<BugSummary bugs={bugs} />` (or equivalent)
   - Uses `useBugs()` hook; shows skeleton/loading state while loading
   - Wraps in ErrorBoundary if other sections do so

5. **No modifications** to `lib/bugs.ts` or `lib/event-reactor.ts` (concurrent AC-4 work).

6. **TypeScript must compile** with `npx tsc --noEmit` — no type errors.

7. **Build must pass** with `npm run build`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prd-54-ac-5-dashboard-bug-tracking-section
```

### Step 1: Study existing patterns

Before writing any code, read these files to understand exact patterns:

```bash
# Auth pattern for API routes
cat app/api/events/route.ts
# OR
cat app/api/pm-agent/route.ts

# SWR hooks pattern
cat lib/hooks.ts

# Dashboard home page structure
cat app/\(app\)/page.tsx

# Notion client usage
cat lib/notion.ts

# Check if lib/bugs.ts already exists (from AC-4 concurrent work)
cat lib/bugs.ts 2>/dev/null || echo "lib/bugs.ts does not exist yet"

# Existing component patterns (pick one similar component for reference)
ls components/
cat components/escalation-card.tsx 2>/dev/null | head -60
```

Take note of:
- Exact import path for `auth()` / `getServerSession`
- Exact `useSWR` fetcher pattern in `lib/hooks.ts`
- Where in `app/(app)/page.tsx` the Work Items cards end and the Queue section begins
- Whether `lib/bugs.ts` exports a `queryBugs()` or similar helper you can reuse

### Step 2: Define the Bug type

Add the `Bug` type. Check if `lib/types.ts` already defines a `Bug` interface (from AC-4). If it does, import from there. If not, define it locally in `app/api/bugs/route.ts` and export it, then import in `components/bug-summary.tsx`.

```typescript
// Bug type (define in lib/types.ts if not already present, or locally in the API route)
export interface Bug {
  bug_id: string;
  title: string;
  status: string;
  severity: string;
  target_repo: string;
  created_time: string;
  work_item_id?: string;
  fix_pr_url?: string;
}
```

**Important:** Do NOT modify `lib/bugs.ts` if it exists. If `lib/types.ts` already has a `Bug` type, use it. Only add to `lib/types.ts` if `Bug` is not already defined there.

### Step 3: Create `app/api/bugs/route.ts`

Create the API route. Use the Notion database query API directly (via fetch) or via the `@notionhq/client` SDK — whichever pattern `lib/notion.ts` uses.

```typescript
// app/api/bugs/route.ts
import { NextResponse } from 'next/server';
// Import auth using the same pattern as other routes — check Step 1 findings.
// Example (adjust based on what you found):
// import { auth } from '@/lib/auth';

const BUGS_DB_ID = '023f3621-2885-468d-a8cf-2e0bd1458bb3';

export async function GET() {
  // 1. Auth gate — same pattern as other dashboard API routes
  // const session = await auth();
  // if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // 2. Query Notion Bugs database
  // Use lib/notion.ts helpers if available, else fetch directly:
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) {
    return NextResponse.json({ error: 'NOTION_API_KEY not configured' }, { status: 500 });
  }

  const res = await fetch(`https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${notionKey}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sorts: [{ property: 'Created time', direction: 'descending' }],
      page_size: 50,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('[bugs API] Notion query failed:', text);
    return NextResponse.json({ error: 'Failed to query Notion' }, { status: 500 });
  }

  const data = await res.json();

  // 3. Map Notion pages to Bug objects
  // IMPORTANT: Inspect the actual property names from a real Notion response.
  // The property names below are likely candidates — adjust to match real schema.
  const bugs = (data.results ?? []).map((page: any) => {
    const props = page.properties;
    return {
      bug_id: page.id,
      title: props['Name']?.title?.[0]?.plain_text
        ?? props['Title']?.title?.[0]?.plain_text
        ?? '(untitled)',
      status: props['Status']?.select?.name
        ?? props['Status']?.status?.name
        ?? 'Unknown',
      severity: props['Severity']?.select?.name ?? 'Unknown',
      target_repo: props['Target Repo']?.select?.name
        ?? props['Target Repo']?.rich_text?.[0]?.plain_text
        ?? '',
      created_time: page.created_time,
      work_item_id: props['Work Item ID']?.rich_text?.[0]?.plain_text
        ?? props['Work Item']?.rich_text?.[0]?.plain_text
        ?? undefined,
      fix_pr_url: props['Fix PR URL']?.url
        ?? props['Fix PR']?.url
        ?? undefined,
    };
  });

  return NextResponse.json({ bugs });
}
```

**Note on Notion property names:** The exact property names depend on the actual database schema. If the Notion DB schema is documented in `lib/notion.ts` or elsewhere, use those names. If you can inspect a response, do so. The mapping above uses common fallbacks — make sure the property name logic handles the real data.

### Step 4: Add `useBugs()` to `lib/hooks.ts`

Open `lib/hooks.ts` and add the `useBugs` hook following the existing pattern. Do not modify any existing hooks — append only.

```typescript
// Add to lib/hooks.ts (after existing hooks)
// Import Bug type at the top if needed:
// import type { Bug } from './types';  // or wherever you defined it

export function useBugs() {
  const { data, error, isLoading } = useSWR<{ bugs: Bug[] }>(
    '/api/bugs',
    fetcher  // use the same fetcher function already defined in this file
  );
  return {
    bugs: data?.bugs ?? [],
    isLoading,
    error,
  };
}
```

Adjust the import for `Bug` and the `fetcher` reference to match exactly what's in the file.

### Step 5: Create `components/bug-summary.tsx`

```typescript
// components/bug-summary.tsx
'use client';

import { Bug } from '@/lib/types'; // adjust path if needed
import { AlertCircle, AlertTriangle, Bug as BugIcon, CheckCircle2 } from 'lucide-react';

interface BugSummaryProps {
  bugs: Bug[];
}

const OPEN_STATUSES_EXCLUDE = ['Fixed', "Won't Fix", 'Wont Fix'];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function severityBadgeClass(severity: string): string {
  switch (severity?.toLowerCase()) {
    case 'critical': return 'bg-red-500/20 text-red-400 border border-red-500/30';
    case 'high':     return 'bg-amber-500/20 text-amber-400 border border-amber-500/30';
    case 'medium':   return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
    case 'low':      return 'bg-blue-500/20 text-blue-400 border border-blue-500/30';
    default:         return 'bg-surface-2 text-text-2 border border-border';
  }
}

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function BugSummary({ bugs }: BugSummaryProps) {
  const openBugs = bugs.filter(b => !OPEN_STATUSES_EXCLUDE.includes(b.status));
  const criticalCount = openBugs.filter(b => b.severity?.toLowerCase() === 'critical').length;
  const highCount = openBugs.filter(b => b.severity?.toLowerCase() === 'high').length;
  const fixedLast7d = bugs.filter(b => {
    const isFixed = b.status === 'Fixed';
    const isRecent = Date.now() - new Date(b.created_time).getTime() < SEVEN_DAYS_MS;
    return isFixed && isRecent;
  }).length;

  const recentOpen = openBugs.slice(0, 10);

  return (
    <div className="space-y-3">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {/* Critical */}
        <div className="card-elevated bg-surface-1 p-3 rounded-lg flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-2">Critical</span>
          </div>
          <span className="text-2xl font-bold text-red-400">{criticalCount}</span>
        </div>

        {/* High */}
        <div className="card-elevated bg-surface-1 p-3 rounded-lg flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-2">High</span>
          </div>
          <span className="text-2xl font-bold text-amber-400">{highCount}</span>
        </div>

        {/* Open total */}
        <div className="card-elevated bg-surface-1 p-3 rounded-lg flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <BugIcon className="w-3.5 h-3.5 text-text-2 shrink-0" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-2">Open</span>
          </div>
          <span className="text-2xl font-bold text-text-1">{openBugs.length}</span>
        </div>

        {/* Fixed last 7d */}
        <div className="card-elevated bg-surface-1 p-3 rounded-lg flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-2">Fixed 7d</span>
          </div>
          <span className="text-2xl font-bold text-green-400">{fixedLast7d}</span>
        </div>
      </div>

      {/* Recent open bugs list */}
      {recentOpen.length === 0 ? (
        <p className="text-[11px] text-text-3 py-2 text-center">No open bugs</p>
      ) : (
        <div className="space-y-1">
          {recentOpen.map(bug => (
            <div
              key={bug.bug_id}
              className="card-elevated bg-surface-1 px-3 py-2 rounded-lg flex items-center gap-2"
            >
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 ${severityBadgeClass(bug.severity)}`}>
                {bug.severity ?? '?'}
              </span>
              <span className="text-[10px] font-mono text-text-3 shrink-0 hidden sm:block">
                {bug.bug_id.slice(0, 8)}
              </span>
              <span className="text-[12px] text-text-1 flex-1 truncate">{bug.title}</span>
              <span className="text-[10px] text-text-3 shrink-0">{relativeTime(bug.created_time)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Step 6: Update `app/(app)/page.tsx`

Open the page and locate the boundary between Work Items summary cards and the Queue section. Insert the Bugs section between them.

```typescript
// Add these imports at the top of app/(app)/page.tsx:
import { BugSummary } from '@/components/bug-summary';
// Add useBugs to the existing hooks import line, e.g.:
// import { useWorkItems, useEscalations, useBugs } from '@/lib/hooks';

// Inside the component, add:
const { bugs, isLoading: bugsLoading } = useBugs();

// Then in JSX, insert BETWEEN the Work Items cards section and the Queue section:
```

The JSX to insert — use the exact class names and structural patterns you found when reading the existing page:

```tsx
{/* Bugs Section */}
<section className="space-y-3">
  <div className="flex items-center gap-2">
    <h2 className="text-[10px] font-semibold uppercase tracking-widest text-text-2">Bugs</h2>
    <span className="inline-flex items-center justify-center rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-text-2 min-w-[20px]">
      {bugs.filter(b => !['Fixed', "Won't Fix", 'Wont Fix'].includes(b.status)).length}
    </span>
  </div>
  {bugsLoading ? (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="card-elevated bg-surface-1 p-3 rounded-lg h-16 animate-pulse" />
      ))}
    </div>
  ) : (
    <BugSummary bugs={bugs} />
  )}
</section>
```

**Important:** Match the exact spacing, container classes, and structural wrapping used by the surrounding Work Items and Queue sections in the real file. If those sections are wrapped in a different container structure, match it.

### Step 7: Verify TypeScript and build

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `Bug` type not exported/imported correctly — ensure a single source of truth
- Notion response property access on `any` typed data — add explicit `any` annotations or type guards
- `useSWR` generic type mismatch — check the fetcher return type

```bash
npm run build
```

If the build fails due to the Notion API call at build time (SSG/SSR), ensure the API route is dynamic:
```typescript
// Add to app/api/bugs/route.ts if needed:
export const dynamic = 'force-dynamic';
```

### Step 8: Smoke test (optional but recommended)

```bash
npm run dev
# Navigate to http://localhost:3000 and check the dashboard home page
# Verify the Bugs section appears between Work Items and Queue
# Check browser console for any errors
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: PRD-54 AC-5 — dashboard bug tracking section with severity counts"
git push origin feat/prd-54-ac-5-dashboard-bug-tracking-section
gh pr create \
  --title "feat: PRD-54 AC-5 — dashboard bug tracking section with severity counts" \
  --body "## Summary

Adds a Bug Tracking section to the dashboard home page between the Work Items cards and the Queue section.

## Changes
- \`app/api/bugs/route.ts\` — GET endpoint querying Notion Bugs DB (\`023f3621-2885-468d-a8cf-2e0bd1458bb3\`), session-auth-gated
- \`lib/hooks.ts\` — Added \`useBugs()\` SWR hook
- \`components/bug-summary.tsx\` — New component: 4 severity-count cards + recent open bugs list
- \`app/(app)/page.tsx\` — Bugs section inserted between Work Items and Queue

## Notes
- Does not touch \`lib/bugs.ts\` or \`lib/event-reactor.ts\` (reserved for concurrent AC-4 work)
- If \`Bug\` type is already defined in \`lib/types.ts\` by AC-4, imports from there; otherwise defines it locally

## Acceptance Criteria
- [x] Bugs section visible on dashboard home between Work Items and Queue
- [x] Critical, High, Open, Fixed-7d counts displayed
- [x] Recent open bugs list with severity badge, ID, title, relative time
- [x] Loading skeleton while fetching
- [x] TypeScript compiles clean
- [x] Build passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prd-54-ac-5-dashboard-bug-tracking-section
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g. "Notion property names need verification against real DB schema", "Bug type conflicts with lib/bugs.ts from AC-4"]
```

## Escalation

If you hit an unresolvable blocker (e.g. Notion DB property names are completely unknown and the API returns 404, or `Bug` type from AC-4 conflicts in an unresolvable way, or the dashboard page structure is too different from the instructions to safely insert the section):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-54-ac-5",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/bugs/route.ts", "lib/hooks.ts", "components/bug-summary.tsx", "app/(app)/page.tsx"]
    }
  }'
```