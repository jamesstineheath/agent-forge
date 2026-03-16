# Agent Forge -- Create Fast Lane API Endpoint

## Metadata
- **Branch:** `feat/fast-lane-api-endpoint`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/fast-lane/route.ts

## Context

Agent Forge is a dev orchestration platform (Next.js on Vercel) that coordinates autonomous agent teams across multiple repositories. Work items are the core unit of work — they live in Vercel Blob storage and are dispatched to target repos via GitHub Actions.

A "Fast Lane" is a mechanism for quickly filing work items with `source='direct'` (recently added type). The `createWorkItem()` function in `lib/work-items.ts` handles persistence. Registered repos live in `lib/repos.ts` / Vercel Blob at `af-data/repos/*`.

Auth throughout the API uses Bearer token validation against `AGENT_FORGE_API_SECRET` (see e.g. `app/api/work-items/route.ts` for the existing pattern).

The `WorkItem` type in `lib/types.ts` already supports `source: 'direct'` and an optional `triggeredBy` field (both added in recent PRs).

## Requirements

1. Create `app/api/fast-lane/route.ts` with a `POST` handler.
2. Authenticate via Bearer token: validate `Authorization: Bearer <token>` against `AGENT_FORGE_API_SECRET`. Return `401` if missing or invalid.
3. Parse and validate request body:
   - `description`: required, non-empty string → `400` if missing/empty
   - `targetRepo`: required, non-empty string, must be a registered repo → `400` if missing/empty/unregistered
   - `complexity`: optional, must be `'simple'` or `'moderate'` if provided → `400` if invalid value
   - `budget`: optional, must be a positive number if provided → `400` if invalid value
4. Apply budget defaults: `$2` for `simple`, `$4` for `moderate` (or `$4` as the default when neither complexity nor budget is provided, matching `moderate` default).
5. Default `triggeredBy` to `'james'` when not provided.
6. Call `createWorkItem()` with `source: 'direct'` and the resolved fields.
7. Return `{ workItemId: string, status: 'filed', budget: number }` with HTTP `201`.
8. All error responses include a `{ error: string }` JSON body with a descriptive message.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/fast-lane-api-endpoint
```

### Step 1: Inspect existing patterns

Read these files to understand the existing conventions before writing anything:

```bash
cat lib/types.ts
cat lib/work-items.ts
cat lib/repos.ts
cat app/api/work-items/route.ts   # Auth pattern + createWorkItem usage
```

Pay close attention to:
- The `WorkItem` type shape (especially `source`, `triggeredBy`, `budget`, `status` fields)
- The signature of `createWorkItem()` — what fields it expects
- How `getRegisteredRepos()` (or equivalent) works in `lib/repos.ts`
- The exact Bearer token auth pattern used in existing routes

### Step 2: Create `app/api/fast-lane/route.ts`

Create the file with the following structure (adapt field names/types to match what you found in Step 1):

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createWorkItem } from '@/lib/work-items';
import { getRegisteredRepos } from '@/lib/repos'; // adjust import if needed

const BUDGET_DEFAULTS: Record<string, number> = {
  simple: 2,
  moderate: 4,
};
const DEFAULT_BUDGET = 4; // moderate default

function isAuthenticated(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  return token === process.env.AGENT_FORGE_API_SECRET;
}

export async function POST(request: NextRequest) {
  // 1. Auth
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    description,
    targetRepo,
    complexity,
    budget: budgetOverride,
    triggeredBy,
  } = body as Record<string, unknown>;

  // 3. Validate description
  if (!description || typeof description !== 'string' || description.trim() === '') {
    return NextResponse.json(
      { error: 'description is required and must be a non-empty string' },
      { status: 400 }
    );
  }

  // 4. Validate targetRepo
  if (!targetRepo || typeof targetRepo !== 'string' || targetRepo.trim() === '') {
    return NextResponse.json(
      { error: 'targetRepo is required and must be a non-empty string' },
      { status: 400 }
    );
  }

  // 5. Check targetRepo is registered
  const registeredRepos = await getRegisteredRepos();
  // getRegisteredRepos() returns an array of repo objects; check for a match.
  // Adjust the field name (e.g. .name, .fullName, .repo) to match what lib/repos.ts returns.
  const repoIsRegistered = registeredRepos.some(
    (r) => r.fullName === targetRepo || r.name === targetRepo
  );
  if (!repoIsRegistered) {
    return NextResponse.json(
      { error: `targetRepo '${targetRepo}' is not a registered repository` },
      { status: 400 }
    );
  }

  // 6. Validate complexity
  if (complexity !== undefined && complexity !== 'simple' && complexity !== 'moderate') {
    return NextResponse.json(
      { error: "complexity must be 'simple' or 'moderate' if provided" },
      { status: 400 }
    );
  }

  // 7. Validate budget override
  if (budgetOverride !== undefined) {
    if (typeof budgetOverride !== 'number' || budgetOverride <= 0) {
      return NextResponse.json(
        { error: 'budget must be a positive number if provided' },
        { status: 400 }
      );
    }
  }

  // 8. Resolve final budget
  const resolvedBudget =
    typeof budgetOverride === 'number'
      ? budgetOverride
      : complexity
      ? BUDGET_DEFAULTS[complexity as string]
      : DEFAULT_BUDGET;

  // 9. Create work item
  const workItem = await createWorkItem({
    description: description.trim(),
    targetRepo: targetRepo.trim(),
    source: 'direct',
    budget: resolvedBudget,
    triggeredBy: typeof triggeredBy === 'string' && triggeredBy.trim() !== ''
      ? triggeredBy.trim()
      : 'james',
    // Include complexity if the WorkItem type supports it; otherwise omit
    ...(complexity ? { complexity: complexity as 'simple' | 'moderate' } : {}),
  });

  // 10. Return response
  return NextResponse.json(
    {
      workItemId: workItem.id,
      status: 'filed',
      budget: resolvedBudget,
    },
    { status: 201 }
  );
}
```

> **Important:** After reading `lib/work-items.ts` and `lib/types.ts` in Step 1, adjust:
> - The `createWorkItem()` call signature to match exactly what the function accepts
> - The field names on repo objects from `getRegisteredRepos()` to use the correct property
> - Whether `complexity` is a field on `WorkItem` (include it if so, drop it if not)
> - The `status` field value — use whatever `createWorkItem()` sets (likely `'filed'` or `'ready'`); the response always returns `status: 'filed'` per spec regardless

### Step 3: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- `createWorkItem()` may not accept all fields directly — check if it takes a partial `WorkItem` or a specific input type
- `getRegisteredRepos()` may be named differently or require different import path
- The repo object shape from storage may differ from what's assumed above

### Step 4: Build verification

```bash
npm run build
```

Resolve any build errors. The route must compile cleanly.

### Step 5: Quick smoke test (optional but recommended)

If you have a dev server available:

```bash
# Should return 401
curl -s -X POST http://localhost:3000/api/fast-lane \
  -H "Content-Type: application/json" \
  -d '{"description":"test","targetRepo":"jamesstineheath/agent-forge"}' | jq .

# Should return 400 (missing description)
curl -s -X POST http://localhost:3000/api/fast-lane \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"targetRepo":"jamesstineheath/agent-forge"}' | jq .

# Should return 400 (invalid complexity)  
curl -s -X POST http://localhost:3000/api/fast-lane \
  -H "Authorization: Bearer test-secret" \
  -H "Content-Type: application/json" \
  -d '{"description":"do a thing","targetRepo":"jamesstineheath/agent-forge","complexity":"complex"}' | jq .
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add POST /api/fast-lane endpoint for direct work item creation"
git push origin feat/fast-lane-api-endpoint
gh pr create \
  --title "feat: add POST /api/fast-lane endpoint" \
  --body "## Summary

Creates the \`POST /api/fast-lane\` API endpoint that accepts fast-lane item creation requests and files work items with \`source='direct'\`.

## Changes
- **app/api/fast-lane/route.ts** (new): POST handler with Bearer token auth, input validation, and work item creation

## Behavior
- Authenticates via \`Authorization: Bearer <AGENT_FORGE_API_SECRET>\`
- Validates \`description\` (required, non-empty) and \`targetRepo\` (required, registered repo)
- Validates optional \`complexity\` ('simple' | 'moderate') and \`budget\` (positive number)
- Defaults budget to \$2 (simple) or \$4 (moderate/unspecified)
- Defaults \`triggeredBy\` to 'james'
- Creates work item with \`source='direct'\`
- Returns \`{ workItemId, status: 'filed', budget }\` with HTTP 201

## Acceptance Criteria
- [x] POST /api/fast-lane creates a work item with source='direct'
- [x] Returns { workItemId, status, budget }
- [x] Missing description or targetRepo → 400
- [x] Unregistered targetRepo → 400
- [x] Invalid complexity or budget → 400
- [x] Unauthenticated requests → 401
- [x] Budget defaults: \$2 simple, \$4 moderate
- [x] triggeredBy defaults to 'james'"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/fast-lane-api-endpoint
FILES CHANGED: [app/api/fast-lane/route.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker you cannot resolve (e.g., `createWorkItem()` signature is incompatible with `source='direct'`, `getRegisteredRepos()` does not exist, or `WorkItem` type lacks required fields):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/fast-lane/route.ts"]
    }
  }'
```