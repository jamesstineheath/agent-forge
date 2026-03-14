# Handoff 09: ATC Branch Cleanup

**Target repo:** `jamesstineheath/agent-forge`
**Complexity:** Simple (2 files)
**Risk:** Low
**Max Budget:** $3
**Estimated files:** `lib/github.ts`, `lib/atc.ts`

## Pre-flight self-check

Before executing, confirm:
- [ ] You are on a fresh branch from `main`
- [ ] `lib/github.ts` exists and contains `ghFetch`
- [ ] `lib/atc.ts` exists and contains `runATCCycle`
- [ ] No open PRs touch either file

## Step 0: Branch, commit handoff, push

```bash
git checkout -b handoff/09-atc-branch-cleanup main
git add handoffs/09-atc-branch-cleanup.md
git commit -m "chore: add handoff 09 (ATC branch cleanup)"
git push -u origin handoff/09-atc-branch-cleanup
```

## Step 1: Add branch listing and deletion to `lib/github.ts`

Add two new exported functions after the existing `getPRByBranch` function:

### `listBranches(repo: string): Promise<string[]>`

Lists all branches for a repo (excluding the default branch). Uses `GET /repos/{owner}/{repo}/branches?per_page=100`. Returns an array of branch names. Paginate if needed (follow `Link` header), but 100 is fine for now.

### `deleteBranch(repo: string, branch: string): Promise<boolean>`

Deletes a single branch. Uses `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`. Returns `true` on success (204), `false` on failure. Log failures but don't throw.

### `getBranchLastCommitDate(repo: string, branch: string): Promise<string | null>`

Gets the date of the last commit on a branch. Uses `GET /repos/{owner}/{repo}/commits?sha={branch}&per_page=1`. Returns the ISO date string of the commit, or null on failure.

## Step 2: Add `cleanupStaleBranches` to `lib/atc.ts`

Add a new exported async function `cleanupStaleBranches` that:

1. **Throttle check:** Load `atc/last-branch-cleanup` from Blob storage. If it exists and is less than 60 minutes old, return early (skip cleanup). This ensures we only run once per hour, not every ATC cycle.

2. **For each registered repo** (via `listRepos` + `getRepo`):
   a. Call `listBranches(repo.fullName)` to get all non-default branches.
   b. For each branch, check if there's an open PR via `getPRByBranch`. If yes, skip (branch is active).
   c. For branches with no open PR, check `getBranchLastCommitDate`. If the last commit is older than 48 hours, delete the branch via `deleteBranch`.
   d. Log each deletion as an ATC event (type: `"cleanup"`, details: `"Deleted stale branch: {branchName} from {repo} (last commit: {date})"`).

3. **Save timestamp:** Write `{ lastRunAt: new Date().toISOString() }` to `atc/last-branch-cleanup` in Blob storage.

4. **Return** an object: `{ deletedCount: number, skipped: number, errors: number }`.

Add `"cleanup"` to the `ATCEvent["type"]` union in `lib/types.ts` if needed.

### Rate limit awareness

The function makes 1 + N + M API calls per repo (1 list, N PR checks, M date checks). For repos with many stale branches on first run, this could be significant. Add a safety cap: process at most 20 branches per repo per cycle. Log if more remain for the next cycle.

## Step 3: Wire into `runATCCycle`

At the end of `runATCCycle` (after step 7, the event log save), add:

```typescript
// 8. Periodic branch cleanup
try {
  const cleanupResult = await cleanupStaleBranches();
  if (cleanupResult && cleanupResult.deletedCount > 0) {
    events.push(makeEvent(
      "cleanup", "system", undefined, undefined,
      `Branch cleanup: deleted ${cleanupResult.deletedCount}, skipped ${cleanupResult.skipped}, errors ${cleanupResult.errors}`
    ));
    // Re-save events since we added cleanup events
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...events.filter(e => e.type === "cleanup")].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }
} catch (err) {
  console.error("[atc] Branch cleanup failed:", err);
}
```

## Step 4: Verification

1. `npx tsc --noEmit` passes with no errors.
2. The new functions in `github.ts` are properly typed and exported.
3. The `ATCEvent` type union includes `"cleanup"` if it was a string literal union before.
4. The throttle logic uses `loadJson`/`saveJson` from `./storage` (already imported in `atc.ts`).
5. No existing behavior in `runATCCycle` is changed. The cleanup is additive at the end.

## Step 5: PR and merge

Open a PR titled "feat: add periodic stale branch cleanup to ATC" with description:

```
## Summary
- Adds `listBranches`, `deleteBranch`, and `getBranchLastCommitDate` to `lib/github.ts`
- Adds `cleanupStaleBranches` to `lib/atc.ts`, called at end of each ATC cycle
- Throttled to once per hour via Blob timestamp
- Deletes branches with no open PR and last commit >48h old
- Caps at 20 branches per repo per cycle to stay within rate limits

## Test plan
- [ ] `npx tsc --noEmit` passes
- [ ] First ATC cycle after deploy triggers cleanup (verify via events log)
- [ ] Subsequent cycles within 60 min skip cleanup (throttle working)
- [ ] Branches with open PRs are not deleted
```

If CI passes and TLM approves, merge.

## Session abort protocol

If any step fails and cannot be resolved within 2 attempts:
1. Commit whatever progress exists
2. Push the branch
3. Open a draft PR with `[BLOCKED]` prefix describing the issue
4. Output to stdout: `ABORT: {step_number} - {reason}`
