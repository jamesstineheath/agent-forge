# Agent Forge -- Remove status-tracking commits to main from Dispatcher

## Metadata
- **Branch:** `feat/remove-dispatcher-status-commits`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/dispatcher.ts, lib/github.ts

## Context

The Dispatcher agent (`lib/atc/dispatcher.ts`) is responsible for picking up `ready` work items, checking concurrency/conflicts, and dispatching to target repos. Work item state should be managed exclusively through Vercel Blob via `lib/work-items.ts` and `lib/storage.ts`.

However, there may be code paths in the Dispatcher that commit status-tracking files (e.g., files tracking active work items, queue state) directly to the `main` branch of target repos via the GitHub API. This is incorrect — the Dispatcher should never write to target repo main branches for internal state tracking. Such commits pollute target repo history with internal orchestration noise and create a second source of truth for work item state.

The fix is to audit and remove any such GitHub API commit paths from the Dispatcher. The canonical state store is Vercel Blob only.

Functions to look for (in `lib/github.ts` or called from `lib/atc/dispatcher.ts`):
- `createOrUpdateFileContents`
- `createCommit`
- Any function whose name suggests status tracking (e.g., `updateActiveWorkItems`, `commitStatusFile`, `pushStatusToRepo`, etc.)

## Requirements

1. Audit `lib/atc/dispatcher.ts` for all GitHub API calls — specifically any that write/commit files to target repo main branches for status-tracking purposes.
2. Remove or disable any such commit paths from `lib/atc/dispatcher.ts`.
3. Audit `lib/github.ts` for helper functions specifically designed for status-file commits to target repo main branches. If any exist and have no callers outside the Dispatcher, mark them `@deprecated` with a comment or remove them entirely.
4. All work item status reads/writes in the Dispatcher must go through `lib/work-items.ts` or `lib/storage.ts` (Vercel Blob). If any status data was previously being pushed to GitHub, ensure the equivalent state is already persisted to Blob (it likely already is — the push was redundant).
5. The project must compile successfully: `npx tsc --noEmit` and `npm run build` pass.
6. No functional regression: the Dispatcher's core dispatch logic, conflict detection, and concurrency enforcement must remain intact.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/remove-dispatcher-status-commits
```

### Step 1: Audit the Dispatcher for GitHub API commit calls

Read the full contents of `lib/atc/dispatcher.ts` and identify any imports from `lib/github.ts` or direct `@octokit/rest` usage. Look for:

```bash
grep -n "createOrUpdateFileContents\|createCommit\|createTree\|commitStatusFile\|updateActiveWorkItems\|pushStatus\|commitToMain\|chore: update" lib/atc/dispatcher.ts
```

Also check what's imported from github.ts:
```bash
grep -n "^import.*github" lib/atc/dispatcher.ts
```

Document every call site found.

### Step 2: Audit lib/github.ts for status-commit helpers

Search for functions in `lib/github.ts` that commit status files:

```bash
grep -n "createOrUpdateFileContents\|createCommit\|createTree\|chore: update active\|status-tracking\|active.work.items" lib/github.ts
```

List all functions in `lib/github.ts` that appear to exist solely for pushing internal state to target repo branches (not for legitimate handoff dispatch purposes like creating handoff branches, pushing handoff files, or triggering workflows).

### Step 3: Cross-reference callers of suspected functions

For each suspicious function found in `lib/github.ts`, check all callers across the codebase:

```bash
# Replace FUNCTION_NAME with each function identified
grep -rn "FUNCTION_NAME" lib/ app/ --include="*.ts" --include="*.tsx"
```

Determine if any callers remain outside the Dispatcher. If a function is only called from the Dispatcher (or has zero callers after removing the Dispatcher calls), it can be removed or deprecated.

### Step 4: Remove status-commit code paths from dispatcher.ts

For each identified commit call in `lib/atc/dispatcher.ts`:

1. **Remove the call site entirely.** Do not replace it with alternative logic — the state is already managed by Vercel Blob.
2. **Remove any helper logic** (loops, file content builders, base64 encoders) that existed solely to support those commit calls.
3. **Remove unused imports** from `lib/github.ts` if the removed code was the only consumer of those imports in the file.

The Dispatcher's state management must flow through:
- `updateWorkItem(...)` from `lib/work-items.ts`
- `saveBlob(...)` / `loadBlob(...)` from `lib/storage.ts`
- Internal ATC state via `lib/atc/lock.ts` and `lib/atc/events.ts`

### Step 5: Clean up lib/github.ts

For each function in `lib/github.ts` identified as a status-commit helper:

**If it has no remaining callers anywhere in the codebase:**
```typescript
// Remove the function entirely
```

**If it has callers elsewhere (non-Dispatcher) that serve legitimate purposes (e.g., pushing actual handoff files):**
```typescript
// Keep the function — it has legitimate callers
// Only the Dispatcher's misuse of it has been removed
```

**If uncertain:** Add a `@deprecated` JSDoc comment:
```typescript
/**
 * @deprecated This function was used by the Dispatcher to commit status-tracking
 * files to target repo main branches. That behavior has been removed (see feat/remove-dispatcher-status-commits).
 * Remove this function once all callers are confirmed gone.
 */
```

### Step 6: Verify Blob-based state management is complete

Verify that any state previously written to GitHub (e.g., active work item lists, queue snapshots) is already being persisted to Vercel Blob. Check:

```bash
grep -n "updateWorkItem\|setWorkItemStatus\|saveBlob\|listWorkItems" lib/atc/dispatcher.ts
```

There should be clear Blob-based read/write calls for work item state transitions (e.g., `ready → queued`, `queued → generating`). If the removed GitHub commit was the *only* place a state transition was being recorded, ensure the equivalent transition exists via `lib/work-items.ts`. (This is unlikely — the Blob calls should already exist — but verify.)

### Step 7: TypeScript compilation check

```bash
npx tsc --noEmit
```

Fix any type errors introduced by the removals (e.g., unused variables, missing imports). Common issues:
- Unused import after removing call sites → remove the import
- Variable declared but never used after removing the only usage → remove the variable

### Step 8: Build verification

```bash
npm run build
```

Resolve any build errors. Do not proceed to commit if the build fails.

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "fix: remove status-tracking commits to main from Dispatcher

The Dispatcher was committing status-tracking files to target repo main
branches via the GitHub API (e.g., 'chore: update active work items').
This is incorrect — all work item state must be managed exclusively
through Vercel Blob (lib/work-items.ts / lib/storage.ts).

- Removed GitHub API commit call sites from lib/atc/dispatcher.ts
- Removed or deprecated status-commit helper functions in lib/github.ts
  that had no remaining callers
- Verified Blob-based state transitions are intact for all removed paths"

git push origin feat/remove-dispatcher-status-commits

gh pr create \
  --title "fix: remove status-tracking commits to main from Dispatcher" \
  --body "## Summary

Removes code paths in \`lib/atc/dispatcher.ts\` that were committing status-tracking files to target repo \`main\` branches via the GitHub API.

## Problem
The Dispatcher was pushing internal orchestration state (e.g., active work item lists) as commits to target repos. This:
- Pollutes target repo commit history with internal noise
- Creates a second source of truth for work item state (Vercel Blob is canonical)
- Is architecturally incorrect — the Dispatcher should never write to target repo main branches for state tracking

## Solution
- Removed all GitHub API commit call sites from \`lib/atc/dispatcher.ts\` that wrote status files to target repo main branches
- Cleaned up or deprecated helper functions in \`lib/github.ts\` with no remaining callers
- All work item state transitions remain intact via Vercel Blob (\`lib/work-items.ts\` / \`lib/storage.ts\`)

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- No functional changes to dispatch logic, conflict detection, or concurrency enforcement

## Risk
Medium — the removed code was writing to external repos. Removing it only affects that side-channel; core state management via Blob is unaffected." \
  --base main
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/remove-dispatcher-status-commits
FILES CHANGED: [list files actually modified]
SUMMARY: [what was audited and removed]
ISSUES: [what failed or was ambiguous]
NEXT STEPS: [what remains — e.g., "lib/github.ts helpers still need review"]
```

## Escalation Protocol

If you encounter a blocker (e.g., the Dispatcher has no such commit calls and the audit finds nothing, or a function is called from many places and removal risk is unclear), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "remove-dispatcher-status-commits",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/dispatcher.ts", "lib/github.ts"]
    }
  }'
```

Common escalation triggers:
- **Audit finds nothing**: If grep finds zero commit calls in the Dispatcher, confirm with a broader search before escalating — the work item may be a false positive or the code may have already been removed.
- **Function has many callers**: If a suspected status-commit function in `lib/github.ts` is called from 5+ places across the codebase serving different purposes, do not remove it — escalate for human judgment on scope.
- **State gap**: If the removed commit call was the *only* place a critical state transition was persisted and no Blob equivalent exists, escalate before proceeding.