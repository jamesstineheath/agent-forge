# Agent Forge -- CI Feedback Loop

## Metadata
- **Branch:** `feat/ci-feedback-loop`
- **Priority:** high
- **Model:** sonnet
- **Type:** bug-fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** .github/workflows/execute-handoff.yml, .github/actions/tlm-review/src/index.ts, .github/workflows/ci-stuck-pr-monitor.yml

## Context

The pipeline has a critical silent-failure mode. When `execute-handoff.yml` pushes code that fails CI, nothing detects or acts on the failure. The PR sits in limbo: TLM Code Review approves it (unaware of CI status), auto-merge queues via GraphQL, but GitHub branch protection blocks the merge because required checks are red. No notification, no retry, no escalation. The handoff is "executed" but the code never ships.

This was surfaced by CI run #48 (commit `85cc49a`), which failed but produced no downstream reaction.

Three gaps need closing:

1. **Execute Handoff doesn't verify its own output.** It treats "PR opened" as success. After pushing and opening the PR, it should wait for CI to complete. If CI fails, it should post a diagnostic comment with the failure logs and exit with a non-zero status so the workflow itself shows as failed.

2. **TLM Code Review doesn't gate on CI status.** It reviews the diff and approves based on code quality alone. The auto-merge logic (bottom of `index.ts`) tries `pulls.merge`, gets a 405 if checks are failing, falls back to GraphQL auto-merge which queues indefinitely. Before approving, it should check `repos.getCombinedStatusForRef()` and, if CI is failing, post a "CI failing, deferring approval" comment instead.

3. **No stuck-PR detector exists.** A lightweight scheduled workflow should find open PRs that are approved but have failing CI for more than 2 hours, and post a comment tagging the repo owner.

### Existing patterns

**`execute-handoff.yml`**: Claude Code runs, pushes code, opens PR. The "Report results" step runs `if: always()` and logs git status, but doesn't check CI. The workflow uses `GITHUB_TOKEN: ${{ secrets.GH_PAT || secrets.GITHUB_TOKEN }}` for API calls.

**`tlm-review/src/index.ts`**: Auto-merge block calls `octokit.rest.pulls.merge()`, catches 405 (not mergeable), falls back to `enablePullRequestAutoMerge` GraphQL mutation. No CI status check anywhere in the action.

**`ci.yml`**: Runs on push and pull_request. Steps: checkout, setup-node, npm ci, npm run build, npm test. The CI job name is the check name to poll for.

**Concurrency**: `execute-handoff` uses per-branch concurrency groups. The new CI-wait step must run within the existing job, not as a separate job, to preserve the branch context.

**Important**: Read the actual workflow files in this repo at execution time. The line numbers and exact code may differ from what's described here. Use the descriptions to locate the right insertion points.

## Requirements

1. **Add CI-wait step to `execute-handoff.yml`** after the "Execute handoff with Claude Code" step and before "Parse execution cost". This step should:
   - Find the open PR for the current branch using `gh pr list --head <branch> --state open --json number`
   - If a PR exists, poll CI status using `gh pr checks <pr_number> --watch --fail-on-failure` with a 10-minute timeout
   - If CI passes, continue normally
   - If CI fails, fetch the failed check's logs and post them as a PR comment, then `exit 1`
   - If no PR was opened (Claude Code failed before that point), skip this step gracefully
   - Use `if: success()` so it only runs when Claude Code succeeded

2. **Add CI status gate to `tlm-review/src/index.ts`** before the Claude API call (after fetching the diff and files, before the sensitive path check). This step should:
   - Call `octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: pr.head.sha })` to get the combined commit status
   - Also call `octokit.rest.checks.listForRef({ owner, repo, ref: pr.head.sha })` to get check runs (CI uses check runs, not commit statuses)
   - Filter out the TLM Code Review's own check run to avoid circular dependency
   - If any non-TLM check run has `conclusion: 'failure'`, post a COMMENT review saying "CI is failing. Deferring code review until CI passes." and return early (do not call Claude API, do not approve)
   - If all checks are still `in_progress` or `queued`, post a COMMENT review saying "CI still running. Will review on check_suite completion." and return early. The `check_suite` trigger will re-invoke the review when CI finishes.
   - If all checks passed (or no CI checks exist), proceed with the review as normal

3. **Create `ci-stuck-pr-monitor.yml`** as a new scheduled workflow:
   - Runs every 2 hours via cron (`0 */2 * * *`)
   - Also supports `workflow_dispatch` for manual runs
   - Lists all open PRs with at least one approval
   - For each, checks if CI is failing and the PR has been open for more than 2 hours
   - Posts a comment: "This PR has been approved but CI is failing for over 2 hours. Needs attention. cc @jamesstineheath"
   - Only posts this comment once (check for existing comment with a marker string before posting)

4. **Rebuild the TLM review action** after modifying the TypeScript source. The action uses a build step that compiles `src/index.ts` to `dist/index.js`. Run the build command (check `package.json` for the exact script) in the `.github/actions/tlm-review/` directory and commit the built output.

## Execution Steps

### Step 0: Branch + initial commit
```bash
git checkout -b feat/ci-feedback-loop
git push -u origin feat/ci-feedback-loop
```

### Pre-flight Self-Check
- [ ] `.github/workflows/execute-handoff.yml` exists and has the Claude Code execution step
- [ ] `.github/actions/tlm-review/src/index.ts` exists and has the auto-merge block
- [ ] `.github/workflows/ci.yml` exists (confirms CI workflow is present)
- [ ] `.github/actions/tlm-review/package.json` exists (confirms build tooling)

### Step 1: Add CI-wait step to execute-handoff.yml
Read the file first. Insert a new step after the Claude Code execution step and before the cost parsing step. The step must use `if: success()` and the same `GITHUB_TOKEN` env var. Use `gh pr checks` with `--watch` for polling. Timeout after 10 minutes. On failure, extract logs and post them as a PR comment.

### Step 2: Add CI status gate to TLM Code Review action
Read `.github/actions/tlm-review/src/index.ts` first. Add a `checkCIStatus` function that calls both `repos.getCombinedStatusForRef` and `checks.listForRef`. Insert a call to this function after fetching the diff and file list, before the sensitive path patterns block. If CI is failing, post a COMMENT review and return. If CI is pending, post a COMMENT and return. If CI passed, continue.

### Step 3: Rebuild TLM review action
```bash
cd .github/actions/tlm-review
npm install
npm run build
```
Commit the built `dist/` output.

### Step 4: Create ci-stuck-pr-monitor.yml
Create `.github/workflows/ci-stuck-pr-monitor.yml` with the scheduled cron trigger. Use `gh` CLI for all GitHub API calls. Include the dedup marker check.

### Step 5: Verify
- `npx tsc --noEmit` in `.github/actions/tlm-review/` passes
- Build succeeds
- All workflow files are syntactically valid YAML
- No other files were modified

### Step 6: Commit and push
Commit all changes with a descriptive message. Push to the branch. Open a PR against main.

Note: This PR modifies `execute-handoff.yml` and the TLM review action, which are in the sensitive path patterns list. The TLM Code Review will flag it for human review. This is correct and expected.

## Session Abort Protocol
If build fails after 3 attempts:
1. Revert to last known-good state
2. Post a PR comment documenting what was attempted and what failed
3. Push the partial work so it's not lost
4. Exit with failure

## Acceptance Criteria
- Execute Handoff workflow waits for CI and fails visibly when CI fails
- TLM Code Review does not approve PRs with failing CI
- Stuck PRs get flagged within 2 hours
- No regression to existing pipeline behavior when CI passes (happy path unchanged)
