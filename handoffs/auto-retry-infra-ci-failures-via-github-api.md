<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Auto-retry Infra CI Failures via GitHub API

## Metadata
- **Branch:** `feat/auto-retry-infra-ci-failures`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** `lib/atc/health-monitor.ts`, `lib/github.ts`, `lib/atc/types.ts`, `lib/atc/events.ts`

## Context

The Health Monitor agent (`lib/atc/health-monitor.ts`) already detects CI failures on open PRs and performs stall recovery. A separate CI failure classifier (`classifyCIFailure`) has been implemented (dependency work item) and returns a classification string such as `'infra'`, `'test'`, `'lint'`, etc.

When the classifier returns `'infra'` (e.g., failed checkout step, runner connectivity issues, artifact download failures), these are transient and safe to retry automatically. This work adds that auto-retry loop:

1. Health Monitor calls `classifyCIFailure` on a failed CI run.
2. If `'infra'`, it calls GitHub's `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` API.
3. A dedup guard in the event bus prevents re-triggering a retry for the same run ID.
4. If the retry itself fails (or the re-run itself also fails on the next Health Monitor cycle), an escalation is created and no further retries are attempted.
5. All decisions are logged as `ci.infra_retry_triggered` events in the event bus and agent traces.

**Existing patterns to follow:**
- `lib/atc/health-monitor.ts` — health monitor cycle, stall detection, agent traces, event emission
- `lib/github.ts` — GitHub API wrapper (Octokit-based, `GH_PAT` env var)
- `lib/atc/events.ts` — `appendEvent` / `queryEvents` for the durable event log
- `lib/escalation.ts` — `createEscalation` for email + escalation records
- `lib/atc/types.ts` — `CycleContext`, shared constants

**No file overlap with concurrent work items** (they touch `lib/digest.ts`, `vercel.json`, `app/api/agents/digest/`, and bootstrap scripts).

---

## Requirements

1. After `classifyCIFailure` returns `'infra'` for a PR's failed CI run, call `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` via the existing GitHub API wrapper in `lib/github.ts`.
2. Track retries using the event bus: before triggering, query for an existing `ci.infra_retry_triggered` event with matching `runId`. If one exists, skip the retry (no infinite loop).
3. Emit a `ci.infra_retry_triggered` event immediately after a successful rerun API call, including `{ workItemId, prNumber, runId, repo }` payload.
4. Add a `ci.infra_retry_triggered` event type to `lib/atc/events.ts` (or `lib/atc/types.ts`) if not already present.
5. On a subsequent Health Monitor cycle, if the re-triggered run also fails AND a `ci.infra_retry_triggered` event already exists for that `runId`, create an escalation via `lib/escalation.ts` (`createEscalation`) with a descriptive message, emit a `ci.infra_retry_exhausted` event, and do not retry again.
6. All retry decisions (skipped/triggered/exhausted) must appear in the agent trace output for the Health Monitor cycle.
7. The `rerunFailedJobs` function must be added to `lib/github.ts` and be typed/exported properly.
8. TypeScript must compile with zero errors (`npx tsc --noEmit`).

---

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/auto-retry-infra-ci-failures
```

---

### Step 1: Understand existing code

Read the following files in full before writing any code:

```bash
cat lib/atc/health-monitor.ts
cat lib/atc/events.ts
cat lib/atc/types.ts
cat lib/github.ts
cat lib/escalation.ts
```

Specifically look for:
- How `classifyCIFailure` is imported/called (it should already be present from the dependency work item). If it does **not** exist yet, escalate immediately — this work item depends on it.
- How agent traces are appended (likely `ctx.traces.push(...)` or similar pattern).
- How events are appended (`appendEvent(...)`) and queried (`queryEvents(...)`).
- How `createEscalation` is called — its signature and required fields.
- What the existing GitHub API call pattern looks like (Octokit usage, error handling).

---

### Step 2: Add `rerunFailedJobs` to `lib/github.ts`

Add the following function to `lib/github.ts`. Follow the existing Octokit call pattern in that file (look for how `octokit` is instantiated — likely via `getOctokit()` or a module-level instance):

```typescript
/**
 * Re-runs only the failed jobs in a GitHub Actions workflow run.
 * Uses POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs
 */
export async function rerunFailedJobs(
  owner: string,
  repo: string,
  runId: number
): Promise<void> {
  const octokit = getOctokit(); // use whatever pattern the file already uses
  await octokit.request(
    'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs',
    {
      owner,
      repo,
      run_id: runId,
    }
  );
}
```

> Adapt `getOctokit()` to whatever pattern `lib/github.ts` already uses. Do not invent a new Octokit instantiation.

---

### Step 3: Register new event types

In `lib/atc/events.ts` (or wherever `EventType` / event type literals are defined — check `lib/atc/types.ts` as well), add two new event types if they don't already exist:

```typescript
// In the EventType union or const list:
'ci.infra_retry_triggered'
'ci.infra_retry_exhausted'
```

Check the existing pattern — it may be a TypeScript union type, a `const` array, or a `z.enum`. Match the existing pattern exactly.

---

### Step 4: Implement auto-retry logic in `lib/atc/health-monitor.ts`

Locate the section in `health-monitor.ts` where CI failures are processed — likely inside a `checkStalledItems`, `runHealthMonitorCycle`, or similar function where `classifyCIFailure` is (or should be) called.

Insert the following logic after `classifyCIFailure` returns `'infra'`. Adapt variable names to match the existing context:

```typescript
// --- Infra CI auto-retry ---
if (ciFailureClass === 'infra') {
  const owner = repoOwner; // derive from workItem.repo or ctx
  const repoName = repoShortName; // derive from workItem.repo
  const runId = failedRunId; // the numeric run ID from CI check data

  // Dedup: check if we already retried this exact run
  const pastRetries = await queryEvents({
    type: 'ci.infra_retry_triggered',
    filter: (e) =>
      e.payload?.runId === runId &&
      e.payload?.workItemId === workItem.id,
  });

  if (pastRetries.length > 0) {
    // Already retried once — check if it failed again
    const isStillFailing = true; // we're inside the "CI failed" branch, so yes
    trace.push(`[infra-retry] Run ${runId} already retried once and still failing — creating escalation`);

    await createEscalation({
      workItemId: workItem.id,
      reason: `Infra CI failure auto-retry exhausted for run ${runId} on PR #${workItem.prNumber} in ${owner}/${repoName}. Manual investigation required.`,
      confidenceScore: 0.95,
      contextSnapshot: {
        step: 'health-monitor:infra-retry-exhausted',
        error: `CI run ${runId} failed after auto-retry`,
        filesChanged: [],
      },
    });

    await appendEvent({
      type: 'ci.infra_retry_exhausted',
      payload: {
        workItemId: workItem.id,
        prNumber: workItem.prNumber,
        runId,
        repo: `${owner}/${repoName}`,
      },
    });

  } else {
    // First time seeing this infra failure — trigger retry
    trace.push(`[infra-retry] Detected infra CI failure on run ${runId}, triggering rerun-failed-jobs`);

    try {
      await rerunFailedJobs(owner, repoName, runId);

      await appendEvent({
        type: 'ci.infra_retry_triggered',
        payload: {
          workItemId: workItem.id,
          prNumber: workItem.prNumber,
          runId,
          repo: `${owner}/${repoName}`,
        },
      });

      trace.push(`[infra-retry] Rerun triggered successfully for run ${runId}`);
    } catch (err) {
      trace.push(`[infra-retry] Failed to trigger rerun for run ${runId}: ${String(err)}`);
      // Don't escalate here — let the next cycle re-evaluate
    }
  }
}
// --- End infra CI auto-retry ---
```

**Important implementation notes:**
- `queryEvents` signature: check how it's called elsewhere in the file. It may take `{ type, workItemId }` — use whatever the existing API supports. If it doesn't support a `filter` function, fall back to fetching by type+workItemId and filtering in-memory by `runId`.
- `appendEvent` signature: match existing call sites in the health monitor exactly.
- `createEscalation` signature: match `lib/escalation.ts` exports. If it requires `title` or `type` fields, add them.
- Import `rerunFailedJobs` at the top of `health-monitor.ts`.
- Make sure `runId` is extracted from the CI check/run data already present in the health monitor context. Look for how existing code accesses `check_run_id`, `workflow_run_id`, or similar.

---

### Step 5: Parse `runId` from CI check data

In the Health Monitor, CI failure information likely comes from GitHub Check Runs or a stored field on the work item. Locate where `classifyCIFailure` receives its input and confirm that a numeric `runId` (GitHub Actions workflow run ID, not check run ID) is available.

If only a check run ID is available, add a helper call to `lib/github.ts`:

```typescript
/**
 * Gets the workflow run ID associated with a check run.
 * Check runs are tied to suites; suites to workflow runs.
 */
export async function getWorkflowRunIdForCheckRun(
  owner: string,
  repo: string,
  checkRunId: number
): Promise<number | null> {
  const octokit = getOctokit();
  const { data: checkRun } = await octokit.rest.checks.get({
    owner,
    repo,
    check_run_id: checkRunId,
  });
  const suiteId = checkRun.check_suite?.id;
  if (!suiteId) return null;

  // List workflow runs for this check suite
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    per_page: 10,
  });
  const run = data.workflow_runs.find((r) => r.check_suite_id === suiteId);
  return run?.id ?? null;
}
```

Only add this if `runId` is not already accessible. Prefer direct `runId` if it's stored anywhere in the work item or event data.

---

### Step 6: TypeScript check

```bash
npx tsc --noEmit
```

Fix all type errors before proceeding. Common issues to watch for:
- `runId` typed as `string` vs `number` (GitHub API expects `number`)
- Missing fields in `createEscalation` call
- Event type literal not in the union

---

### Step 7: Build check

```bash
npm run build
```

Fix any build errors.

---

### Step 8: Run existing tests

```bash
npm test
```

If tests exist for `health-monitor.ts` or `github.ts`, ensure they still pass. Do not write new tests unless trivially fast — budget is $5.

---

### Step 9: Verify event types are consistent

```bash
grep -r 'ci\.infra_retry' . --include='*.ts' --include='*.js' | grep -v node_modules | grep -v dist
```

Confirm `ci.infra_retry_triggered` and `ci.infra_retry_exhausted` appear in both the type definition and the call sites.

---

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "feat: auto-retry infra CI failures via GitHub API

- Add rerunFailedJobs() to lib/github.ts
- Health Monitor detects infra CI failures via classifyCIFailure
- First failure: triggers rerun-failed-jobs API, emits ci.infra_retry_triggered
- Second failure on same runId: creates escalation, emits ci.infra_retry_exhausted
- Dedup via event bus prevents infinite retry loops
- All decisions logged in agent trace"

git push origin feat/auto-retry-infra-ci-failures

gh pr create \
  --title "feat: auto-retry infra CI failures via GitHub API" \
  --body "## Summary

Implements automatic retry of infra-classified CI failures in the Health Monitor.

## Changes
- \`lib/github.ts\`: Added \`rerunFailedJobs(owner, repo, runId)\` — calls \`POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs\`
- \`lib/atc/health-monitor.ts\`: After \`classifyCIFailure\` returns \`'infra'\`, check event bus for prior retry. If none → rerun + emit \`ci.infra_retry_triggered\`. If already retried → escalate + emit \`ci.infra_retry_exhausted\`.
- \`lib/atc/events.ts\` / \`lib/atc/types.ts\`: Registered \`ci.infra_retry_triggered\` and \`ci.infra_retry_exhausted\` event types.

## Acceptance Criteria
- [x] PR with infra CI failure gets rerun triggered within one Health Monitor cycle
- [x] Successful rerun → PR proceeds to Code Review → auto-merge
- [x] Failed rerun → escalation created, no further retries
- [x] Event bus contains \`ci.infra_retry_triggered\` with run ID
- [x] Agent trace shows full decision chain

## Risk
Medium — touches Health Monitor hot path. Dedup guard prevents runaway retries. GitHub API errors are caught and logged without crashing the cycle."
```

---

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/auto-retry-infra-ci-failures
FILES CHANGED: [list what was modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or is incomplete]
NEXT STEPS: [what remains — e.g., "runId extraction not found, need to inspect CI data structure"]
```

---

## Escalation Protocol

If `classifyCIFailure` does not exist (dependency not yet merged), or if the `queryEvents` API does not support filtering by payload fields, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "auto-retry-infra-ci-failures",
    "reason": "Dependency classifyCIFailure not found in health-monitor.ts, or queryEvents API cannot filter by payload runId",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 1 — reading existing code",
      "error": "classifyCIFailure import missing or queryEvents lacks payload filter support",
      "filesChanged": []
    }
  }'
```