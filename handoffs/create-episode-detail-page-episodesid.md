# Agent Forge -- Create Episode Detail Page (/episodes/[id])

## Metadata
- **Branch:** `feat/episode-detail-page`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/episodes/[id]/page.tsx

## Context

Agent Forge is a Next.js 16 App Router application on Vercel. The codebase has a pattern of detail pages for various entities (work items, projects, etc.). This task adds an episode detail page for time-travel debugging of past agent behavior.

Episodes are fetched via the `useEpisode` hook from `lib/hooks.ts`. The page must render all structured fields in organized sections consistent with existing detail pages.

**No conflicts with concurrent work**: the concurrent branch (`fix/add-shared-types-for-model-routing-tasktype-workit`) only touches `lib/types.ts`, which this task does not modify.

### Existing Patterns to Follow

Before implementing, read these files to understand conventions:
- `lib/hooks.ts` — find the `useEpisode` hook signature and what it returns
- `app/work-items/[id]/page.tsx` or `app/episodes/page.tsx` — understand the existing detail page structure, styling, and component patterns
- `lib/types.ts` — understand the `Episode` type shape (fields: `taskDescription`, `repoSlug`, `tags`, `approach`, `outcome`, `outcomeDetail`, `insights`, `filesChanged`, `workItemId`, `projectId`, `createdAt`, `updatedAt`, `id`)

## Requirements

1. Create `app/episodes/[id]/page.tsx` as a Next.js App Router page
2. Use the `useEpisode` hook from `lib/hooks.ts` to fetch the episode by `id`
3. Render a **Task Context** section with: `taskDescription`, `repoSlug`, `tags`
4. Render an **Approach** section with full (non-truncated) `approach` text
5. Render an **Outcome** section with a status badge for `outcome` and full `outcomeDetail` text
6. Render an **Insights** section as a bulleted list of `insights`
7. Render a **Files Changed** section as a list of `filesChanged`
8. Render a **Links** section: link to `/work-items/[workItemId]` if `workItemId` present; link to `/projects/[projectId]` if `projectId` present
9. Render a **Metadata** section with `createdAt`, `updatedAt`, and `id`
10. Include a back button that navigates to `/episodes`
11. Show a loading state while the episode is being fetched
12. Show a 404/not-found state if the episode is not found
13. Show a generic error state for other errors
14. Style consistent with existing detail pages in the repo
15. Project compiles successfully (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/episode-detail-page
```

### Step 1: Read existing patterns

Read the following files to understand conventions before writing any code:

```bash
cat lib/hooks.ts
cat lib/types.ts
# Find existing detail pages for style reference:
ls app/work-items/
cat app/work-items/\[id\]/page.tsx 2>/dev/null || true
ls app/episodes/ 2>/dev/null || true
cat app/episodes/page.tsx 2>/dev/null || true
```

Key things to extract:
- The exact signature of `useEpisode(id: string)` — what it returns (data, loading/error shape)
- The `Episode` type definition (all fields and their TypeScript types)
- What component primitives are used (e.g., custom `Badge`, `Card`, `Button` components or plain Tailwind)
- What layout wrapper is used (e.g., a shared `PageLayout` or `Container` component)
- How back buttons are implemented (e.g., `<Link href="...">`, `router.back()`)
- How loading states are rendered
- How 404s are handled (e.g., `notFound()` from `next/navigation`, or inline JSX)

### Step 2: Create the episode detail page

Create `app/episodes/[id]/page.tsx`. The implementation below is a template — **adapt it based on what you observed in Step 1** to match existing conventions exactly.

```tsx
'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEpisode } from '@/lib/hooks';

// Adapt these imports to match what's actually used in the codebase
// (e.g., Badge, Card, Button components if they exist)

export default function EpisodeDetailPage() {
  const params = useParams();
  const id = params?.id as string;
  const { episode, isLoading, error } = useEpisode(id);
  // NOTE: Adapt the destructured names to match what useEpisode actually returns

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-gray-500">Loading episode...</p>
      </div>
    );
  }

  if (error) {
    // Check if it's a 404 — adapt to actual error shape from useEpisode
    const is404 =
      (error as any)?.status === 404 ||
      (error as any)?.message?.includes('not found');

    if (is404) {
      return (
        <div className="max-w-4xl mx-auto px-4 py-8">
          <Link href="/episodes" className="text-sm text-blue-600 hover:underline mb-6 inline-block">
            ← Back to Episodes
          </Link>
          <div className="text-center py-16">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Episode Not Found</h1>
            <p className="text-gray-500">No episode with ID <code className="font-mono">{id}</code> exists.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/episodes" className="text-sm text-blue-600 hover:underline mb-6 inline-block">
          ← Back to Episodes
        </Link>
        <div className="text-center py-16">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Error Loading Episode</h1>
          <p className="text-gray-500">{(error as any)?.message ?? 'An unexpected error occurred.'}</p>
        </div>
      </div>
    );
  }

  if (!episode) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Link href="/episodes" className="text-sm text-blue-600 hover:underline mb-6 inline-block">
          ← Back to Episodes
        </Link>
        <div className="text-center py-16">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Episode Not Found</h1>
          <p className="text-gray-500">No episode with ID <code className="font-mono">{id}</code> exists.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Back navigation */}
      <Link href="/episodes" className="text-sm text-blue-600 hover:underline mb-6 inline-block">
        ← Back to Episodes
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-8">Episode Detail</h1>

      <div className="space-y-8">
        {/* Task Context */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Task Context</h2>
          <dl className="space-y-2">
            <div>
              <dt className="text-sm font-medium text-gray-500">Task Description</dt>
              <dd className="mt-1 text-gray-900 whitespace-pre-wrap">{episode.taskDescription ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-gray-500">Repository</dt>
              <dd className="mt-1 text-gray-900">{episode.repoSlug ?? '—'}</dd>
            </div>
            {episode.tags && episode.tags.length > 0 && (
              <div>
                <dt className="text-sm font-medium text-gray-500">Tags</dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  {episode.tags.map((tag: string) => (
                    <span
                      key={tag}
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800"
                    >
                      {tag}
                    </span>
                  ))}
                </dd>
              </div>
            )}
          </dl>
        </section>

        {/* Approach */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Approach</h2>
          <p className="text-gray-900 whitespace-pre-wrap">{episode.approach ?? '—'}</p>
        </section>

        {/* Outcome */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Outcome</h2>
          <div className="space-y-2">
            {episode.outcome && (
              <div>
                <dt className="text-sm font-medium text-gray-500 mb-1">Status</dt>
                <OutcomeBadge outcome={episode.outcome} />
              </div>
            )}
            {episode.outcomeDetail && (
              <div>
                <dt className="text-sm font-medium text-gray-500 mt-2">Detail</dt>
                <dd className="mt-1 text-gray-900 whitespace-pre-wrap">{episode.outcomeDetail}</dd>
              </div>
            )}
          </div>
        </section>

        {/* Insights */}
        {episode.insights && episode.insights.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Insights</h2>
            <ul className="list-disc list-inside space-y-1">
              {episode.insights.map((insight: string, i: number) => (
                <li key={i} className="text-gray-900">{insight}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Files Changed */}
        {episode.filesChanged && episode.filesChanged.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Files Changed</h2>
            <ul className="space-y-1">
              {episode.filesChanged.map((file: string, i: number) => (
                <li key={i} className="font-mono text-sm text-gray-700 bg-gray-50 px-2 py-1 rounded">
                  {file}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Links */}
        {(episode.workItemId || episode.projectId) && (
          <section>
            <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Links</h2>
            <ul className="space-y-1">
              {episode.workItemId && (
                <li>
                  <Link
                    href={`/work-items/${episode.workItemId}`}
                    className="text-blue-600 hover:underline text-sm"
                  >
                    → Work Item: {episode.workItemId}
                  </Link>
                </li>
              )}
              {episode.projectId && (
                <li>
                  <Link
                    href={`/projects/${episode.projectId}`}
                    className="text-blue-600 hover:underline text-sm"
                  >
                    → Project: {episode.projectId}
                  </Link>
                </li>
              )}
            </ul>
          </section>
        )}

        {/* Metadata */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-1">Metadata</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex gap-4">
              <dt className="font-medium text-gray-500 w-24 flex-shrink-0">ID</dt>
              <dd className="font-mono text-gray-900 break-all">{episode.id}</dd>
            </div>
            <div className="flex gap-4">
              <dt className="font-medium text-gray-500 w-24 flex-shrink-0">Created</dt>
              <dd className="text-gray-900">
                {episode.createdAt ? new Date(episode.createdAt).toLocaleString() : '—'}
              </dd>
            </div>
            <div className="flex gap-4">
              <dt className="font-medium text-gray-500 w-24 flex-shrink-0">Updated</dt>
              <dd className="text-gray-900">
                {episode.updatedAt ? new Date(episode.updatedAt).toLocaleString() : '—'}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  // Adapt color mapping to match how outcome statuses are styled elsewhere in the app
  const colorMap: Record<string, string> = {
    success: 'bg-green-100 text-green-800',
    failure: 'bg-red-100 text-red-800',
    partial: 'bg-yellow-100 text-yellow-800',
    unknown: 'bg-gray-100 text-gray-800',
  };
  const className = colorMap[outcome?.toLowerCase()] ?? 'bg-gray-100 text-gray-800';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${className}`}>
      {outcome}
    </span>
  );
}
```

> **Important adaptation notes for the executor:**
> - If `useEpisode` returns `{ data, isLoading, error }` or `{ episode, loading, error }` — match exactly what the hook returns.
> - If a shared `PageLayout`, `Container`, or similar wrapper component is used in other detail pages, wrap this page's content with it.
> - If the project uses a shared `Badge` component (e.g., `components/ui/badge.tsx`), use it instead of the inline `OutcomeBadge`.
> - If `'use client'` is not needed (i.e., the hook supports server-side fetching or uses React Query), remove it and adapt accordingly.
> - If `outcome` values differ from `success/failure/partial/unknown`, update `OutcomeBadge` to match what's in `lib/types.ts`.
> - Match the exact field names from the `Episode` type in `lib/types.ts` — do not assume field names match this template exactly.

### Step 3: Verify the page compiles

```bash
npx tsc --noEmit
```

Fix any TypeScript errors. Common issues:
- Wrong destructured names from `useEpisode` — check `lib/hooks.ts`
- Missing or wrong `Episode` field names — check `lib/types.ts`
- Import path issues — use `@/lib/hooks` if the project uses path aliases (check `tsconfig.json`)

### Step 4: Run the build

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add episode detail page at /episodes/[id]"
git push origin feat/episode-detail-page
gh pr create \
  --title "feat: add episode detail page (/episodes/[id])" \
  --body "## Summary

Adds the episode detail page at \`/episodes/[id]\` for time-travel debugging of past agent behavior.

## Changes
- \`app/episodes/[id]/page.tsx\` — new page rendering all Episode fields

## Sections rendered
- **Task Context**: taskDescription, repoSlug, tags
- **Approach**: full approach text
- **Outcome**: status badge + outcomeDetail
- **Insights**: bulleted list
- **Files Changed**: file list
- **Links**: work item and project links (when IDs present)
- **Metadata**: id, createdAt, updatedAt

## Navigation
- Back button to /episodes
- Loading, 404, and error states

## Testing
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
BRANCH: feat/episode-detail-page
FILES CHANGED: app/episodes/[id]/page.tsx
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked on an unresolvable issue (e.g., `useEpisode` hook does not exist in `lib/hooks.ts`, `Episode` type is not defined, or repeated TypeScript errors after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "create-episode-detail-page",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/episodes/[id]/page.tsx"]
    }
  }'
```