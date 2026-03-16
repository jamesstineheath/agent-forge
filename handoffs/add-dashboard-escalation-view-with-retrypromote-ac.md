# Agent Forge -- Add Dashboard Escalation View with Retry/Promote Actions

## Metadata
- **Branch:** `feat/escalation-dashboard-view`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/work-items/escalated/page.tsx, app/api/work-items/[id]/retry/route.ts

## Context

Agent Forge is a dev orchestration platform (Next.js App Router on Vercel). Work items can enter an `escalated` status when the executing agent encounters a blocker it cannot resolve autonomously. Currently there is no dedicated UI for managing these escalated items — they can only be seen in the general work items list.

This task adds:
1. A new page at `/work-items/escalated` listing all escalated items with context (reason, timestamps, budget, repo, etc.)
2. Two action buttons per item:
   - **Retry**: transitions item back to `filed` status with an optional budget override, so the orchestrator can re-dispatch it
   - **Promote**: surfaces the work item description to facilitate creating a Notion project manually
3. A POST API endpoint `POST /api/work-items/[id]/retry` that performs the status transition with validation

### Relevant existing patterns

From `lib/work-items.ts` and `lib/types.ts`, work items have this shape (inferred from CLAUDE.md and system map):
- Status lifecycle: `filed → ready → queued → generating → executing → reviewing → merged` plus `escalated` and `parked`
- Fields relevant here: `id`, `title`, `description`, `status`, `targetRepo`, `triggeredBy`, `budget`, `escalationReason`, `escalatedAt`, `createdAt`

From recent PRs, the dashboard uses:
- `lib/hooks.ts` for SWR data fetching
- `components/work-item-card.tsx` for item display
- `app/(app)/work-items/page.tsx` as the main work items page pattern

Auth is enforced via Auth.js v5 on all `(app)` routes — the layout handles this automatically.

Storage is via `lib/storage.ts` (Vercel Blob in prod, local files in dev).

## Requirements

1. `app/(app)/work-items/escalated/page.tsx` exists and renders at `/work-items/escalated`
2. Page fetches and displays all work items with `status === 'escalated'`
3. Each item card shows: description, target repo, triggeredBy, escalation reason, escalated timestamp, original budget
4. Each item has a **Retry** button that opens an inline form with an optional budget override input and a confirm button
5. Retry confirm calls `POST /api/work-items/[id]/retry` with optional `{ budget: number }` body
6. After successful retry, item disappears from the escalated list (re-fetch or optimistic update)
7. Each item has a **Promote** button that expands a panel showing the item description in a copyable textarea (no Notion API call required — placeholder UI only)
8. `app/api/work-items/[id]/retry/route.ts` handles `POST /api/work-items/[id]/retry`
9. Retry endpoint validates item exists and has `status === 'escalated'`, returns `400` otherwise
10. Retry endpoint sets `status` to `'filed'` and optionally overrides `budget` if provided in request body
11. Retry endpoint is auth-protected (uses Auth.js session)
12. Navigation sidebar includes a link to `/work-items/escalated` (or the page is reachable from the main work items page)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/escalation-dashboard-view
```

### Step 1: Understand existing types and storage patterns

Read the following files to understand exact type shapes and storage helpers before writing any code:

```bash
cat lib/types.ts
cat lib/work-items.ts
cat lib/storage.ts
cat lib/hooks.ts
cat app/(app)/work-items/page.tsx
cat components/work-item-card.tsx
cat components/sidebar.tsx
cat app/api/work-items/route.ts  # or similar, to see auth pattern
```

Note:
- The exact field names for escalation data (e.g. `escalationReason` vs `escalation_reason`, `escalatedAt` vs `escalation.timestamp`)
- How `updateWorkItem` or equivalent is called to change status
- How auth is checked in API routes (look for `getServerSession` or `auth()` from `lib/auth.ts`)
- The SWR hook pattern used in existing pages

### Step 2: Create the retry API endpoint

Create `app/api/work-items/[id]/retry/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
// Import work item helpers — adjust import based on what you find in Step 1
// e.g.: import { getWorkItem, updateWorkItem } from '@/lib/work-items'

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Auth check — use whatever pattern existing API routes use
  const session = await auth()
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = params

  // Fetch the work item
  const item = await getWorkItem(id)
  if (!item) {
    return NextResponse.json({ error: 'Work item not found' }, { status: 404 })
  }

  // Validate it is in 'escalated' status
  if (item.status !== 'escalated') {
    return NextResponse.json(
      { error: `Cannot retry item with status '${item.status}'. Item must be in 'escalated' status.` },
      { status: 400 }
    )
  }

  // Parse optional budget override
  let budgetOverride: number | undefined
  try {
    const body = await request.json()
    if (body.budget !== undefined) {
      const parsed = Number(body.budget)
      if (isNaN(parsed) || parsed <= 0) {
        return NextResponse.json({ error: 'budget must be a positive number' }, { status: 400 })
      }
      budgetOverride = parsed
    }
  } catch {
    // No body or invalid JSON — treat as no budget override
  }

  // Transition to 'filed', optionally update budget
  const updates: Partial<typeof item> = {
    status: 'filed',
    // Clear escalation fields if they exist on the type
    // escalationReason: undefined,  -- only if the type supports it
  }
  if (budgetOverride !== undefined) {
    updates.budget = budgetOverride
  }

  const updated = await updateWorkItem(id, updates)

  return NextResponse.json(updated)
}
```

**Important**: Adjust the import paths and field names based on what you find in Step 1. If `updateWorkItem` doesn't exist, use whatever mutation pattern the codebase uses (direct Blob write via `storage.ts`, etc.).

### Step 3: Create the escalated items page

Create `app/(app)/work-items/escalated/page.tsx` as a client component (since it needs interactive retry/promote forms):

```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
// Adjust SWR import based on lib/hooks.ts patterns
import useSWR from 'swr'

// Fetcher — use whatever pattern lib/hooks.ts uses
const fetcher = (url: string) => fetch(url).then(r => r.json())

export default function EscalatedItemsPage() {
  const router = useRouter()
  // Fetch all work items and filter for escalated status
  // OR use a dedicated endpoint if one exists for filtered queries
  const { data, error, mutate } = useSWR('/api/work-items?status=escalated', fetcher)

  if (error) return <div className="p-6 text-red-600">Failed to load escalated items.</div>
  if (!data) return <div className="p-6 text-gray-500">Loading...</div>

  // Filter client-side if the API doesn't support ?status= filtering
  const escalatedItems = Array.isArray(data)
    ? data.filter((item: any) => item.status === 'escalated')
    : (data.items ?? []).filter((item: any) => item.status === 'escalated')

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Escalated Items</h1>
        <p className="text-gray-500 mt-1">
          {escalatedItems.length} item{escalatedItems.length !== 1 ? 's' : ''} awaiting resolution
        </p>
      </div>

      {escalatedItems.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg">No escalated items</p>
          <p className="text-sm mt-2">All clear — no items need manual intervention.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {escalatedItems.map((item: any) => (
            <EscalatedItemCard key={item.id} item={item} onUpdated={mutate} />
          ))}
        </div>
      )}
    </div>
  )
}

function EscalatedItemCard({ item, onUpdated }: { item: any; onUpdated: () => void }) {
  const [retryOpen, setRetryOpen] = useState(false)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [budgetOverride, setBudgetOverride] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)

  const handleRetry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      const body: Record<string, unknown> = {}
      if (budgetOverride.trim()) {
        body.budget = parseFloat(budgetOverride)
      }

      const res = await fetch(`/api/work-items/${item.id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const err = await res.json()
        setRetryError(err.error ?? 'Retry failed')
        return
      }

      // Success — refresh list
      onUpdated()
    } catch (e) {
      setRetryError('Network error')
    } finally {
      setRetrying(false)
    }
  }

  // Resolve field names defensively — escalation data may be nested or flat
  const escalationReason =
    item.escalationReason ?? item.escalation?.reason ?? item.escalation_reason ?? '—'
  const escalatedAt =
    item.escalatedAt ?? item.escalation?.createdAt ?? item.escalation?.timestamp ?? null
  const budget = item.budget ?? item.maxBudget ?? '—'
  const triggeredBy = item.triggeredBy ?? item.triggered_by ?? '—'
  const targetRepo = item.targetRepo ?? item.target_repo ?? item.repo ?? '—'

  return (
    <div className="border border-orange-200 rounded-lg bg-orange-50 p-5 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-gray-900 truncate">{item.title ?? item.id}</h2>
          <p className="text-sm text-gray-600 mt-1 line-clamp-3">{item.description ?? '—'}</p>
        </div>
        <span className="shrink-0 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-300">
          escalated
        </span>
      </div>

      {/* Metadata grid */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <dt className="text-gray-500">Target Repo</dt>
          <dd className="text-gray-900 font-mono text-xs">{targetRepo}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Triggered By</dt>
          <dd className="text-gray-900">{triggeredBy}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Original Budget</dt>
          <dd className="text-gray-900">${budget}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Escalated At</dt>
          <dd className="text-gray-900">
            {escalatedAt ? new Date(escalatedAt).toLocaleString() : '—'}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="text-gray-500">Escalation Reason</dt>
          <dd className="text-gray-900 mt-0.5 bg-white border border-orange-200 rounded p-2 text-sm">
            {escalationReason}
          </dd>
        </div>
      </dl>

      {/* Action buttons */}
      <div className="flex gap-3 pt-1">
        <button
          onClick={() => { setRetryOpen(!retryOpen); setPromoteOpen(false) }}
          className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          Retry
        </button>
        <button
          onClick={() => { setPromoteOpen(!promoteOpen); setRetryOpen(false) }}
          className="px-3 py-1.5 rounded-md bg-purple-600 text-white text-sm font-medium hover:bg-purple-700 transition-colors"
        >
          Promote to Project
        </button>
      </div>

      {/* Retry panel */}
      {retryOpen && (
        <div className="bg-white border border-blue-200 rounded-md p-4 space-y-3">
          <p className="text-sm text-gray-700 font-medium">Retry — transition back to <code className="bg-gray-100 px-1 rounded">filed</code></p>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Budget override (optional, leave blank to keep ${budget})
            </label>
            <div className="flex items-center gap-2">
              <span className="text-gray-500 text-sm">$</span>
              <input
                type="number"
                min="0"
                step="1"
                placeholder={String(budget)}
                value={budgetOverride}
                onChange={e => setBudgetOverride(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-24 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          {retryError && (
            <p className="text-sm text-red-600">{retryError}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {retrying ? 'Retrying…' : 'Confirm Retry'}
            </button>
            <button
              onClick={() => { setRetryOpen(false); setRetryError(null); setBudgetOverride('') }}
              className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Promote panel */}
      {promoteOpen && (
        <div className="bg-white border border-purple-200 rounded-md p-4 space-y-3">
          <p className="text-sm text-gray-700 font-medium">Promote to Project</p>
          <p className="text-xs text-gray-500">
            Copy the description below and paste it into a new Notion project plan.
          </p>
          <textarea
            readOnly
            value={item.description ?? ''}
            rows={5}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm font-mono bg-gray-50 focus:outline-none resize-y"
            onClick={e => (e.target as HTMLTextAreaElement).select()}
          />
          <p className="text-xs text-gray-400">Click the textarea to select all text for copying.</p>
          <button
            onClick={() => setPromoteOpen(false)}
            className="px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      )}
    </div>
  )
}
```

### Step 4: Add navigation link to the sidebar (or work items page)

Read `components/sidebar.tsx` to find where work item nav links live, then add a link to `/work-items/escalated`.

If the sidebar has a section like:
```tsx
{ href: '/work-items', label: 'Work Items' }
```

Add:
```tsx
{ href: '/work-items/escalated', label: 'Escalated' }
```

Alternatively, if the main work items page (`app/(app)/work-items/page.tsx`) has tabs or a sub-nav, add an "Escalated" tab there that links to `/work-items/escalated`.

Use whichever approach matches the existing navigation pattern.

### Step 5: Verify API endpoint handles missing/unexpected body gracefully

Confirm that `POST /api/work-items/[id]/retry` with:
- Empty body → sets status to `filed`, keeps original budget ✓
- `{ "budget": 10 }` → sets status to `filed`, budget = 10 ✓  
- `{ "budget": -5 }` → returns 400 ✓
- Item with status `filed` → returns 400 with clear message ✓

These are logic checks — trace through the code manually.

### Step 6: Check for TypeScript errors and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors. Common issues to watch for:
- `params` in Next.js App Router route handlers may need to be `Promise<{ id: string }>` depending on Next.js version — check existing route handlers in `app/api/` for the pattern used
- Import paths for `getWorkItem`, `updateWorkItem`, `auth` — verify these exist and are exported

If the Next.js version uses async params (Next 15+), update the route handler:
```typescript
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  // ...
}
```

Check existing route handlers like `app/api/work-items/[id]/route.ts` (if it exists) for the correct pattern.

### Step 7: Verification

```bash
npx tsc --noEmit
npm run build
```

Confirm:
- No TypeScript errors
- Build succeeds
- Both new files are present:
  - `app/(app)/work-items/escalated/page.tsx`
  - `app/api/work-items/[id]/retry/route.ts`

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add dashboard escalation view with retry/promote actions

- Add /work-items/escalated page listing all escalated items
- Each item shows description, repo, triggeredBy, escalation reason, budget, timestamps
- Retry action: optional budget override, transitions item back to 'filed'
- Promote action: surfaces description in copyable textarea for Notion project creation
- POST /api/work-items/[id]/retry endpoint with escalated-status validation
- Add navigation link to escalated view"
git push origin feat/escalation-dashboard-view
gh pr create \
  --title "feat: add dashboard escalation view with retry/promote actions" \
  --body "## Summary

Adds a dedicated UI for managing escalated work items.

### New files
- \`app/(app)/work-items/escalated/page.tsx\` — page at \`/work-items/escalated\` listing all escalated items with inline Retry and Promote panels
- \`app/api/work-items/[id]/retry/route.ts\` — POST endpoint to transition escalated item back to \`filed\` with optional budget override

### Features
- Displays: description, target repo, triggeredBy, escalation reason, escalated timestamp, original budget
- **Retry**: opens inline form with optional budget override input; calls POST /api/work-items/[id]/retry; item disappears from list on success
- **Promote**: opens inline panel with copyable textarea of the item description (placeholder for future Notion integration)
- API validates item must be in \`escalated\` status (returns 400 otherwise)
- API is auth-protected

### Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/escalation-dashboard-view
FILES CHANGED: [list of files modified]
SUMMARY: [what was done]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g. "retry endpoint created but page not yet created"]
```

## Escalation Protocol

If blocked on ambiguous type shapes, missing exports, or architectural decisions:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<this-work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/(app)/work-items/escalated/page.tsx", "app/api/work-items/[id]/retry/route.ts"]
    }
  }'
```