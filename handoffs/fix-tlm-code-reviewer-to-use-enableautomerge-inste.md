<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix TLM Code Reviewer to use enableAutoMerge instead of direct merge

## Metadata
- **Branch:** `fix/tlm-reviewer-auto-merge`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** `.github/actions/tlm-review/src/index.ts`

## Context

Branch protection is now enabled on `main` requiring the `build` check to pass before merge. The TLM Code Reviewer currently calls `octokit.rest.pulls.merge()` (direct squash merge) immediately upon approving a PR. With branch protection active, this will fail with a 405 error because required CI checks haven't passed yet.

The fix is to replace the direct merge call with GitHub's `enableAutoMerge` GraphQL mutation. This tells GitHub to wait for all required status checks to pass and then automatically merge the PR — exactly what we want.

The TLM Code Reviewer lives in `.github/actions/tlm-review/src/index.ts`. It:
1. Reads the PR diff and codebase context
2. Runs Claude to assess risk and quality
3. Submits an approving review
4. Calls `octokit.rest.pulls.merge()` — **this is what we need to fix**

The GraphQL mutation to use:
```graphql
mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod}) {
    pullRequest { autoMergeRequest { enabledAt } }
  }
}
```

The `node_id` field on the PR REST response is the GraphQL ID needed for `pullRequestId`.

## Requirements

1. Locate all calls to `octokit.rest.pulls.merge()` (or `gh pr merge` CLI calls) in `.github/actions/tlm-review/src/index.ts` and replace them with the `enableAutoMerge` GraphQL mutation.
2. Fetch the PR's `node_id` from the REST API response (it is returned on `octokit.rest.pulls.get()` and `octokit.rest.pulls.list()` responses) and pass it as `pullRequestId` to the mutation.
3. Use `SQUASH` as the merge method (matching the previous direct squash merge behavior).
4. Handle the case where auto-merge is already enabled — check for a GraphQL error message containing `"auto-merge is already enabled"` and log it as INFO rather than throwing.
5. Handle the case where the PR has merge conflicts — check `mergeable` field or catch GraphQL errors indicating conflicts, log clearly, and do NOT mark as error (the PR simply can't be merged).
6. Log the outcome clearly in a format the Outcome Tracker can parse:
   - Success: `[TLM-REVIEW] Auto-merge enabled for PR #<N> (merges when CI passes)`
   - Already enabled: `[TLM-REVIEW] Auto-merge already enabled for PR #<N>, skipping`
   - Conflicts: `[TLM-REVIEW] PR #<N> has merge conflicts, skipping auto-merge`
   - Error: `[TLM-REVIEW] Failed to enable auto-merge for PR #<N>: <error>`
7. The overall action must still exit 0 on success (including "already enabled" and "conflicts" cases).
8. TypeScript must compile without errors.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/tlm-reviewer-auto-merge
```

### Step 1: Inspect the current TLM review action source
```bash
cat .github/actions/tlm-review/src/index.ts
```

Read the full file carefully. Identify:
- Where `octokit.rest.pulls.merge()` is called (or any `gh pr merge` CLI invocation)
- How the `octokit` client is constructed (to confirm it supports `.graphql`)
- How the PR number, owner, and repo are obtained
- Whether the PR REST object is already fetched (to get `node_id`)

Also check if there are compiled/bundled output files that need updating:
```bash
ls .github/actions/tlm-review/
ls .github/actions/tlm-review/dist/ 2>/dev/null || echo "no dist dir"
```

### Step 2: Check package.json for build tooling
```bash
cat .github/actions/tlm-review/package.json
```

Note the build command (likely `npm run build` using `ncc` or `tsc`). We'll need to rebuild after editing.

### Step 3: Implement the fix in index.ts

Find the merge logic and replace it. The new function should look like this (adapt to match actual variable names in the file):

```typescript
// Helper function to enable auto-merge via GraphQL
async function enableAutoMerge(
  octokit: InstanceType<typeof GitHub>,
  prNodeId: string,
  prNumber: number
): Promise<void> {
  console.log(`[TLM-REVIEW] Enabling auto-merge for PR #${prNumber}...`);
  
  try {
    const result = await octokit.graphql<{
      enablePullRequestAutoMerge: {
        pullRequest: {
          autoMergeRequest: {
            enabledAt: string;
          } | null;
        };
      };
    }>(
      `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId,
          mergeMethod: $mergeMethod
        }) {
          pullRequest {
            autoMergeRequest {
              enabledAt
            }
          }
        }
      }`,
      {
        pullRequestId: prNodeId,
        mergeMethod: 'SQUASH',
      }
    );

    const enabledAt = result.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt;
    console.log(`[TLM-REVIEW] Auto-merge enabled for PR #${prNumber} (merges when CI passes). EnabledAt: ${enabledAt}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    
    if (message.toLowerCase().includes('auto-merge is already enabled')) {
      console.log(`[TLM-REVIEW] Auto-merge already enabled for PR #${prNumber}, skipping`);
      return;
    }
    
    if (
      message.toLowerCase().includes('conflict') ||
      message.toLowerCase().includes('not mergeable')
    ) {
      console.log(`[TLM-REVIEW] PR #${prNumber} has merge conflicts, skipping auto-merge`);
      return;
    }
    
    console.error(`[TLM-REVIEW] Failed to enable auto-merge for PR #${prNumber}: ${message}`);
    throw error;
  }
}
```

Then replace the call site where `octokit.rest.pulls.merge(...)` is called with:

```typescript
// Get the PR node_id (it's on the PR object from the REST API)
// If prData is already fetched above, use prData.data.node_id
// Otherwise fetch it:
const { data: prDetails } = await octokit.rest.pulls.get({
  owner,
  repo,
  pull_number: prNumber,
});

await enableAutoMerge(octokit, prDetails.node_id, prNumber);
```

**Important:** If the PR object is already fetched earlier in the function, reuse it rather than fetching again — just access `.node_id` from the existing variable.

### Step 4: Build the action

```bash
cd .github/actions/tlm-review
npm install
npm run build
```

If the build command isn't clear from package.json, try:
```bash
npx ncc build src/index.ts -o dist --source-map --no-source-map-register
```

Confirm `dist/index.js` (or equivalent entry point referenced in `action.yml`) was updated:
```bash
ls -la dist/
head -5 dist/index.js
```

### Step 5: Check action.yml to confirm entry point
```bash
cat .github/actions/tlm-review/action.yml
```

Confirm the `runs.main` field points to the correct built output (e.g., `dist/index.js`). If the action uses `node20` and `dist/index.js`, the build step above is sufficient.

### Step 6: TypeScript check
```bash
cd .github/actions/tlm-review
npx tsc --noEmit 2>&1 || echo "TSC check done"
```

Resolve any type errors before proceeding.

### Step 7: Verify the root repo still builds (if applicable)
```bash
cd ../../..  # back to repo root
npx tsc --noEmit 2>&1 || echo "Root TSC done"
npm run build 2>&1 || echo "Root build done"
```

### Step 8: Commit, push, open PR
```bash
git add -A
git commit -m "fix: replace direct merge with enableAutoMerge GraphQL in TLM Code Reviewer

Branch protection on main now requires CI to pass before merge.
The previous octokit.rest.pulls.merge() call fails with 405 because
CI hasn't passed at review time.

Replace with enablePullRequestAutoMerge GraphQL mutation using SQUASH
strategy. GitHub will wait for required checks then merge automatically.

Handles: already-enabled (idempotent), merge conflicts (skip gracefully).
Logs clearly for Outcome Tracker parsing."

git push origin fix/tlm-reviewer-auto-merge

gh pr create \
  --title "fix: replace direct merge with enableAutoMerge in TLM Code Reviewer" \
  --body "## Problem

Branch protection on \`main\` now requires the \`build\` check to pass before merge. The TLM Code Reviewer was calling \`octokit.rest.pulls.merge()\` immediately after approving, which fails with **405** because CI hasn't passed yet.

## Fix

Replace the direct merge call with GitHub's \`enablePullRequestAutoMerge\` GraphQL mutation. The Code Reviewer now:

1. ✅ Submits an approving review (unchanged)
2. ✅ Calls \`enableAutoMerge\` with \`SQUASH\` strategy (new)
3. ✅ GitHub waits for required checks, then merges automatically

## Error Handling

- **Already enabled**: logs INFO, exits 0 (idempotent)
- **Merge conflicts**: logs warning, skips auto-merge, exits 0
- **Other errors**: logs error, re-throws

## Logging Format (for Outcome Tracker)

\`\`\`
[TLM-REVIEW] Auto-merge enabled for PR #N (merges when CI passes)
[TLM-REVIEW] Auto-merge already enabled for PR #N, skipping
[TLM-REVIEW] PR #N has merge conflicts, skipping auto-merge
[TLM-REVIEW] Failed to enable auto-merge for PR #N: <error>
\`\`\`

## Files Changed

- \`.github/actions/tlm-review/src/index.ts\` — replaced merge logic
- \`.github/actions/tlm-review/dist/index.js\` — rebuilt bundle" \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles (including partial changes)
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/tlm-reviewer-auto-merge
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "ncc build failed with error X", "could not find merge call in index.ts"]
NEXT STEPS: [what remains — e.g., "resolve TypeScript error on line 42", "rebuild dist/"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., `node_id` is not present on the octokit response type, the action uses a CLI `gh` call instead of octokit and the pattern differs significantly, or `enableAutoMerge` requires a different token scope than available):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-tlm-reviewer-auto-merge",
    "reason": "<concise description of blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": [".github/actions/tlm-review/src/index.ts"]
    }
  }'
```