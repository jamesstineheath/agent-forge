# Agent Forge -- Add rebasePR() to lib/github.ts

## Metadata
- **Branch:** `feat/add-rebase-pr-to-github`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/github.ts

## Context

Agent Forge communicates with target repos via the GitHub API. `lib/github.ts` is the central GitHub API wrapper used throughout the control plane for branches, pushes, workflow triggers, and PR lookups.

The ATC (Air Traffic Controller) and related subsystems need the ability to rebase stale PR branches onto the latest `main` to keep executions unblocked. GitHub provides a native endpoint for this: `PUT /repos/{owner}/{repo}/pulls/{prNumber}/update-branch`, which performs a non-destructive rebase — on conflict, it returns a 409 rather than corrupting the branch.

A recent merged PR added `getCommitsBehindMain()` to `lib/github.ts`, indicating the codebase is actively building out PR-management utilities. `rebasePR()` is the natural companion function.

The existing pattern in `lib/github.ts` uses `octokit` (or direct `fetch` with `GH_PAT`) for GitHub REST calls. Follow the existing auth/request pattern in the file exactly.

## Requirements

1. Add an exported async function `rebasePR(owner: string, repo: string, prNumber: number): Promise<{ success: boolean; error?: string }>` to `lib/github.ts`.
2. The function must first GET the PR (`GET /repos/{owner}/{repo}/pulls/{prNumber}`) to obtain the current head SHA.
3. The function must call `PUT /repos/{owner}/{repo}/pulls/{prNumber}/update-branch` with body `{ "expected_head_sha": "<head_sha>" }`.
4. On a 202 response, return `{ success: true }`.
5. On a 409 (conflict) or any other non-202 response, return `{ success: false, error: '<descriptive message>' }` without throwing.
6. On any thrown exception (network error, etc.), catch and return `{ success: false, error: '<error message>' }` without re-throwing.
7. The project must build successfully with `npm run build`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-rebase-pr-to-github
```

### Step 1: Inspect lib/github.ts to understand existing patterns

Read the entire file to understand:
- How GitHub API requests are made (octokit vs. raw fetch)
- How the `GH_PAT` env var is used
- How errors are handled
- Where to append the new function and export

```bash
cat lib/github.ts
```

### Step 2: Implement rebasePR()

Append the following function to `lib/github.ts`, adapting the auth/request pattern to match the existing code exactly (e.g., if the file uses `octokit.request()`, use that; if it uses raw `fetch` with `Authorization: Bearer ${process.env.GH_PAT}`, use that).

**Reference implementation using raw fetch** (adapt if the file uses octokit):

```typescript
export async function rebasePR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ success: boolean; error?: string }> {
  const token = process.env.GH_PAT;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    // Step 1: GET the PR to obtain the current head SHA
    const prRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      { headers }
    );

    if (!prRes.ok) {
      const text = await prRes.text();
      return {
        success: false,
        error: `Failed to fetch PR #${prNumber}: ${prRes.status} ${text}`,
      };
    }

    const prData = await prRes.json();
    const expectedHeadSha: string = prData.head.sha;

    // Step 2: PUT update-branch with expected_head_sha
    const updateRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/update-branch`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ expected_head_sha: expectedHeadSha }),
      }
    );

    if (updateRes.status === 202) {
      return { success: true };
    }

    if (updateRes.status === 409) {
      const body = await updateRes.json().catch(() => ({}));
      return {
        success: false,
        error: `Merge conflict rebasing PR #${prNumber}: ${body.message ?? "conflict"}`,
      };
    }

    const errText = await updateRes.text();
    return {
      success: false,
      error: `Unexpected response rebasing PR #${prNumber}: ${updateRes.status} ${errText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `rebasePR error: ${message}` };
  }
}
```

**If the file uses octokit**, adapt as follows:
```typescript
export async function rebasePR(
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ success: boolean; error?: string }> {
  try {
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const expectedHeadSha = pr.data.head.sha;

    await octokit.rest.pulls.updateBranch({
      owner,
      repo,
      pull_number: prNumber,
      expected_head_sha: expectedHeadSha,
    });

    return { success: true };
  } catch (err: unknown) {
    // octokit throws RequestError with status for HTTP errors
    if (
      typeof err === "object" &&
      err !== null &&
      "status" in err &&
      (err as { status: number }).status === 409
    ) {
      return {
        success: false,
        error: `Merge conflict rebasing PR #${prNumber}`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `rebasePR error: ${message}` };
  }
}
```

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 4: Build verification

```bash
npm run build
```

The build must complete without errors. Fix any issues found.

### Step 5: Sanity check the export

```bash
grep -n "rebasePR" lib/github.ts
```

Confirm the function signature and export keyword are present.

### Step 6: Commit, push, open PR

```bash
git add lib/github.ts
git commit -m "feat: add rebasePR() to lib/github.ts"
git push origin feat/add-rebase-pr-to-github
gh pr create \
  --title "feat: add rebasePR() to lib/github.ts" \
  --body "## Summary

Adds \`rebasePR(owner, repo, prNumber)\` to \`lib/github.ts\`.

Uses GitHub's native \`PUT /repos/{owner}/{repo}/pulls/{prNumber}/update-branch\` endpoint with the PR's current head SHA as \`expected_head_sha\`.

## Behavior
- Returns \`{ success: true }\` on 202 (GitHub accepted the rebase request)
- Returns \`{ success: false, error: string }\` on 409 conflict or any other HTTP error
- Returns \`{ success: false, error: string }\` on network/thrown exceptions — never throws

## Testing
- \`npx tsc --noEmit\` ✅
- \`npm run build\` ✅

## Acceptance Criteria
- [x] Exported from lib/github.ts with correct signature
- [x] Calls PUT update-branch with expected_head_sha from GET PR response
- [x] Returns { success: true } on 202
- [x] Returns { success: false, error } on conflict or error without throwing
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
BRANCH: feat/add-rebase-pr-to-github
FILES CHANGED: lib/github.ts
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If encountering a blocker that cannot be resolved autonomously (e.g., `lib/github.ts` uses an unexpected auth mechanism, the `octokit.rest.pulls.updateBranch` method is not available in the installed version, or TypeScript errors cannot be resolved after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-rebase-pr-to-github",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/github.ts"]
    }
  }'
```