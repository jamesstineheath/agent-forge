# Agent Forge -- Add debate stats to pipeline dashboard API

## Metadata
- **Branch:** `feat/debate-stats-pipeline-api`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/debates/route.ts, app/(app)/pipeline/page.tsx, lib/hooks.ts

## Context

Agent Forge is a Next.js 16 App Router dev orchestration platform. It already has a debate system (`lib/debate/`) as evidenced by recent PRs (risk-detector, etc.) and presumably debate session storage. The pipeline dashboard at `app/(app)/pipeline/page.tsx` shows active executions and ATC view. We need to add:

1. A new API route `app/api/debates/route.ts` that exposes debate statistics and session queries
2. An update to the pipeline dashboard to show a Debate Reviews stats card

The codebase uses:
- Auth.js v5 (`next-auth@beta`) — auth pattern: import `auth` from `lib/auth.ts`, call `const session = await auth()`, return 401 if no session
- SWR for client-side data fetching via hooks in `lib/hooks.ts`
- Tailwind CSS v4 + shadcn/ui components
- Vercel Blob storage (`lib/storage.ts`) for persisted data

The debate system likely has session storage. Based on the system map and recent PRs, look for `lib/debate/` files. The functions `getDebateStats()` and `listDebateSessions()` need to be sourced or created there.

## Requirements

1. `GET /api/debates` returns JSON `{ totalSessions, avgRounds, avgTokens, verdictDistribution: { approve, request_changes, escalate } }`
2. `GET /api/debates?repo=X&pr=Y` returns array of `DebateSession` objects for that PR
3. API route requires authentication — returns 401 for unauthenticated requests
4. Pipeline page renders a "Debate Reviews" stats card with total sessions, avg rounds, avg tokens, verdict distribution counts
5. Pipeline page renders gracefully with zero/missing data
6. SWR hook in `lib/hooks.ts` for fetching debate stats
7. TypeScript compiles without errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/debate-stats-pipeline-api
```

### Step 1: Audit existing debate types and storage

Before writing any code, inspect the existing debate system:

```bash
find lib/debate -type f | sort
cat lib/debate/*.ts 2>/dev/null || echo "No files found"
grep -r "DebateSession\|getDebateStats\|listDebateSessions\|debate" lib/types.ts 2>/dev/null | head -40
grep -r "debate" lib/storage.ts 2>/dev/null | head -20
```

Also check how other API routes are structured to match the auth pattern exactly:

```bash
cat app/api/work-items/route.ts 2>/dev/null | head -60
cat app/api/events/route.ts 2>/dev/null | head -60
```

And check existing hooks for SWR patterns:

```bash
cat lib/hooks.ts
```

### Step 2: Define or extend DebateSession types

Check `lib/types.ts` for existing `DebateSession` type. If it doesn't exist, add it. If it does, use it as-is.

In `lib/types.ts`, ensure the following types exist (add only what's missing):

```typescript
export interface DebateRound {
  round: number;
  prosecutorArg: string;
  defenseArg: string;
  tokensUsed?: number;
}

export interface DebateSession {
  id: string;
  repo: string;
  prNumber: number;
  prTitle?: string;
  createdAt: string;
  completedAt?: string;
  rounds: DebateRound[];
  verdict: 'approve' | 'request_changes' | 'escalate';
  totalTokens?: number;
  summary?: string;
}

export interface DebateStats {
  totalSessions: number;
  avgRounds: number;
  avgTokens: number;
  verdictDistribution: {
    approve: number;
    request_changes: number;
    escalate: number;
  };
}
```

### Step 3: Add debate storage functions

Check whether `lib/debate/` already has storage/query functions. If `getDebateStats` and `listDebateSessions` already exist there, use them directly. If not, create or extend the debate module.

**If `lib/debate/sessions.ts` doesn't exist**, create it:

```typescript
// lib/debate/sessions.ts
import { storage } from '../storage';
import type { DebateSession, DebateStats } from '../types';

const DEBATE_PREFIX = 'af-data/debates/';

export async function saveDebateSession(session: DebateSession): Promise<void> {
  await storage.put(`${DEBATE_PREFIX}${session.id}.json`, JSON.stringify(session));
}

export async function listDebateSessions(repo?: string, prNumber?: number): Promise<DebateSession[]> {
  const blobs = await storage.list(DEBATE_PREFIX);
  const sessions: DebateSession[] = [];

  for (const blob of blobs) {
    try {
      const raw = await storage.get(blob.pathname);
      if (!raw) continue;
      const session: DebateSession = JSON.parse(raw);
      if (repo && session.repo !== repo) continue;
      if (prNumber !== undefined && session.prNumber !== prNumber) continue;
      sessions.push(session);
    } catch {
      // skip malformed
    }
  }

  return sessions.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function getDebateStats(): Promise<DebateStats> {
  const sessions = await listDebateSessions();

  if (sessions.length === 0) {
    return {
      totalSessions: 0,
      avgRounds: 0,
      avgTokens: 0,
      verdictDistribution: { approve: 0, request_changes: 0, escalate: 0 },
    };
  }

  const totalRounds = sessions.reduce((sum, s) => sum + (s.rounds?.length ?? 0), 0);
  const totalTokens = sessions.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);

  const verdictDistribution = { approve: 0, request_changes: 0, escalate: 0 };
  for (const s of sessions) {
    if (s.verdict in verdictDistribution) {
      verdictDistribution[s.verdict]++;
    }
  }

  return {
    totalSessions: sessions.length,
    avgRounds: Math.round((totalRounds / sessions.length) * 10) / 10,
    avgTokens: Math.round(totalTokens / sessions.length),
    verdictDistribution,
  };
}
```

**Important**: Check `lib/storage.ts` for the actual API — it may use `getBlob`/`putBlob`/`listBlobs` or similar. Match the real API exactly. Look at how other files use storage before writing session code.

```bash
cat lib/storage.ts
grep -r "storage\." lib/work-items.ts | head -20
```

Adapt the storage calls to match the actual API.

### Step 4: Create the API route

Create `app/api/debates/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '../../../lib/auth';
import { getDebateStats, listDebateSessions } from '../../../lib/debate/sessions';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const repo = searchParams.get('repo');
  const pr = searchParams.get('pr');

  // If repo + pr params provided, return specific sessions
  if (repo && pr) {
    const prNumber = parseInt(pr, 10);
    if (isNaN(prNumber)) {
      return NextResponse.json({ error: 'Invalid pr parameter' }, { status: 400 });
    }
    const sessions = await listDebateSessions(repo, prNumber);
    return NextResponse.json(sessions);
  }

  // Otherwise return aggregate stats
  const stats = await getDebateStats();
  return NextResponse.json(stats);
}
```

**Check the auth import path** against existing routes — it may be `@/lib/auth` or a relative path. Use whatever pattern the other API routes use.

### Step 5: Add SWR hook for debate stats

Open `lib/hooks.ts` and add a `useDebateStats` hook following the existing pattern. For example, if other hooks look like:

```typescript
export function useWorkItems() {
  return useSWR<WorkItem[]>('/api/work-items', fetcher);
}
```

Then add:

```typescript
import type { DebateStats, DebateSession } from './types';

export function useDebateStats() {
  return useSWR<DebateStats>('/api/debates', fetcher);
}

export function useDebateSessions(repo?: string, pr?: number) {
  const key = repo && pr ? `/api/debates?repo=${encodeURIComponent(repo)}&pr=${pr}` : null;
  return useSWR<DebateSession[]>(key, fetcher);
}
```

Place these after the existing hooks, following whatever import/organization pattern is already there.

### Step 6: Update the pipeline dashboard page

Open `app/(app)/pipeline/page.tsx`. Study its structure — it may be a Server Component or Client Component. Check:

```bash
head -20 app/\(app\)/pipeline/page.tsx
grep -n "use client\|useSWR\|useWork\|useState" app/\(app\)/pipeline/page.tsx | head -20
```

**If it's already a Client Component** (has `'use client'`): add `useDebateStats` directly.

**If it's a Server Component**: either (a) create a `DebateStatsCard` client component that internally uses SWR, or (b) fetch server-side with `await getDebateStats()` directly (since it's server-side). The simpler approach for a stats card with no real-time needs is a direct server-side fetch or a small client component.

**Recommended approach — create a small client component** `components/debate-stats-card.tsx`:

```typescript
'use client';

import { useDebateStats } from '@/lib/hooks';

export function DebateStatsCard() {
  const { data: stats, isLoading, error } = useDebateStats();

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h3 className="font-semibold text-lg mb-4">Debate Reviews</h3>
        <p className="text-muted-foreground text-sm">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h3 className="font-semibold text-lg mb-4">Debate Reviews</h3>
        <p className="text-muted-foreground text-sm">Failed to load debate stats.</p>
      </div>
    );
  }

  const total = stats?.totalSessions ?? 0;
  const dist = stats?.verdictDistribution ?? { approve: 0, request_changes: 0, escalate: 0 };

  return (
    <div className="rounded-lg border bg-card p-6">
      <h3 className="font-semibold text-lg mb-4">Debate Reviews</h3>
      {total === 0 ? (
        <p className="text-muted-foreground text-sm">No debate sessions yet.</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Total Sessions</p>
              <p className="text-2xl font-bold">{total}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Avg Rounds</p>
              <p className="text-2xl font-bold">{stats?.avgRounds ?? 0}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Avg Tokens</p>
              <p className="text-2xl font-bold">{(stats?.avgTokens ?? 0).toLocaleString()}</p>
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground mb-2">Verdict Distribution</p>
            <div className="flex gap-3 text-sm">
              <span className="text-green-600 font-medium">✓ {dist.approve} approved</span>
              <span className="text-yellow-600 font-medium">△ {dist.request_changes} changes</span>
              <span className="text-red-600 font-medium">⚡ {dist.escalate} escalated</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

Then in `app/(app)/pipeline/page.tsx`, import and render `<DebateStatsCard />` in an appropriate place — after the existing execution stats, before or after any existing cards. Use the same layout grid/spacing that existing cards use.

```typescript
import { DebateStatsCard } from '@/components/debate-stats-card';

// Inside the JSX, in the stats section:
<DebateStatsCard />
```

### Step 7: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build

# If tests exist
npm test -- --passWithNoTests 2>/dev/null || true
```

Fix any TypeScript errors before proceeding. Common issues:
- Import path mismatches (use `@/` aliases consistently if the project does)
- Storage API mismatch — re-check `lib/storage.ts` actual exports
- `DebateSession`/`DebateStats` types already existing with different shapes — adapt to what's there

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add debate stats API endpoint and pipeline dashboard card

- Add GET /api/debates returning aggregate stats (totalSessions, avgRounds, avgTokens, verdictDistribution)
- Add GET /api/debates?repo=X&pr=Y returning specific DebateSession array
- Auth-protected endpoint (401 for unauthenticated requests)
- Add lib/debate/sessions.ts with getDebateStats() and listDebateSessions()
- Add useDebateStats and useDebateSessions SWR hooks in lib/hooks.ts
- Add DebateStatsCard component with graceful zero-state rendering
- Render DebateStatsCard in pipeline dashboard page"

git push origin feat/debate-stats-pipeline-api

gh pr create \
  --title "feat: add debate stats to pipeline dashboard API" \
  --body "## Summary

Adds debate statistics visibility to the pipeline dashboard.

### Changes
- **\`app/api/debates/route.ts\`**: New auth-protected API endpoint
  - \`GET /api/debates\` → aggregate stats (totalSessions, avgRounds, avgTokens, verdictDistribution)
  - \`GET /api/debates?repo=X&pr=Y\` → array of DebateSession objects for that PR
  - Returns 401 for unauthenticated requests
- **\`lib/debate/sessions.ts\`**: Storage layer with \`getDebateStats()\` and \`listDebateSessions()\`
- **\`lib/hooks.ts\`**: Added \`useDebateStats\` and \`useDebateSessions\` SWR hooks
- **\`components/debate-stats-card.tsx\`**: Client component with loading/error/zero states
- **\`app/(app)/pipeline/page.tsx\`**: Renders DebateStatsCard in pipeline view

### Acceptance Criteria
- [x] GET /api/debates returns correct JSON shape
- [x] GET /api/debates?repo=X&pr=Y returns filtered sessions
- [x] 401 for unauthenticated requests
- [x] Pipeline page shows debate stats card
- [x] Graceful zero-state when no sessions exist
- [x] TypeScript compiles without errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/debate-stats-pipeline-api
FILES CHANGED: [list files actually modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains - e.g., "storage API mismatch in sessions.ts needs manual fix", "pipeline page integration pending"]
```

## Escalation

If blocked on any of the following, call the escalation API:

- `lib/storage.ts` has no `list()` method and no clear equivalent — cannot implement session listing
- `lib/debate/` already has `getDebateStats`/`listDebateSessions` with incompatible signatures
- `lib/auth.ts` exports auth differently than expected and 401 pattern is unclear
- Pipeline page architecture makes adding a client component non-trivial

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-debate-stats-pipeline-api",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["<list of files modified so far>"]
    }
  }'
```