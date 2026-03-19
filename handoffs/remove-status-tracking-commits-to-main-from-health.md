# Agent Forge -- Remove status-tracking commits to main from Health Monitor and Orchestrator

## Metadata
- **Branch:** `feat/remove-status-tracking-commits-to-main-hm-orch`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/health-monitor.ts, lib/orchestrator.ts

## Context

Agent Forge is a dev orchestration platform that manages work items and dispatches them to target repositories. Two core modules — the Health Monitor and the Orchestrator — interact with the GitHub API to manage branches, push handoff files, trigger workflows, and track execution state.

A cleanup initiative is underway to ensure that **status-tracking files are never committed to `main` branches of target repos**. All persistent state must flow through Vercel Blob storage exclusively. A concurrent work item is addressing the same issue in `lib/atc/dispatcher.ts` and `lib/github.ts` — **do not modify those files**.

The goal here is to audit `lib/atc/health-monitor.ts` and `lib/orchestrator.ts` for any code paths that commit status-tracking files (e.g., JSON state files, status markers, execution records) to the `main` branch of target repos via the GitHub API, and remove or redirect those commits.

**Legitimate GitHub API usage to PRESERVE:**
- Creating feature branches in target repos
- Pushing handoff files to feature branches (not main)
- Triggering `workflow_dispatch` on target repos
- Reading file contents from target repos
- Any PR-related API calls

**What must be REMOVED:**
- Any `createOrUpdateFileContents` (or equivalent) calls that target the `main` branch (or `master`, or the default branch) of target repos with status-tracking payloads (e.g., execution status, work item state, tracking metadata)

**Concurrent conflict warning:** The sibling work item (`feat/remove-status-tracking-commits-to-main-from-dispat`) modifies `lib/atc/dispatcher.ts` and `lib/github.ts`. Do NOT touch those files.

## Requirements

1. Audit `lib/atc/health-monitor.ts` for all GitHub API calls that write files to any branch of a target repo. Remove calls that target `main`/`master`/default branches with status-tracking content. Preserve all other GitHub API usage.
2. Audit `lib/orchestrator.ts` for all GitHub API calls that write files to any branch of a target repo. Remove calls that target `main`/`master`/default branches with status-tracking content. Preserve all other GitHub API usage (branch creation, handoff file pushes to feature branches, workflow triggers).
3. If any removed code path was persisting state that is still needed, redirect that state persistence to use Vercel Blob storage via the existing `lib/storage.ts` module.
4. The project must compile successfully (`npx tsc --noEmit` passes).
5. `npm run build` must succeed.
6. Do NOT modify `lib/atc/dispatcher.ts` or `lib/github.ts`.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/remove-status-tracking-commits-to-main-hm-orch
```

### Step 1: Audit lib/atc/health-monitor.ts

Search for all GitHub API write operations in the file:

```bash
grep -n "createOrUpdateFileContents\|putContents\|createFile\|updateFile\|commitFile\|pushFile\|commits\|refs/heads/main\|refs/heads/master" lib/atc/health-monitor.ts
```

Also search for calls to any GitHub wrapper functions that might write to repos:

```bash
grep -n "github\.\|octokit\.\|createCommit\|updateRef\|createBlob\|createTree" lib/atc/health-monitor.ts
```

And search for references to `main`, `master`, or default branch writes:

```bash
grep -n '"main"\|"master"\|defaultBranch\|default_branch' lib/atc/health-monitor.ts
```

For each GitHub API write call found:
- Determine the target branch (is it `main`/`master`/default branch, or a feature branch?)
- Determine the file content being written (is it a handoff file, or status-tracking metadata?)
- If it targets `main` with status-tracking content → remove the call and redirect state to Vercel Blob if the data is still needed
- If it targets a feature branch with a handoff file → preserve it

### Step 2: Audit lib/orchestrator.ts

Run the same search pattern:

```bash
grep -n "createOrUpdateFileContents\|putContents\|createFile\|updateFile\|commitFile\|pushFile" lib/orchestrator.ts
grep -n "github\.\|octokit\.\|createCommit\|updateRef\|createBlob\|createTree" lib/orchestrator.ts
grep -n '"main"\|"master"\|defaultBranch\|default_branch' lib/orchestrator.ts
```

Also look for status-tracking patterns specifically:

```bash
grep -n "status\|tracking\|state\|execution\|handoff-status\|work-item" lib/orchestrator.ts | grep -i "commit\|push\|write\|update.*file\|create.*file"
```

For each GitHub API write call found:
- Preserve calls that push handoff files to feature branches (this is the legitimate dispatch mechanism)
- Remove calls that write status or tracking files to `main`

### Step 3: Implement removals and redirections

**Pattern for removing a status-tracking commit to main:**

If you find something like:
```typescript
// BEFORE (to be removed):
await github.createOrUpdateFileContents({
  owner: repo.owner,
  repo: repo.name,
  path: 'af-status/work-item-123.json',
  message: 'chore: update execution status',
  content: Buffer.from(JSON.stringify(statusData)).toString('base64'),
  branch: 'main',  // ← this is the problem
});
```

Replace with Vercel Blob storage:
```typescript
// AFTER (redirect to Blob):
import { saveToBlob } from '@/lib/storage'; // or use existing storage imports
await saveToBlob(`af-data/work-items/${workItemId}`, JSON.stringify(statusData));
```

Check `lib/storage.ts` for the actual exported function signatures before writing replacement code. Common patterns in this codebase:
```typescript
import { put, getBlob } from '@vercel/blob';
// or
import { saveWorkItem, getWorkItem } from '@/lib/work-items';
```

Use the existing storage abstractions rather than calling Vercel Blob directly where possible.

**If the status data is already persisted elsewhere** (e.g., the work item is already updated in Blob via `lib/work-items.ts`), then the GitHub commit call can simply be deleted with no replacement.

### Step 4: Verify no regressions in GitHub API usage

After making changes, confirm that legitimate GitHub API calls are still present in orchestrator.ts:

```bash
# These should still exist in orchestrator.ts:
grep -n "createRef\|createBranch\|feature.*branch\|feat/" lib/orchestrator.ts
grep -n "workflow_dispatch\|triggerWorkflow\|dispatchWorkflow" lib/orchestrator.ts
grep -n "handoff\|handoffs/" lib/orchestrator.ts
```

Ensure no legitimate feature-branch pushes or workflow triggers were accidentally removed.

### Step 5: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors introduced by the changes. Common issues:
- Removed a variable that's still referenced downstream → remove the downstream references too
- Async function that no longer needs to await → clean up the await
- Import no longer needed → remove unused imports

### Step 6: Build verification

```bash
npm run build
```

If build fails, address errors. Do not proceed to commit until build passes.

### Step 7: Sanity check — confirm no writes to main remain

```bash
# Check health-monitor.ts
echo "=== health-monitor.ts writes to main ==="
grep -n "branch.*main\|main.*branch\|\"main\"\|'main'" lib/atc/health-monitor.ts | grep -i "creat\|updat\|push\|commit\|write"

# Check orchestrator.ts  
echo "=== orchestrator.ts writes to main ==="
grep -n "branch.*main\|main.*branch\|\"main\"\|'main'" lib/orchestrator.ts | grep -i "creat\|updat\|push\|commit\|write"
```

Both should return no results (or only results that are clearly reads, not writes).

### Step 8: Commit, push, open PR

```bash
git add lib/atc/health-monitor.ts lib/orchestrator.ts
git commit -m "fix: remove status-tracking commits to main from Health Monitor and Orchestrator

- Audited lib/atc/health-monitor.ts for GitHub API writes to main branches
- Audited lib/orchestrator.ts for GitHub API writes to main branches
- Removed status-tracking file commits targeting main/master/default branches
- Redirected any needed state persistence to Vercel Blob storage
- Preserved all legitimate GitHub API usage: branch creation, handoff pushes
  to feature branches, workflow_dispatch triggers, PR operations
- lib/atc/dispatcher.ts and lib/github.ts intentionally not modified
  (handled by concurrent work item)"

git push origin feat/remove-status-tracking-commits-to-main-hm-orch

gh pr create \
  --title "fix: remove status-tracking commits to main from Health Monitor and Orchestrator" \
  --body "## Summary

Audited \`lib/atc/health-monitor.ts\` and \`lib/orchestrator.ts\` for code paths that commit status-tracking files to \`main\` branches of target repos via the GitHub API.

## Changes

- Removed any \`createOrUpdateFileContents\` or equivalent calls in Health Monitor that targeted \`main\`/\`master\`/default branches with status-tracking payloads
- Removed any equivalent calls in Orchestrator targeting main with status data
- Redirected state persistence to Vercel Blob storage where data was still needed
- Preserved all legitimate GitHub API usage:
  - Feature branch creation
  - Handoff file pushes to feature branches
  - \`workflow_dispatch\` triggers
  - PR operations and reads

## Files changed

- \`lib/atc/health-monitor.ts\`
- \`lib/orchestrator.ts\`

## Not changed (concurrent work item)

- \`lib/atc/dispatcher.ts\` — handled by \`feat/remove-status-tracking-commits-to-main-from-dispat\`
- \`lib/github.ts\` — handled by same concurrent work item

## Acceptance Criteria

- [x] \`lib/atc/health-monitor.ts\` contains no code paths that commit status-tracking files to main branches
- [x] \`lib/orchestrator.ts\` contains no code paths that commit status-tracking files to main branches
- [x] Legitimate GitHub API usage preserved
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "fix: partial removal of status-tracking commits to main (WIP)"
git push origin feat/remove-status-tracking-commits-to-main-hm-orch
gh pr create --title "fix: remove status-tracking commits to main (partial)" --body "WIP - session aborted, see ISSUES below"
```

2. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/remove-status-tracking-commits-to-main-hm-orch
FILES CHANGED: [list of files actually modified]
SUMMARY: [what was audited and removed]
ISSUES: [what failed or was not completed]
NEXT STEPS: [remaining audit or fixes needed]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g., the audit reveals complex interdependencies where removing a commit to main would break a reconciliation flow, or you cannot determine whether a GitHub write is targeting main vs. a feature branch):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "remove-status-tracking-commits-to-main-hm-orch",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/health-monitor.ts", "lib/orchestrator.ts"]
    }
  }'
```