# Agent Forge -- Add getPRLifecycleState() to lib/github.ts

## Metadata
- **Branch:** `feat/add-get-pr-lifecycle-state`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/github.ts

## Context

Agent Forge uses a Handoff Lifecycle Orchestrator (HLO) in target repos that writes lifecycle state to PR comments using `<!-- LIFECYCLE-JSON:{...}:LIFECYCLE-JSON -->` markers. The control plane (`lib/github.ts`) needs a way to read this lifecycle state back from PRs to track execution progress.

`lib/github.ts` already contains a GitHub API wrapper with functions like `getPRForBranch`, `getWorkflowRunStatus`, etc. This task adds `getPRLifecycleState()` following the same patterns.

The `HLOLifecycleState` type was recently added to `lib/types.ts` (see recent merged PRs: "feat: add HLO state types and 'superseded' status to types.ts").

The function must be resilient: no comments, malformed JSON, or missing markers should all return `null` rather than throwing.

## Requirements

1. Add `getPRLifecycleState(owner: string, repo: string, prNumber: number): Promise<HLOLifecycleState | null>` to `lib/github.ts`
2. Function must be exported
3. Use the existing GitHub API wrapper pattern in `lib/github.ts` (same auth headers, base URL, fetch approach)
4. Call `GET /repos/{owner}/{repo}/issues/{prNumber}/comments` to retrieve PR comments
5. Iterate comments in **reverse order** (most recent first) to find the latest lifecycle state
6. Extract JSON between `<!-- LIFECYCLE-JSON:` and `:LIFECYCLE-JSON -->` markers
7. Parse and validate against `HLOLifecycleState` from `lib/types.ts`; return `null` if not found or parse fails
8. Handle all edge cases gracefully (no comments, malformed JSON, missing markers, API errors) — return `null`, never throw
9. Project must build successfully with `npm run build`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-get-pr-lifecycle-state
```

### Step 1: Inspect existing code

Read the relevant files to understand patterns before writing any code:

```bash
cat lib/github.ts
cat lib/types.ts
```

Key things to note from `lib/github.ts`:
- How the GitHub PAT token is accessed (likely `process.env.GH_PAT`)
- The base URL pattern used for GitHub API calls
- How auth headers are constructed
- How other functions handle errors (do they throw or return null?)

Key things to note from `lib/types.ts`:
- The exact shape of `HLOLifecycleState` — note all fields so the function can validate the parsed object

### Step 2: Add the import and implement the function

Add `HLOLifecycleState` to the import from `lib/types.ts` at the top of `lib/github.ts` (it may already be imported — check first).

Then add the following function to `lib/github.ts`, adapted to match the existing code style:

```typescript
export async function getPRLifecycleState(
  owner: string,
  repo: string,
  prNumber: number
): Promise<HLOLifecycleState | null> {
  try {
    const token = process.env.GH_PAT;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    // Fetch all comments on the PR (issues endpoint covers PR comments)
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
      { headers }
    );

    if (!response.ok) {
      return null;
    }

    const comments: Array<{ body: string }> = await response.json();

    // Iterate in reverse to find the most recent lifecycle comment
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = comments[i].body ?? "";
      const startMarker = "<!-- LIFECYCLE-JSON:";
      const endMarker = ":LIFECYCLE-JSON -->";

      const startIdx = body.indexOf(startMarker);
      if (startIdx === -1) continue;

      const jsonStart = startIdx + startMarker.length;
      const endIdx = body.indexOf(endMarker, jsonStart);
      if (endIdx === -1) continue;

      const jsonStr = body.slice(jsonStart, endIdx).trim();

      try {
        const parsed = JSON.parse(jsonStr) as HLOLifecycleState;
        // Basic validation: ensure it has at least a 'state' field
        if (parsed && typeof parsed.state === "string") {
          return parsed;
        }
      } catch {
        // Malformed JSON — keep looking at older comments
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}
```

**Important:** Match the exact auth header construction, fetch options, and error handling style already used in `lib/github.ts`. If the existing file uses a helper function for headers or fetch, use that helper instead of replicating the pattern manually.

### Step 3: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `HLOLifecycleState` import missing or using wrong field name for validation
- The `comments` array type not matching the actual API response shape used elsewhere in the file

### Step 4: Build verification

```bash
npm run build
```

The build must succeed with no errors.

### Step 5: Quick smoke check (optional but recommended)

Grep to confirm the function is exported and present:

```bash
grep -n "getPRLifecycleState" lib/github.ts
```

Should show the `export async function getPRLifecycleState` line.

Confirm the import of `HLOLifecycleState` is present:

```bash
grep -n "HLOLifecycleState" lib/github.ts
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add getPRLifecycleState() to lib/github.ts"
git push origin feat/add-get-pr-lifecycle-state
gh pr create \
  --title "feat: add getPRLifecycleState() to lib/github.ts" \
  --body "## Summary

Adds \`getPRLifecycleState()\` to \`lib/github.ts\` to parse HLO lifecycle state from PR comments by reading \`<!-- LIFECYCLE-JSON:...:LIFECYCLE-JSON -->\` markers.

## Changes
- \`lib/github.ts\`: Added exported \`getPRLifecycleState(owner, repo, prNumber)\` function

## Behavior
- Fetches PR comments via \`GET /repos/{owner}/{repo}/issues/{prNumber}/comments\`
- Iterates in reverse order (most recent first) to find the latest lifecycle state comment
- Extracts and parses JSON between LIFECYCLE-JSON markers
- Returns \`HLOLifecycleState | null\` — never throws, returns null for missing/malformed markers or API errors

## Acceptance Criteria
- [x] Function exported from lib/github.ts with correct signature
- [x] Correctly parses LIFECYCLE-JSON markers and returns typed HLOLifecycleState
- [x] Returns null when no lifecycle comment exists
- [x] Returns null (does not throw) when JSON is malformed
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
BRANCH: feat/add-get-pr-lifecycle-state
FILES CHANGED: [lib/github.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., `HLOLifecycleState` does not exist in `lib/types.ts`, the GitHub API wrapper uses a fundamentally different pattern than expected, or the build fails with errors you cannot resolve after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-get-pr-lifecycle-state",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/github.ts"]
    }
  }'
```