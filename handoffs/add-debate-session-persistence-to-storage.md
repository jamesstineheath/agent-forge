# Agent Forge -- Add debate session persistence to storage

## Metadata
- **Branch:** `feat/add-debate-session-persistence`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/debate/storage.ts

## Context

Agent Forge uses Vercel Blob (with a local file fallback for dev) as its storage layer, abstracted through `lib/storage.ts`. The existing pattern is to use `put`, `list`, and `get` from that module rather than calling the Vercel Blob SDK directly.

A debate orchestrator was recently implemented at `lib/debate/orchestrator.ts` (see merged PRs). Debate sessions need to be persisted so they can be reviewed, used for outcome tracking, and surfaced in the dashboard. The `DebateSession` type lives in the debate module — review the orchestrator file to confirm its exact shape before writing storage code.

The storage path convention used elsewhere in the codebase is `af-data/{subsystem}/{keys...}.json`. For debates the target path is `af-data/debates/{repo}/{prNumber}/{sessionId}.json`.

**No files in this task overlap with concurrent work on `feat/implement-graph-query-engine`** (`lib/knowledge-graph/query.ts`, `lib/__tests__/knowledge-graph-query.test.ts`). No coordination needed.

## Requirements

1. `saveDebateSession(session: DebateSession): Promise<void>` — serializes the session to JSON and writes it to `af-data/debates/{repo}/{prNumber}/{sessionId}.json` using `lib/storage.ts`.
2. `getDebateSession(repo: string, prNumber: number, sessionId: string): Promise<DebateSession | null>` — reads and parses the session; returns `null` if not found or if JSON is corrupt.
3. `listDebateSessions(repo: string, prNumber?: number): Promise<DebateSession[]>` — lists all sessions for a repo (optionally filtered to a specific PR); returns `[]` if none exist; handles missing/corrupt entries gracefully.
4. `getDebateStats(): Promise<{ totalSessions: number, avgRounds: number, avgTokens: number, verdictDistribution: Record<string, number> }>` — scans all stored sessions and computes aggregate stats.
5. All four functions use only the `lib/storage.ts` abstraction — no direct `@vercel/blob` imports.
6. All functions handle errors (network failures, missing blobs, bad JSON) with try/catch and safe defaults — no unhandled rejections.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-debate-session-persistence
```

### Step 1: Understand existing types and storage API

Read the orchestrator to find the exact `DebateSession` type (and related types like `DebateRound`, `DebateVerdict`, etc.):
```bash
cat lib/debate/orchestrator.ts
```

Also read the storage abstraction to understand the exact function signatures exported:
```bash
cat lib/storage.ts
```

Key things to confirm:
- The shape of `DebateSession` (fields: `sessionId`, `repo`, `prNumber`, `rounds`, `verdict`, token counts, etc.)
- Whether `storage.ts` exports `put(key, value)`, `get(key)`, `list(prefix)` or similar — note exact signatures and return types.
- How `list` returns items (does it return `{ blobs: Array<{ pathname: string }> }` or similar?).

### Step 2: Implement `lib/debate/storage.ts`

Create the file. Below is a reference implementation — **adjust types and storage call signatures to match what you found in Step 1**:

```typescript
import { put, get, list } from '../storage';
import type { DebateSession } from './orchestrator'; // adjust import path if type is elsewhere

// Path helpers
function sessionPath(repo: string, prNumber: number, sessionId: string): string {
  // Encode repo owner/name so slashes don't create extra path segments
  const encodedRepo = repo.replace('/', '__');
  return `af-data/debates/${encodedRepo}/${prNumber}/${sessionId}.json`;
}

function sessionPrefix(repo: string, prNumber?: number): string {
  const encodedRepo = repo.replace('/', '__');
  if (prNumber !== undefined) {
    return `af-data/debates/${encodedRepo}/${prNumber}/`;
  }
  return `af-data/debates/${encodedRepo}/`;
}

export async function saveDebateSession(session: DebateSession): Promise<void> {
  const path = sessionPath(session.repo, session.prNumber, session.sessionId);
  await put(path, JSON.stringify(session));
}

export async function getDebateSession(
  repo: string,
  prNumber: number,
  sessionId: string
): Promise<DebateSession | null> {
  try {
    const path = sessionPath(repo, prNumber, sessionId);
    const raw = await get(path);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as DebateSession;
  } catch {
    return null;
  }
}

export async function listDebateSessions(
  repo: string,
  prNumber?: number
): Promise<DebateSession[]> {
  try {
    const prefix = sessionPrefix(repo, prNumber);
    const result = await list(prefix);
    // Adapt to however list() returns items — check storage.ts
    const pathnames: string[] = Array.isArray(result)
      ? result
      : (result?.blobs ?? []).map((b: { pathname: string }) => b.pathname);

    const sessions: DebateSession[] = [];
    for (const pathname of pathnames) {
      try {
        const raw = await get(pathname);
        if (!raw) continue;
        const session = JSON.parse(
          typeof raw === 'string' ? raw : JSON.stringify(raw)
        ) as DebateSession;
        sessions.push(session);
      } catch {
        // Skip corrupt entries
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

export async function getDebateStats(): Promise<{
  totalSessions: number;
  avgRounds: number;
  avgTokens: number;
  verdictDistribution: Record<string, number>;
}> {
  const empty = {
    totalSessions: 0,
    avgRounds: 0,
    avgTokens: 0,
    verdictDistribution: {} as Record<string, number>,
  };

  try {
    const result = await list('af-data/debates/');
    const pathnames: string[] = Array.isArray(result)
      ? result
      : (result?.blobs ?? []).map((b: { pathname: string }) => b.pathname);

    if (pathnames.length === 0) return empty;

    let totalRounds = 0;
    let totalTokens = 0;
    const verdictDistribution: Record<string, number> = {};
    let validCount = 0;

    for (const pathname of pathnames) {
      try {
        const raw = await get(pathname);
        if (!raw) continue;
        const session = JSON.parse(
          typeof raw === 'string' ? raw : JSON.stringify(raw)
        ) as DebateSession;

        validCount++;

        // Rounds — adapt field name if different (e.g., session.rounds?.length)
        const roundCount =
          Array.isArray(session.rounds) ? session.rounds.length : 0;
        totalRounds += roundCount;

        // Tokens — adapt field name (e.g., session.totalTokens, session.tokensUsed)
        const tokens =
          (session as unknown as Record<string, number>).totalTokens ??
          (session as unknown as Record<string, number>).tokensUsed ??
          0;
        totalTokens += tokens;

        // Verdict distribution
        const verdict = String(
          (session as unknown as Record<string, unknown>).verdict ?? 'unknown'
        );
        verdictDistribution[verdict] = (verdictDistribution[verdict] ?? 0) + 1;
      } catch {
        // Skip corrupt entries
      }
    }

    if (validCount === 0) return empty;

    return {
      totalSessions: validCount,
      avgRounds: Math.round((totalRounds / validCount) * 100) / 100,
      avgTokens: Math.round((totalTokens / validCount) * 100) / 100,
      verdictDistribution,
    };
  } catch {
    return empty;
  }
}
```

**Important adjustments to make after reading Step 1:**
- If `DebateSession` uses a different field for session ID (e.g., `id` not `sessionId`), update `saveDebateSession` accordingly.
- If `DebateSession` uses `totalTokens` or `tokensUsed` or a nested object, replace the token extraction logic.
- If `storage.ts`'s `list()` returns pathnames directly as `string[]`, remove the `result?.blobs` branch.
- If `storage.ts`'s `get()` already parses JSON (returns an object), remove the `JSON.parse` calls and cast directly.
- If `DebateSession` doesn't have `repo`/`prNumber` fields directly, update `saveDebateSession` to accept them as separate parameters — but check orchestrator first, as those fields are almost certainly present.

### Step 3: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- Import path for `DebateSession` — may need to import from a types file rather than the orchestrator directly.
- `list()` return type mismatch — narrow with a type guard if needed.

### Step 4: Smoke-test manually (optional but recommended)

```bash
# Check that the module exports resolve correctly without runtime errors
node -e "const s = require('./lib/debate/storage'); console.log(Object.keys(s));"
```

If the project uses `tsx`/`ts-node`:
```bash
npx tsx -e "import('./lib/debate/storage').then(m => console.log(Object.keys(m)))"
```

### Step 5: Build check

```bash
npm run build
```

Resolve any build errors before committing.

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Confirm both pass with no errors.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add debate session persistence to storage"
git push origin feat/add-debate-session-persistence
gh pr create \
  --title "feat: add debate session persistence to storage" \
  --body "## Summary

Adds \`lib/debate/storage.ts\` with four exported async functions for persisting and querying debate sessions via the existing \`lib/storage.ts\` Vercel Blob abstraction.

## Functions added

- \`saveDebateSession\` — writes session JSON to \`af-data/debates/{repo}/{prNumber}/{sessionId}.json\`
- \`getDebateSession\` — reads a single session by repo/PR/sessionId, returns null if missing/corrupt
- \`listDebateSessions\` — lists all sessions for a repo, optionally filtered by PR number
- \`getDebateStats\` — computes aggregate stats (totalSessions, avgRounds, avgTokens, verdictDistribution) across all stored sessions

## Notes

- All functions use \`lib/storage.ts\` exclusively — no direct Vercel Blob SDK calls
- All error paths return safe defaults (null / [] / empty stats object) rather than throwing
- Repo names with \`/\` are encoded as \`__\` in blob paths to avoid unintended path nesting"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-debate-session-persistence
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked on an unresolvable issue (e.g., `DebateSession` type doesn't exist yet, `lib/storage.ts` exports don't match any usable interface, or the debate orchestrator was never merged):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-debate-session-persistence",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error or missing dependency>",
      "filesChanged": ["lib/debate/storage.ts"]
    }
  }'
```