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

The Health Monitor agent (`lib/atc/health-monitor.ts`) already detects CI failures on open PRs and performs stall recovery. A separate CI failure classifier (`classifyCIFailure`) is planned as a dependency work item and should return a classification string such as `'infra'`, `'test'`, `'lint'`, etc.

When the classifier returns `'infra'` (e.g., failed checkout step, runner connectivity issues, artifact download failures), these are transient and safe to retry automatically. This work adds that auto-retry loop:

1. Health Monitor calls `classifyCIFailure` on a failed CI run.
2. If `'infra'`, it calls GitHub's `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs` API.
3. A dedup guard in the event bus prevents re-triggering a retry for the same work item.
4. If the retry itself fails (or the re-run also fails on the next Health Monitor cycle), an escalation is created and no further retries are attempted.
5. All decisions are logged as events in the event bus and agent traces.

**Key detail:** The GitHub rerun API creates a **new** workflow run with a **new** run ID. Therefore, dedup cannot rely on matching `runId` alone — it must use `workItemId` as the primary dedup key (i.e., "has this work item already received an infra retry?").

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
2. Track retries using the event bus: before triggering, query for an existing `ci.infra_retry_triggered` event with matching `workItemId`. If one exists, skip the retry and escalate instead.
3. Emit a `ci.infra_retry_triggered` event immediately after a successful rerun API call, including `{ workItemId, prNumber, runId, repo }` payload.
4. Add `ci.infra_retry_triggered` and `ci.infra_retry_exhausted` event types to whichever file defines the event type union (`lib/atc/events.ts` or `lib/atc/types.ts`).
5. On a subsequent Health Monitor cycle, if the work item's CI is still failing AND a `ci.infra_retry_triggered` event already exists for that `workItemId`, create an escalation via `lib/escalation.ts` (`createEscalation`), emit a `ci.infra_retry_exhausted` event, and do not retry again.
6. All retry decisions (skipped/triggered/exhausted) must appear in the agent trace output for the Health Monitor cycle.
7. The `rerunFailedJobs` function must be added to `lib/github.ts` and be typed/exported properly.
8. TypeScript must compile with zero errors (`npx tsc --noEmit`).

---

## Execution Steps

### Step 0: Pre-flight — verify dependency exists

**This is an abort gate.** Before creating a branch, confirm the dependency is available:
