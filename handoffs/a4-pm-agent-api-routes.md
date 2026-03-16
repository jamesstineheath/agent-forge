# Agent Forge -- A4: PM Agent API Routes

## Metadata
- **Branch:** `feat/pm-agent-api-routes`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/pm-agent/route.ts

## Context

Agent Forge is a dev orchestration platform (Next.js App Router on Vercel). We are building a PM Agent module that provides autonomous project management capabilities. This task (A4) creates the API routes that expose PM Agent capabilities over HTTP.

The PM Agent module already exists at `lib/pm-agent.ts` (added in A3), which exports: `reviewBacklog`, `assessProjectHealth`, `suggestNextBatch`, and `composeDigest`. Types were added in A1 (lib/types.ts).

Auth pattern in this repo: check `req.headers.get('authorization')` against `Bearer ${process.env.AGENT_FORGE_API_SECRET}`. See existing routes like `app/api/work-items/route.ts` for reference patterns.

Storage: Vercel Blob via `lib/storage.ts`. PM Agent results are stored under `af-data/pm-agent/reviews/` and `af-data/pm-agent/health/` prefixes.

## Requirements

1. Create `app/api/pm-agent/route.ts` with both `POST` and `GET` exported handlers
2. Both handlers must verify the `Authorization: Bearer <token>` header against `AGENT_FORGE_API_SECRET` (and optionally `WORK_ITEMS_API_KEY` as fallback), returning `401` for missing or invalid auth
3. `POST` handler accepts JSON body with `{ action: 'review' | 'health' | 'suggest' | 'digest', options?: object }`:
   - `'review'` → calls `reviewBacklog(options)` and returns JSON result
   - `'health'` → calls `assessProjectHealth(options?.projectId)` and returns JSON result
   - `'suggest'` → calls `suggestNextBatch()` and returns JSON result
   - `'digest'` → calls `composeDigest(options)` and returns JSON result
   - Unknown action → returns `400` with error message
4. `GET` handler reads `?type=review|health` query param (default `'review'`) and fetches the most recent result from Vercel Blob (`af-data/pm-agent/reviews/` or `af-data/pm-agent/health/`)
5. `GET` returns `404` with JSON error if no results are found for the requested type
6. All error paths return appropriate HTTP status codes with JSON `{ error: string }` bodies
7. TypeScript must compile without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/pm-agent-api-routes
```

### Step 1: Inspect existing patterns

Before writing code, read the following files to understand existing conventions:

```bash
# Check existing API route patterns
cat app/api/work-items/route.ts 2>/dev/null || find app/api -name "route.ts" | head -5 | xargs head -60

# Check storage helpers
cat lib/storage.ts

# Check pm-agent exports
cat lib/pm-agent.ts

# Check types
grep -n "pmAgent\|PmAgent\|pm_agent\|BacklogReview\|ProjectHealth\|DigestResult\|SuggestResult" lib/types.ts 2>/dev/null | head -30
```

Pay attention to:
- How auth is verified (exact env var names and comparison logic)
- How Vercel Blob `list` and `get`/`download` are called in existing routes
- What the pm-agent functions return (their return types)
- How errors are handled and returned

### Step 2: Create `app/api/pm-agent/route.ts`

Create the file with the following implementation. Adjust import paths and Blob access patterns to exactly match what you observed in Step 1:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import {
  reviewBacklog,
  assessProjectHealth,
  suggestNextBatch,
  composeDigest,
} from '@/lib/pm-agent';

// ── Auth helper ──────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return false;

  const apiSecret = process.env.AGENT_FORGE_API_SECRET;
  const workItemsKey = process.env.WORK_ITEMS_API_KEY;

  if (apiSecret && authHeader === `Bearer ${apiSecret}`) return true;
  if (workItemsKey && authHeader === `Bearer ${workItemsKey}`) return true;

  return false;
}

// ── POST /api/pm-agent ───────────────────────────────────────────────────────
// Body: { action: 'review' | 'health' | 'suggest' | 'digest', options?: object }

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { action?: string; options?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action, options } = body;

  if (!action) {
    return NextResponse.json(
      { error: 'Missing required field: action' },
      { status: 400 }
    );
  }

  try {
    switch (action) {
      case 'review': {
        const result = await reviewBacklog(options);
        return NextResponse.json(result);
      }
      case 'health': {
        const projectId = options?.projectId as string | undefined;
        const result = await assessProjectHealth(projectId);
        return NextResponse.json(result);
      }
      case 'suggest': {
        const result = await suggestNextBatch();
        return NextResponse.json(result);
      }
      case 'digest': {
        const result = await composeDigest(options);
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Valid actions: review, health, suggest, digest` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error(`[pm-agent] POST action=${action} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

// ── GET /api/pm-agent ────────────────────────────────────────────────────────
// Query: ?type=review|health (default: 'review')
// Returns the most recent stored result for the given type

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') ?? 'review';

  if (type !== 'review' && type !== 'health') {
    return NextResponse.json(
      { error: `Unknown type: ${type}. Valid types: review, health` },
      { status: 400 }
    );
  }

  const prefix = type === 'review'
    ? 'af-data/pm-agent/reviews/'
    : 'af-data/pm-agent/health/';

  try {
    // Use the storage helper pattern observed in Step 1.
    // If lib/storage.ts exports a list/get helper, use it.
    // Otherwise fall back to direct Vercel Blob SDK:
    const { list } = await import('@vercel/blob');

    const { blobs } = await list({ prefix });

    if (!blobs || blobs.length === 0) {
      return NextResponse.json(
        { error: `No ${type} results found` },
        { status: 404 }
      );
    }

    // Sort by uploadedAt descending to get most recent
    const sorted = blobs.sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
    const latest = sorted[0];

    // Fetch blob content
    const response = await fetch(latest.url);
    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch result from storage' },
        { status: 500 }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[pm-agent] GET type=${type} failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### Step 3: Adapt to actual storage patterns

After writing the initial file, re-read `lib/storage.ts` to verify the import approach:

```bash
cat lib/storage.ts
```

**If `lib/storage.ts` exports a `listBlobs` or `list` or similar helper:** replace the `import('@vercel/blob')` dynamic import in GET with a call to that helper, matching the pattern used in other routes.

**If `lib/storage.ts` exports a `getBlob` or `readBlob` helper for fetching content:** use that instead of `fetch(latest.url)`.

**If the pm-agent functions have different signatures than assumed** (e.g., `reviewBacklog` takes no arguments, or `assessProjectHealth` takes a different param name): adjust the POST handler switch cases accordingly to match the actual exported signatures.

### Step 4: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- The `options` parameter types on pm-agent functions (may need casting or type guards)
- Blob SDK type differences between `@vercel/blob` versions
- Missing type imports from `@/lib/types`

If pm-agent functions don't accept `options` parameters, remove those from the switch cases and call them with no arguments.

### Step 5: Build verification

```bash
npm run build
```

Resolve any build errors. Do not proceed to PR if build fails.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: A4 PM Agent API routes (POST actions + GET latest results)"
git push origin feat/pm-agent-api-routes
gh pr create \
  --title "feat: A4 PM Agent API Routes" \
  --body "## Summary

Creates \`app/api/pm-agent/route.ts\` with POST and GET handlers for PM Agent capabilities.

## Changes
- \`app/api/pm-agent/route.ts\` — new API route file

## POST /api/pm-agent
Accepts \`{ action, options }\` body and dispatches to the appropriate pm-agent function:
- \`review\` → \`reviewBacklog(options)\`
- \`health\` → \`assessProjectHealth(options?.projectId)\`
- \`suggest\` → \`suggestNextBatch()\`
- \`digest\` → \`composeDigest(options)\`

## GET /api/pm-agent
Fetches the most recent stored result from Vercel Blob for the given \`?type=review|health\` query param. Returns 404 if no results exist.

## Auth
Both endpoints require \`Authorization: Bearer <AGENT_FORGE_API_SECRET>\` header. Returns 401 for missing/invalid auth.

## Part of PM Agent epic
- A1: Types ✅
- A2: (previous)
- A3: Core pm-agent module ✅
- A4: API routes (this PR)
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
BRANCH: feat/pm-agent-api-routes
FILES CHANGED: app/api/pm-agent/route.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you cannot resolve a blocker after 3 attempts, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "a4-pm-agent-api-routes",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/pm-agent/route.ts"]
    }
  }'
```