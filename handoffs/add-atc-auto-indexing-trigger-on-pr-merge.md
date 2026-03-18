# Agent Forge -- Add ATC Auto-Indexing Trigger on PR Merge

## Metadata
- **Branch:** `feat/atc-auto-indexing-trigger`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

Agent Forge's Air Traffic Controller (`lib/atc.ts`) runs as a Vercel cron job that monitors work item executions, reconciles PR states, and manages the work item pipeline. In §2.8, it already polls GitHub for PR status and transitions work items to "merged" when their PRs are detected as merged.

The knowledge graph subsystem (recently merged PRs show `lib/knowledge-graph/storage.ts`, `lib/knowledge-graph/parser.ts`, `lib/knowledge-graph/resolver.ts`, `lib/knowledge-graph/query.ts`) provides incremental indexing capabilities. The goal is to wire the ATC into the knowledge graph so that:

1. **On PR merge** (§2.8 reconciliation): call `incrementalIndex(repo, changedFiles)` with the changed files from that PR
2. **Periodically** (new §14): full re-index any repo whose snapshot is older than 7 days, limited to 1 per cycle

The `incrementalIndex` function lives in the knowledge graph module. You'll need to locate the exact export path (likely `lib/knowledge-graph/storage.ts` or a dedicated indexer module) by inspecting the repo before making changes.

**No file overlap** with concurrent branch `fix/add-risk-level-detection-utility-for-prs` (touches `lib/debate/risk-detector.ts` and its test only).

## Requirements

1. `lib/atc.ts` imports `incrementalIndex` from the knowledge graph module (exact path TBD by inspection)
2. In the §2.8 Failed Work Item PR Reconciliation flow, after a work item transitions to `merged`, the ATC fetches the PR's changed files from the GitHub API and calls `incrementalIndex(repo, changedFiles)`
3. The result (success or failure) is logged to the ATC cycle output; errors must NOT throw or halt the ATC cycle
4. A new §14 section runs a periodic full re-index check: inspect `RepoSnapshot.lastIndexed` for each registered repo, trigger a full re-index if `lastIndexed` is older than 7 days
5. Full re-indexing in §14 is capped at 1 repo per ATC cycle
6. ATC cycle continues normally if §14 re-indexing fails (error logged, not thrown)
7. TypeScript compiles without errors (`npx tsc --noEmit`)
8. `npm run build` succeeds

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/atc-auto-indexing-trigger
```

### Step 1: Inspect the knowledge graph module for the correct import path

Before touching `lib/atc.ts`, inspect the knowledge graph module to find the correct export:

```bash
# Find incrementalIndex export
grep -rn "incrementalIndex\|export.*index\|fullIndex" lib/knowledge-graph/
grep -rn "incrementalIndex\|fullIndex" lib/

# Also check types for RepoSnapshot
grep -rn "RepoSnapshot\|lastIndexed" lib/
grep -rn "RepoSnapshot\|lastIndexed" lib/types.ts
```

Note the exact function signatures, especially:
- What does `incrementalIndex` accept? `(repo: string, changedFiles: string[]) => Promise<void>` or similar?
- Is there a `fullIndex` or `indexRepo` function for full re-indexing?
- Where is `RepoSnapshot` defined and does it have a `lastIndexed` field?

### Step 2: Inspect lib/atc.ts to understand the current structure

```bash
# Read the full ATC file to understand structure
cat lib/atc.ts

# Specifically locate:
# - §2.8 section and how it fetches PR data
# - How repos are fetched (getRegisteredRepos or similar)
# - How the GitHub API is called for PR info
# - Existing log/output patterns
grep -n "§2.8\|prNumber\|merged\|getFiles\|changedFiles\|listRegisteredRepos\|getRegisteredRepos" lib/atc.ts
grep -n "github\|octokit\|fetchPR\|getPR" lib/atc.ts
grep -n "§13\|§14\|section" lib/atc.ts
```

### Step 3: Check GitHub API helper for PR file listing

```bash
# Find how to get changed files from a PR
grep -rn "getFiles\|listFiles\|changed_files\|pull.*files" lib/github.ts
```

If there's no existing helper for PR file listing, you'll need to add one to `lib/github.ts` or inline the GitHub API call in `lib/atc.ts`. The GitHub API endpoint is:
```
GET /repos/{owner}/{repo}/pulls/{pull_number}/files
```
This returns an array of objects with a `filename` field.

### Step 4: Add incrementalIndex call in §2.8 (PR merge reconciliation)

In `lib/atc.ts`, find the §2.8 section where work items are transitioned to `"merged"`. After the state transition, add the incremental indexing call.

The pattern should look like this (adapt to match existing code style):

```typescript
// After work item is transitioned to 'merged' in §2.8:
try {
  // Fetch changed files for this PR
  const prFiles = await getPRChangedFiles(workItem.repoOwner, workItem.repoName, workItem.prNumber);
  const repoFullName = `${workItem.repoOwner}/${workItem.repoName}`;
  await incrementalIndex(repoFullName, prFiles);
  output.push(`[§2.8] Incremental re-index triggered for ${repoFullName} (${prFiles.length} files changed by PR #${workItem.prNumber})`);
} catch (err) {
  output.push(`[§2.8] Warning: incremental re-index failed for PR #${workItem.prNumber}: ${err instanceof Error ? err.message : String(err)}`);
}
```

**Important notes:**
- Wrap in try/catch so ATC never throws
- The exact field names on `workItem` (e.g. `repoOwner`, `repoName`) must match the actual `WorkItem` type — inspect `lib/types.ts` first
- The repo identifier format passed to `incrementalIndex` must match what the knowledge graph module expects

### Step 5: Add §14 periodic full re-index section

Locate the end of the main ATC run function (after §13, before the final return/output). Add §14 as a new section:

```typescript
// ─── §14: Periodic Full Re-Index ────────────────────────────────────────────
output.push(`\n=== §14: Periodic Full Re-Index ===`);
try {
  const repos = await getRegisteredRepos(); // use whatever the existing helper is called
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let fullIndexCount = 0;

  for (const repo of repos) {
    if (fullIndexCount >= 1) {
      output.push(`[§14] Full re-index cap reached (1/cycle), skipping remaining repos`);
      break;
    }

    const snapshot = await getRepoSnapshot(repo.fullName); // adjust to actual API
    if (!snapshot || !snapshot.lastIndexed || snapshot.lastIndexed < sevenDaysAgo) {
      output.push(`[§14] ${repo.fullName} snapshot stale (lastIndexed: ${snapshot?.lastIndexed ?? 'never'}), triggering full re-index`);
      try {
        await fullIndex(repo.fullName); // adjust to actual function name
        output.push(`[§14] Full re-index complete for ${repo.fullName}`);
        fullIndexCount++;
      } catch (err) {
        output.push(`[§14] Warning: full re-index failed for ${repo.fullName}: ${err instanceof Error ? err.message : String(err)}`);
        fullIndexCount++; // still count it to respect the cap
      }
    } else {
      output.push(`[§14] ${repo.fullName} snapshot is fresh, skipping`);
    }
  }
} catch (err) {
  output.push(`[§14] Warning: periodic re-index check failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

**Adapt based on your inspection:**
- Use the actual function name for listing registered repos (Step 2 findings)
- Use the actual function name for full indexing (Step 1 findings)
- Use the actual shape of `RepoSnapshot` (Step 1 findings)
- Match the output/logging style used in other sections

### Step 6: Add getPRChangedFiles helper (if not already in lib/github.ts)

If `lib/github.ts` does not already have a function to list PR files, add one:

```typescript
// In lib/github.ts
export async function getPRChangedFiles(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string[]> {
  const token = process.env.GH_PAT;
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!response.ok) {
    throw new Error(`GitHub API error fetching PR files: ${response.status} ${response.statusText}`);
  }
  const files: Array<{ filename: string }> = await response.json();
  return files.map((f) => f.filename);
}
```

Match the existing patterns in `lib/github.ts` (headers, error handling, fetch vs octokit, etc.).

### Step 7: Verify TypeScript compilation and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors:
- If `incrementalIndex` signature doesn't match, adjust the call
- If `WorkItem` doesn't have `repoOwner`/`repoName` fields, inspect `lib/types.ts` and use the correct fields (may be `repo` as `"owner/name"` — split on `/` if needed)
- If `RepoSnapshot.lastIndexed` is a `Date` object instead of a number, compare with `new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)`

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add ATC auto-indexing trigger on PR merge and periodic full re-index (§2.8 + §14)"
git push origin feat/atc-auto-indexing-trigger
gh pr create \
  --title "feat: add ATC auto-indexing trigger on PR merge" \
  --body "## Summary

Extends the Air Traffic Controller to keep the knowledge graph fresh automatically.

### Changes

**lib/atc.ts (§2.8 extension):**
- After a work item transitions to \`merged\`, fetches changed files from the PR via GitHub API
- Calls \`incrementalIndex(repo, changedFiles)\` to update the knowledge graph
- Logs success/failure to ATC cycle output; errors are caught and do not halt the cycle

**lib/atc.ts (§14 new section):**
- Checks each registered repo's \`RepoSnapshot.lastIndexed\`
- Triggers full re-index for repos with snapshots older than 7 days
- Capped at 1 full re-index per ATC cycle to prevent timeout
- Errors are caught and logged; ATC cycle continues normally

**lib/github.ts (if modified):**
- Added \`getPRChangedFiles(owner, repo, pullNumber)\` helper using GitHub Pulls API

### Acceptance Criteria
- [x] \`lib/atc.ts\` imports \`incrementalIndex\` from knowledge graph module
- [x] §2.8 triggers \`incrementalIndex\` with PR changed files on work item merge
- [x] §14 periodic full re-index for stale repos (>7 days)
- [x] Full re-index capped at 1 per cycle
- [x] All knowledge graph errors logged but not thrown
- [x] TypeScript compiles without errors
- [x] Build passes

### Risk
Medium — modifies \`lib/atc.ts\` which is the core scheduling loop. All new code is wrapped in try/catch so failures are non-fatal."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/atc-auto-indexing-trigger
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or is ambiguous]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you cannot resolve a blocker (e.g., `incrementalIndex` does not exist or has a radically different signature, `RepoSnapshot` has no `lastIndexed` field, or the ATC structure differs significantly from what the description implies):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "atc-auto-indexing-trigger",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts"]
    }
  }'
```