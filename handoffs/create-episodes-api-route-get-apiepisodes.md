# Agent Forge -- Create Episodes API Route (GET /api/episodes)

## Metadata
- **Branch:** `feat/episodes-api-route`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/episodes/route.ts, app/api/episodes/[id]/route.ts

## Context

Agent Forge is a dev orchestration platform built on Next.js App Router. This task adds two new API routes to support an episodes dashboard with search, filtering, and pagination capabilities.

The codebase already has a `BlobEpisodeStore` (likely in `lib/` somewhere) with at minimum `search()` and `get(id)` methods. Auth patterns follow the existing API routes in `app/api/` — look at routes like `app/api/events/route.ts` or `app/api/work-items/route.ts` for the canonical auth pattern (session auth or `CRON_SECRET` bearer token check).

Key types to be aware of:
- `Episode` type (likely in `lib/types.ts` or a dedicated `lib/episodes.ts`)
- `EpisodeSearchParams` type (same location)
- `BlobEpisodeStore` (likely `lib/episode-store.ts` or similar)

The routes must follow App Router conventions (`export async function GET(request: NextRequest)`).

## Requirements

1. `app/api/episodes/route.ts` — GET handler accepting query params: `q`, `from`, `to`, `outcome`, `cursor`, `limit` (default 20, max 100)
2. Validates and parses all query params into `EpisodeSearchParams` before calling `BlobEpisodeStore.search()`
3. Returns `{ episodes: Episode[], nextCursor?: string }` as JSON
4. `app/api/episodes/[id]/route.ts` — GET handler fetching a single episode by ID via `BlobEpisodeStore.get(id)`
5. Returns 404 with `{ error: "Not found" }` if episode doesn't exist
6. Both endpoints require authentication — return 401 for unauthenticated requests using the same auth pattern as existing API routes
7. Project compiles with no TypeScript errors (`npx tsc --noEmit` passes)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/episodes-api-route
```

### Step 1: Discover existing patterns

Before writing any code, inspect the codebase to understand existing types and auth patterns:

```bash
# Find Episode types and BlobEpisodeStore
grep -r "Episode" lib/ --include="*.ts" -l
grep -r "BlobEpisodeStore" lib/ --include="*.ts" -l
grep -r "EpisodeSearchParams" lib/ --include="*.ts" -l

# Find the actual store implementation
find lib/ -name "episode*" -o -name "*episode*" | head -20

# Study auth patterns from existing routes
cat app/api/events/route.ts
cat app/api/work-items/route.ts 2>/dev/null || ls app/api/work-items/

# Check how CRON_SECRET / session auth is done
grep -r "CRON_SECRET\|getServerSession\|auth()\|Authorization" app/api/ --include="*.ts" -l | head -5
grep -r "CRON_SECRET\|getServerSession\|auth()" app/api/events/route.ts
```

### Step 2: Understand the Episode type and store interface

```bash
# Print the full content of the episode store / types
cat lib/episode-store.ts 2>/dev/null || \
cat lib/episodes.ts 2>/dev/null || \
grep -A 30 "Episode" lib/types.ts 2>/dev/null

# Understand search() return type and EpisodeSearchParams shape
grep -A 20 "search\|EpisodeSearchParams" lib/episode-store.ts 2>/dev/null || \
grep -A 20 "search\|EpisodeSearchParams" lib/episodes.ts 2>/dev/null
```

### Step 3: Create the directory structure

```bash
mkdir -p app/api/episodes/\[id\]
```

### Step 4: Create `app/api/episodes/route.ts`

Using the auth pattern discovered in Step 1, create the list/search endpoint.

**Template** (adapt auth pattern to match codebase conventions):

```typescript
import { NextRequest, NextResponse } from 'next/server';
// Import auth utility consistent with existing routes (e.g., auth from next-auth, or getServerSession)
// Import BlobEpisodeStore and EpisodeSearchParams from their discovered locations

export async function GET(request: NextRequest) {
  // Auth check — mirror the pattern from app/api/events/route.ts or equivalent
  // e.g., check Authorization header for CRON_SECRET bearer token OR valid session
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  
  // Check bearer token (for programmatic access)
  const isBearerAuthed =
    cronSecret && authHeader === `Bearer ${cronSecret}`;
  
  // Check session (for dashboard UI) — adapt to actual auth pattern used
  // const session = await auth(); // or getServerSession(authOptions)
  // const isSessionAuthed = !!session?.user;
  
  if (!isBearerAuthed /* && !isSessionAuthed */) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  // Parse and validate query params
  const q = searchParams.get('q') ?? undefined;
  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;
  const outcomeParam = searchParams.get('outcome') ?? undefined;
  const cursor = searchParams.get('cursor') ?? undefined;
  
  const limitParam = searchParams.get('limit');
  const limitParsed = limitParam ? parseInt(limitParam, 10) : 20;
  const limit = isNaN(limitParsed)
    ? 20
    : Math.min(Math.max(limitParsed, 1), 100);

  // Validate outcome if present
  const validOutcomes = ['success', 'failure', 'partial'] as const;
  type Outcome = typeof validOutcomes[number];
  const outcome: Outcome | undefined =
    outcomeParam && validOutcomes.includes(outcomeParam as Outcome)
      ? (outcomeParam as Outcome)
      : undefined;

  // Build EpisodeSearchParams — adapt field names to match actual type
  const params /* : EpisodeSearchParams */ = {
    ...(q && { q }),
    ...(from && { from }),
    ...(to && { to }),
    ...(outcome && { outcome }),
    ...(cursor && { cursor }),
    limit,
  };

  const result = await BlobEpisodeStore.search(params);

  return NextResponse.json({
    episodes: result.episodes,
    ...(result.nextCursor && { nextCursor: result.nextCursor }),
  });
}
```

**Important:** Replace the auth stub with the exact pattern from the existing routes discovered in Step 1.

### Step 5: Create `app/api/episodes/[id]/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
// Import same auth utilities
// Import BlobEpisodeStore

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Auth check — same pattern as route.ts above
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isBearerAuthed =
    cronSecret && authHeader === `Bearer ${cronSecret}`;
  // const session = await auth();
  // const isSessionAuthed = !!session?.user;

  if (!isBearerAuthed /* && !isSessionAuthed */) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = params;

  const episode = await BlobEpisodeStore.get(id);

  if (!episode) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(episode);
}
```

### Step 6: Refine both files to use real imports

After examining the codebase in Steps 1–2, replace all placeholder imports and auth stubs with actual code. Verify:

```bash
# Check what auth export is used by existing routes
grep -n "^import.*auth\|^import.*getServerSession\|^import.*session" app/api/events/route.ts

# Check exact BlobEpisodeStore export
grep -n "^export" lib/episode-store.ts 2>/dev/null || grep -n "BlobEpisodeStore" lib/*.ts
```

### Step 7: Extract shared auth helper (optional but preferred)

If no shared `isAuthenticated(request)` helper exists, consider adding one inline. If a helper already exists (e.g., `lib/auth.ts` or `lib/api-auth.ts`), import and use it:

```bash
grep -r "isAuthenticated\|checkAuth\|requireAuth" lib/ app/ --include="*.ts" -l
```

### Step 8: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build

# Quick smoke test (adjust URL/secret as needed)
# These will 401 without auth, confirming the guard works:
curl -s http://localhost:3000/api/episodes | jq .
curl -s http://localhost:3000/api/episodes/test-id | jq .

# With auth header:
# curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/episodes | jq .
```

### Step 9: Commit, push, open PR

```bash
git add app/api/episodes/route.ts app/api/episodes/\[id\]/route.ts
git commit -m "feat: add episodes API routes (GET /api/episodes and /api/episodes/[id])"
git push origin feat/episodes-api-route
gh pr create \
  --title "feat: Episodes API routes (GET /api/episodes)" \
  --body "## Summary

Adds two new API routes to support the episodes dashboard:

- \`GET /api/episodes\` — search/filter/paginate episodes with query params: \`q\`, \`from\`, \`to\`, \`outcome\`, \`cursor\`, \`limit\` (default 20, max 100)
- \`GET /api/episodes/[id]\` — fetch a single episode by ID, returns 404 if not found

Both endpoints require authentication (bearer token via \`CRON_SECRET\` or session), returning 401 for unauthenticated requests. Calls \`BlobEpisodeStore.search()\` and \`BlobEpisodeStore.get()\` respectively.

## Files Changed
- \`app/api/episodes/route.ts\` (new)
- \`app/api/episodes/[id]/route.ts\` (new)

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors (e.g., `BlobEpisodeStore` or `Episode` type not found in the codebase, auth pattern unclear):

1. Commit whatever compiles cleanly
2. Open the PR with partial status noted
3. Escalate if `BlobEpisodeStore` does not exist at all (it may be a prerequisite not yet implemented):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "create-episodes-api-route",
    "reason": "BlobEpisodeStore or Episode type not found in codebase — prerequisite implementation may be missing",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "Cannot locate BlobEpisodeStore or EpisodeSearchParams in lib/",
      "filesChanged": []
    }
  }'
```

4. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/episodes-api-route
FILES CHANGED: [app/api/episodes/route.ts, app/api/episodes/[id]/route.ts]
SUMMARY: [what was implemented]
ISSUES: [e.g., BlobEpisodeStore not found / auth pattern unclear]
NEXT STEPS: [implement BlobEpisodeStore first, or clarify auth approach]
```