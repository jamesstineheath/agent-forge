# Agent Forge -- Add closePRWithReason() to lib/github.ts

## Metadata
- **Branch:** `feat/close-pr-with-reason`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/github.ts

## Context

Agent Forge's `lib/github.ts` is a GitHub API wrapper used throughout the control plane for managing branches, pushes, workflow triggers, and PR lookups. We need to add a `closePRWithReason()` function that posts a structured markdown comment explaining why a PR is being closed, then closes the PR, and optionally deletes its branch if no other PRs reference it.

This function will be used by the ATC and escalation subsystems to programmatically close stale, superseded, or timed-out PRs with a human-readable audit trail.

Existing patterns in `lib/github.ts` use a `GH_PAT` environment variable for auth, make fetch calls to `https://api.github.com`, and return typed data. Follow those patterns exactly.

## Requirements

1. Export `closePRWithReason()` from `lib/github.ts` with the exact signature specified below
2. Post a structured markdown comment to the PR before closing it, including:
   - Heading: `## 🤖 PR Auto-Closed`
   - Human-readable reason label mapped from the reason union type
   - Details paragraph
   - If `supersededBy` is provided: a link line `Superseded by #${supersededBy}`
   - ISO timestamp
3. PATCH the PR to `state: 'closed'`
4. If the branch exists and no other open PRs reference it, delete the branch via `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`
5. Function signature must use the exact reason union type: `'sla_timeout' | 'superseded' | 'merge_conflicts' | 'stale'`
6. `npm run build` passes with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/close-pr-with-reason
```

### Step 1: Inspect existing lib/github.ts patterns

Read the file to understand existing auth, fetch patterns, error handling, and exports:

```bash
cat lib/github.ts
```

Note:
- How the GitHub PAT is accessed (likely `process.env.GH_PAT`)
- The base URL pattern (likely `https://api.github.com`)
- How errors are handled (thrown vs returned)
- Whether there's a shared `githubFetch` helper or similar

### Step 2: Implement closePRWithReason()

Add the following to `lib/github.ts`. Place it near other PR-related functions. Adapt the auth/fetch style to match existing code exactly.

```typescript
const REASON_LABELS: Record<string, string> = {
  sla_timeout: 'SLA timeout (24h with no progress)',
  superseded: 'Superseded by a newer work item',
  merge_conflicts: 'Unresolvable merge conflicts',
  stale: 'Stale — no activity for an extended period',
};

export async function closePRWithReason(
  owner: string,
  repo: string,
  prNumber: number,
  reason: 'sla_timeout' | 'superseded' | 'merge_conflicts' | 'stale',
  details: string,
  supersededBy?: number
): Promise<void> {
  const token = process.env.GH_PAT;
  const baseUrl = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Step 1: Fetch PR details to get branch name
  const prRes = await fetch(`${baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  if (!prRes.ok) {
    throw new Error(`Failed to fetch PR #${prNumber}: ${prRes.status} ${await prRes.text()}`);
  }
  const pr = await prRes.json();
  const branchName: string = pr.head.ref;

  // Step 2: Build and post structured comment
  const timestamp = new Date().toISOString();
  const reasonLabel = REASON_LABELS[reason] ?? reason;
  const supersededLine = supersededBy != null ? `\n**Superseded by:** #${supersededBy}\n` : '';
  const commentBody = [
    '## 🤖 PR Auto-Closed',
    '',
    `**Reason:** ${reasonLabel}`,
    '',
    details,
    supersededLine,
    `**Closed at:** ${timestamp}`,
  ].join('\n');

  const commentRes = await fetch(
    `${baseUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: commentBody }),
    }
  );
  if (!commentRes.ok) {
    throw new Error(`Failed to post comment on PR #${prNumber}: ${commentRes.status} ${await commentRes.text()}`);
  }

  // Step 3: Close the PR
  const closeRes = await fetch(`${baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!closeRes.ok) {
    throw new Error(`Failed to close PR #${prNumber}: ${closeRes.status} ${await closeRes.text()}`);
  }

  // Step 4: Check if other open PRs reference this branch, delete if none do
  const otherPRsRes = await fetch(
    `${baseUrl}/repos/${owner}/${repo}/pulls?head=${owner}:${branchName}&state=open`,
    { headers }
  );
  if (otherPRsRes.ok) {
    const otherPRs = await otherPRsRes.json();
    if (Array.isArray(otherPRs) && otherPRs.length === 0) {
      // No other open PRs reference this branch — safe to delete
      const deleteRes = await fetch(
        `${baseUrl}/repos/${owner}/${repo}/git/refs/heads/${branchName}`,
        { method: 'DELETE', headers }
      );
      // 422 means ref doesn't exist; both 204 and 422 are acceptable
      if (!deleteRes.ok && deleteRes.status !== 422) {
        // Non-fatal: log but don't throw
        console.warn(
          `closePRWithReason: could not delete branch ${branchName}: ${deleteRes.status}`
        );
      }
    }
  } else {
    console.warn(
      `closePRWithReason: could not check for other PRs on branch ${branchName}: ${otherPRsRes.status}`
    );
  }
}
```

**Important:** After reading the existing file in Step 1, adapt the auth/fetch pattern to match exactly. For example:
- If there's a shared helper like `ghFetch()` or `octokit`, use that instead of raw `fetch`.
- If headers are constructed differently (e.g., a shared `getHeaders()` function), use that.
- If error handling uses a different convention (e.g., returning `null` vs throwing), match it.

### Step 3: Verify TypeScript and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors before proceeding.

### Step 4: Commit, push, open PR

```bash
git add lib/github.ts
git commit -m "feat: add closePRWithReason() to lib/github.ts"
git push origin feat/close-pr-with-reason
gh pr create \
  --title "feat: add closePRWithReason() to lib/github.ts" \
  --body "## Summary

Adds \`closePRWithReason()\` to \`lib/github.ts\` for programmatically closing PRs with a structured audit trail.

## Changes
- \`lib/github.ts\`: new exported function \`closePRWithReason()\`

## Behavior
1. Fetches PR to get branch name
2. Posts a structured markdown comment with reason, details, optional superseded-by reference, and timestamp
3. PATCHes PR state to \`closed\`
4. Deletes the branch if no other open PRs reference it (non-fatal if deletion fails)

## Reason types
- \`sla_timeout\` → SLA timeout (24h with no progress)
- \`superseded\` → Superseded by a newer work item
- \`merge_conflicts\` → Unresolvable merge conflicts
- \`stale\` → Stale — no activity for an extended period

## Acceptance Criteria
- [x] Exported function with correct signature and reason union type
- [x] Structured markdown comment posted before closing
- [x] PR closed via PATCH
- [x] supersededBy reference included when provided
- [x] Branch deleted when no other open PRs reference it
- [x] \`npm run build\` passes"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/close-pr-with-reason
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked (e.g., `lib/github.ts` uses a fundamentally different HTTP client that makes the implementation pattern ambiguous, or build fails with errors that cannot be resolved after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-close-pr-with-reason",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/github.ts"]
    }
  }'
```