# Agent Forge -- isRepoRegistered Helper in lib/repos.ts

## Metadata
- **Branch:** `feat/is-repo-registered-helper`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/repos.ts

## Context

Agent Forge maintains a registry of target repositories in Vercel Blob storage under `af-data/repos/*`. The `lib/repos.ts` module handles multi-repo registration and per-repo concurrency limits. The `lib/storage.ts` module provides the CRUD primitives for interacting with Vercel Blob (and a local file fallback in development).

Currently, there is no lightweight read-only helper to check whether a given repo is already registered. This helper will be used by other subsystems (e.g., the orchestrator or ATC) to gate operations on registered repos without needing to load the full repo object.

### Existing patterns to follow

From `lib/storage.ts`, storage operations use path-based keys like `af-data/repos/{repoName}`. The existing repo functions in `lib/repos.ts` already read/write using these patterns. The new function must be purely read-only — no mutations, no side effects.

Look at how existing functions in `lib/repos.ts` read repo data (e.g., `getRepo`, `listRepos`, or similar) and follow the same storage lookup pattern. If a `getRepo` function already exists, `isRepoRegistered` can delegate to it and catch/return false on not-found.

## Requirements

1. Function `isRepoRegistered(repoName: string): Promise<boolean>` is exported from `lib/repos.ts`
2. Returns `true` when a repo registration exists in the Blob store for the given `repoName`
3. Returns `false` when no registration exists for the given `repoName`
4. Is purely read-only — does not write, update, or delete any data in the Blob store
5. TypeScript compiles without errors (`npx tsc --noEmit` passes)
6. Handles errors gracefully: if the storage lookup throws a not-found or similar error, return `false` rather than propagating the exception

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/is-repo-registered-helper
```

### Step 1: Read existing code

Before writing anything, read the relevant files to understand existing patterns:

```bash
cat lib/repos.ts
cat lib/storage.ts
```

Key things to look for in `lib/repos.ts`:
- How repos are keyed in storage (e.g., `af-data/repos/${repoName}` or similar)
- Whether a `getRepo(repoName)` function already exists
- What the repo type/interface looks like
- What storage functions are imported from `lib/storage.ts`

Key things to look for in `lib/storage.ts`:
- Available read functions (e.g., `getBlob`, `readFile`, `getBlobJson`, etc.)
- How not-found cases are handled (null return vs. thrown error)

### Step 2: Implement `isRepoRegistered`

Add the following function to `lib/repos.ts`. The exact implementation depends on the existing patterns observed in Step 1. Use one of these approaches:

**Option A — Delegate to existing `getRepo` (preferred if it exists):**
```typescript
export async function isRepoRegistered(repoName: string): Promise<boolean> {
  try {
    const repo = await getRepo(repoName);
    return repo !== null && repo !== undefined;
  } catch {
    return false;
  }
}
```

**Option B — Direct storage lookup (if no `getRepo` exists):**
```typescript
export async function isRepoRegistered(repoName: string): Promise<boolean> {
  try {
    const data = await readData(`af-data/repos/${repoName}`); // use the actual storage function name
    return data !== null && data !== undefined;
  } catch {
    return false;
  }
}
```

**Important:** Use whichever storage function and key pattern is already in use in `lib/repos.ts`. Do not introduce new storage patterns. Match the exact key format used by the existing repo functions.

Place the function near other read-only repo utility functions (e.g., after `getRepo` or `listRepos` if they exist).

### Step 3: Verification

```bash
# Type check — must pass with zero errors
npx tsc --noEmit

# Build check
npm run build

# Run tests if they exist
npm test 2>/dev/null || echo "No test suite found"
```

If `npx tsc --noEmit` reports errors in `lib/repos.ts`, fix them before proceeding. Do not introduce `any` types — if the return type of a storage function is unclear, check its signature in `lib/storage.ts`.

### Step 4: Commit, push, open PR

```bash
git add lib/repos.ts
git commit -m "feat: add isRepoRegistered helper to lib/repos.ts"
git push origin feat/is-repo-registered-helper
gh pr create \
  --title "feat: add isRepoRegistered helper to lib/repos.ts" \
  --body "## Summary

Adds \`isRepoRegistered(repoName: string): Promise<boolean>\` to \`lib/repos.ts\`.

## Changes
- \`lib/repos.ts\`: New exported read-only helper that checks Vercel Blob for an existing repo registration by name

## Behavior
- Returns \`true\` if a registration exists for the given repo name
- Returns \`false\` if no registration exists, or if the storage lookup throws
- No mutations — purely read-only

## Acceptance Criteria
- [x] Function exported from \`lib/repos.ts\`
- [x] Returns \`true\` for registered repos
- [x] Returns \`false\` for unregistered repos
- [x] Read-only (no Blob mutations)
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
BRANCH: feat/is-repo-registered-helper
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you hit a blocker you cannot resolve (e.g., `lib/repos.ts` does not exist, storage API is completely different from expected, or TypeScript errors cannot be resolved after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "is-repo-registered-helper",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/repos.ts"]
    }
  }'
```