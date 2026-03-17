# Agent Forge -- Add getCommitsBehindMain() to lib/github.ts

## Metadata
- **Branch:** `feat/add-get-commits-behind-main`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/github.ts

## Context

Agent Forge's `lib/github.ts` is a GitHub API wrapper used by the control plane to interact with target repositories. It wraps Octokit or raw fetch calls with `GH_PAT` for authentication, and exposes helper functions for branches, pushes, workflow triggers, PR lookups, etc.

This task adds a single utility function `getCommitsBehindMain()` that uses the GitHub Compare API to determine how far behind `main` a given branch is. This is useful for the ATC and orchestrator to detect stale branches before dispatching work or triggering merges.

The function must follow existing patterns in `lib/github.ts` — inspect the file first to understand auth headers, error handling conventions, and whether Octokit or raw fetch is used.

## Requirements

1. Export a new async function `getCommitsBehindMain(owner: string, repo: string, branch: string): Promise<number>` from `lib/github.ts`
2. The function calls `GET /repos/{owner}/{repo}/compare/{branch}...main` (GitHub Compare API)
3. Returns the `behind_by` field from the response as a number
4. Returns `0` defensively if the API call fails (any error, including network, 404, 422, etc.) rather than throwing
5. Returns `0` if the branch is already up to date (`behind_by === 0`)
6. Follows the existing auth and error-handling patterns already present in `lib/github.ts` (same auth mechanism, same fetch/Octokit style)
7. Project builds successfully with `npm run build` and `npx tsc --noEmit`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-get-commits-behind-main
```

### Step 1: Inspect existing patterns in lib/github.ts

Read the file carefully before writing any code:

```bash
cat lib/github.ts
```

Note:
- How authentication is set up (Octokit instance, or raw fetch with `Authorization: Bearer ${process.env.GH_PAT}`)
- How errors are caught and handled in existing functions
- The module's export style (named exports, default export, etc.)
- Any existing compare/diff utilities to avoid duplication

### Step 2: Implement getCommitsBehindMain

Add the following function to `lib/github.ts`, adapting the auth/fetch pattern to match what already exists in the file.

**If the file uses raw fetch with GH_PAT**, add:

```typescript
export async function getCommitsBehindMain(
  owner: string,
  repo: string,
  branch: string
): Promise<number> {
  try {
    const token = process.env.GH_PAT;
    const url = `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(branch)}...main`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return typeof data.behind_by === "number" ? data.behind_by : 0;
  } catch {
    return 0;
  }
}
```

**If the file uses an Octokit instance**, add:

```typescript
export async function getCommitsBehindMain(
  owner: string,
  repo: string,
  branch: string
): Promise<number> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${branch}...main`,
    });
    return typeof data.behind_by === "number" ? data.behind_by : 0;
  } catch {
    return 0;
  }
}
```

Place the function near other comparison/status utilities if they exist, or at the end of the file before any default export.

### Step 3: Verification

```bash
npx tsc --noEmit
npm run build
```

Ensure:
- No TypeScript errors
- Build completes successfully
- The function is exported (verify with a quick grep):

```bash
grep -n "getCommitsBehindMain" lib/github.ts
```

### Step 4: Commit, push, open PR

```bash
git add lib/github.ts
git commit -m "feat: add getCommitsBehindMain() to lib/github.ts"
git push origin feat/add-get-commits-behind-main
gh pr create \
  --title "feat: add getCommitsBehindMain() to lib/github.ts" \
  --body "## Summary

Adds \`getCommitsBehindMain(owner, repo, branch)\` to \`lib/github.ts\`.

## Changes
- **lib/github.ts**: New exported async function using GitHub Compare API (\`GET /repos/{owner}/{repo}/compare/{branch}...main\`) to return \`behind_by\` count
- Returns \`0\` defensively on any API error (network, 404, 422, etc.)
- Follows existing auth/fetch patterns in the file

## Acceptance Criteria
- [x] Function exported with correct signature
- [x] Calls GitHub compare API endpoint
- [x] Returns 0 on failure (defensive)
- [x] Follows existing patterns in lib/github.ts
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-get-commits-behind-main
FILES CHANGED: lib/github.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If blocked on an unresolvable issue (e.g., `lib/github.ts` uses an unexpected pattern, missing env config, or build errors that can't be resolved in 3 attempts), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-get-commits-behind-main",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/github.ts"]
    }
  }'
```