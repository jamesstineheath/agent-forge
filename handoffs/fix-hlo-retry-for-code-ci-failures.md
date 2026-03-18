<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix HLO Retry for Code CI Failures

## Metadata
- **Branch:** `fix/hlo-retry-code-ci-failures`
- **Priority:** high
- **Model:** opus
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** `lib/atc/health-monitor.ts`, `lib/atc/types.ts`, `.github/workflows/execute-handoff.yml`, `lib/atc/events.ts`, `lib/escalation.ts`

## Context

The HLO (Handoff Lifecycle Orchestrator) displays "Retries: 0/1" in PR lifecycle comments, indicating retry budget is tracked, but the retry itself never fires when CI fails due to a code error. The CI failure classifier (a dependency of this work item) classifies failures as `'code'` vs `'infra'` etc. The Health Monitor (`lib/atc/health-monitor.ts`) is responsible for detecting stalls and CI failures, and should be the component that triggers re-execution — but the transition logic that fires the retry appears to be missing or incomplete.

The retry flow should work as follows:
1. Health Monitor detects a CI failure classified as `'code'`
2. Health Monitor calls the execute-handoff workflow via GitHub API `workflow_dispatch`, passing error logs as input context
3. The re-execution pushes new commits to the same PR branch
4. HLO updates the lifecycle comment to "Retries: 1/1"
5. On second failure → work item transitions to `'failed'` + escalation created

Key files to examine:
- `lib/atc/health-monitor.ts` — where CI failure detection and retry logic should live
- `lib/atc/types.ts` — CycleContext, timeout definitions, retry budget types
- `.github/workflows/execute-handoff.yml` — whether it accepts `retry_context` input and supports re-execution dispatch
- `lib/atc/events.ts` — event emission (need `ci.code_retry_triggered`)
- `lib/escalation.ts` — escalation creation for exhausted retries

**No-conflict zones:** Do not modify `vercel.json`, `app/api/agents/digest/cron/route.ts`, `lib/digest.ts`, `handoffs/bootstrap-rez-sniper-workflows.md`, or `scripts/bootstrap-rez-sniper.sh`.

## Requirements

1. Health Monitor detects when a work item in `executing` state has a PR whose CI checks have failed with a `'code'` classification (from the CI failure classifier).
2. If the work item's retry count is below the retry budget (default 1), Health Monitor triggers re-execution via `workflow_dispatch` on `execute-handoff.yml`, passing the build error logs as additional context.
3. The work item's retry counter increments in storage after a retry is triggered.
4. A `ci.code_retry_triggered` event is emitted to the event log after each retry dispatch.
5. The HLO lifecycle comment (updated via GitHub API or the handoff orchestrator workflow) reflects "Retries: 1/1" after the retry fires.
6. If the retry budget is exhausted and CI still fails with `'code'`, the work item transitions to `'failed'` and an escalation is created.
7. TypeScript compiles with no errors (`npx tsc --noEmit`).
8. Existing tests pass; new unit tests cover the retry trigger and exhaustion paths.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/hlo-retry-code-ci-failures
```

### Step 1: Audit current state — read all relevant files

Read and understand the following files before writing any code:

```bash
cat lib/atc/health-monitor.ts
cat lib/atc/types.ts
cat lib/atc/events.ts
cat lib/atc/utils.ts
cat lib/atc/lock.ts
cat lib/escalation.ts
cat lib/github.ts
cat lib/work-items.ts
cat .github/workflows/execute-handoff.yml
```

Look specifically for:
- In `health-monitor.ts`: any existing `ci` failure detection block. Search for keywords: `ciFailure`, `ci_failure`, `code`, `retry`, `retryCount`, `retryBudget`.
- In `types.ts`: whether `WorkItem` or `CycleContext` has `retryCount`, `retryBudget`, or similar fields.
- In `execute-handoff.yml`: whether `workflow_dispatch` inputs include a `retry_context` or `error_context` field.
- In `github.ts`: whether there's a `triggerWorkflow` or `workflowDispatch` helper.
- In `events.ts`: the shape of event emission (function signature, event type union).

Document your findings as inline comments in the implementation steps below.

### Step 2: Extend types if needed

Open `lib/atc/types.ts`. If `WorkItem` (or the health monitor's working state type) does not already have retry tracking fields, **do not add them to `types.ts` directly** — `WorkItem` is likely defined in `lib/types.ts`. Check:

```bash
cat lib/types.ts | grep -A 20 "WorkItem"
```

If `WorkItem` lacks `retryCount` and `retryBudget`:

```typescript
// In lib/types.ts, add to WorkItem interface:
retryCount?: number;       // how many code-CI retries have been attempted
retryBudget?: number;      // max allowed retries (default 1)
```

If `WorkItem` already has these fields (possibly named differently), map to them in the health monitor logic. Do not rename existing fields.

### Step 3: Extend execute-handoff.yml to accept retry context input

Open `.github/workflows/execute-handoff.yml`. The workflow needs to accept an optional `retry_context` input when dispatched by the health monitor.

Add (or verify existence of) a `workflow_dispatch` input:

```yaml
on:
  workflow_dispatch:
    inputs:
      handoff_file:
        description: 'Path to handoff file'
        required: true
        type: string
      retry_context:
        description: 'Optional JSON string with CI error context for retry'
        required: false
        type: string
        default: ''
```

In the step that runs Claude Code (look for `claude` or `claude-code` invocation), inject the retry context when present. For example, if there is an `env` block or a step that writes a context file:

```yaml
- name: Prepare retry context
  if: ${{ inputs.retry_context != '' }}
  run: |
    echo '${{ inputs.retry_context }}' > /tmp/retry_context.json
    echo "RETRY_CONTEXT_FILE=/tmp/retry_context.json" >> $GITHUB_ENV

- name: Run Claude Code
  env:
    RETRY_CONTEXT: ${{ inputs.retry_context }}
  run: |
    # existing Claude invocation — append retry context to prompt if set
    if [ -n "$RETRY_CONTEXT" ]; then
      echo "## Retry Context (Previous CI Failure)" >> /tmp/handoff_with_context.md
      echo "$RETRY_CONTEXT" >> /tmp/handoff_with_context.md
      # use /tmp/handoff_with_context.md as the handoff input
    fi
    # ... rest of existing invocation
```

**Important:** Carefully read the existing workflow steps before modifying. Match the exact Claude invocation pattern already present. The goal is to append error context without breaking the happy path. If the workflow already has a retry mechanism under a different name, use that instead of adding new inputs.

### Step 4: Add GitHub workflow dispatch helper (if missing)

Check `lib/github.ts` for an existing workflow dispatch function:

```bash
grep -n "workflowDispatch\|workflow_dispatch\|triggerWorkflow" lib/github.ts
```

If missing, add to `lib/github.ts`:

```typescript
export async function triggerWorkflowDispatch(
  owner: string,
  repo: string,
  workflowId: string,
  ref: string,
  inputs: Record<string, string>
): Promise<void> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_PAT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs }),
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `workflow_dispatch failed: ${response.status} ${response.statusText} — ${body}`
    );
  }
}
```

If a helper already exists, use it as-is.

### Step 5: Implement retry logic in Health Monitor

Open `lib/atc/health-monitor.ts`. Find the section that handles stall detection or CI check evaluation for executing work items. The pattern likely looks like:

```typescript
// Somewhere in the health monitor cycle:
for (const item of executingItems) {
  const checks = await getCIChecks(item);
  if (checks.allFailed) {
    // TODO: handle CI failure
  }
}
```

Add or complete the `'code'` CI failure retry branch. Below is the reference implementation — adapt field names and function signatures to match what already exists in the file:

```typescript
import { triggerWorkflowDispatch } from '../github';
import { appendEvent } from './events';
import { createEscalation } from '../escalation';
import { updateWorkItem } from '../work-items';

// Inside the CI failure handling block:
async function handleCodeCIFailure(
  item: WorkItem,
  errorLogs: string,
  ctx: CycleContext
): Promise<void> {
  const retryBudget = item.retryBudget ?? 1;
  const retryCount = item.retryCount ?? 0;

  if (retryCount < retryBudget) {
    // Trigger re-execution with error context
    const retryContext = JSON.stringify({
      previousAttempt: retryCount + 1,
      errorLogs: errorLogs.slice(0, 4000), // cap to avoid input size limits
      workItemId: item.id,
      timestamp: new Date().toISOString(),
    });

    const [owner, repo] = (item.repoFullName ?? ctx.repoFullName).split('/');

    await triggerWorkflowDispatch(
      owner,
      repo,
      'execute-handoff.yml',
      item.branch,  // dispatch against the PR branch so new commits go there
      {
        handoff_file: item.handoffPath,
        retry_context: retryContext,
      }
    );

    // Increment retry counter
    await updateWorkItem(item.id, {
      retryCount: retryCount + 1,
    });

    // Emit structured event
    await appendEvent({
      type: 'ci.code_retry_triggered',
      workItemId: item.id,
      payload: {
        attempt: retryCount + 1,
        retryBudget,
        branch: item.branch,
        errorSummary: errorLogs.slice(0, 500),
      },
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[HealthMonitor] ci.code_retry_triggered workItem=${item.id} attempt=${retryCount + 1}/${retryBudget}`
    );
  } else {
    // Budget exhausted — mark failed and escalate
    await updateWorkItem(item.id, { status: 'failed' });

    await createEscalation({
      workItemId: item.id,
      reason: `CI failed with code error after ${retryCount} retry attempt(s). Manual intervention required.`,
      errorContext: errorLogs.slice(0, 2000),
    });

    await appendEvent({
      type: 'ci.code_retry_exhausted',
      workItemId: item.id,
      payload: {
        attempts: retryCount,
        retryBudget,
      },
      timestamp: new Date().toISOString(),
    });

    console.log(
      `[HealthMonitor] ci.code_retry_exhausted workItem=${item.id} — marked failed, escalation created`
    );
  }
}
```

**Integration point:** Find where health monitor currently reads CI check results. Look for calls to `getCIChecks`, `getCheckRuns`, or similar in `lib/github.ts`. The CI failure classifier (dependency work item) will have added a `classifyCIFailure(checks)` function that returns `{ type: 'code' | 'infra' | 'flaky', errorLogs: string }`. If that function does not yet exist (dependency not merged), add a stub:

```typescript
// lib/atc/utils.ts or inline in health-monitor.ts
function classifyCIFailure(checks: CheckRun[]): { type: 'code' | 'infra' | 'flaky'; errorLogs: string } {
  // Stub: treat all failures as 'code' until classifier is merged
  // TODO: replace with real classifier from CI failure classifier work item
  const failedCheck = checks.find(c => c.conclusion === 'failure');
  return {
    type: 'code',
    errorLogs: failedCheck?.output?.text ?? failedCheck?.output?.summary ?? 'No error details available',
  };
}
```

Wire the call:

```typescript
const ciChecks = await getCIChecks(item.prNumber, owner, repo); // adapt to existing signature
if (ciChecks.some(c => c.conclusion === 'failure')) {
  const { type, errorLogs } = classifyCIFailure(ciChecks);
  if (type === 'code') {
    await handleCodeCIFailure(item, errorLogs, ctx);
  }
  // 'infra' and 'flaky' handled separately (existing logic or no-op for now)
}
```

### Step 6: Add `ci.code_retry_triggered` and `ci.code_retry_exhausted` to event type union

Check `lib/atc/events.ts` or `lib/event-bus-types.ts` for the event type union:

```bash
grep -n "EventType\|event.*type\|type.*event" lib/atc/events.ts lib/event-bus-types.ts 2>/dev/null
```

Add the new event types to the union (or string literal type) if they are not already present:

```typescript
// In the relevant types file:
export type ATCEventType =
  | 'ci.code_retry_triggered'
  | 'ci.code_retry_exhausted'
  | /* ... existing types ... */;
```

### Step 7: Ensure escalation.ts createEscalation signature is compatible

Check `lib/escalation.ts`:

```bash
grep -n "createEscalation\|export function\|export async function" lib/escalation.ts
```

The `createEscalation` call in Step 5 passes `{ workItemId, reason, errorContext }`. If the real signature differs, adapt the call in health-monitor.ts to match — do not change escalation.ts's interface.

### Step 8: Write unit tests

Create `lib/__tests__/hlo-code-retry.test.ts`:

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock dependencies
jest.mock('../github', () => ({
  triggerWorkflowDispatch: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../work-items', () => ({
  updateWorkItem: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../escalation', () => ({
  createEscalation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../atc/events', () => ({
  appendEvent: jest.fn().mockResolvedValue(undefined),
}));

import { triggerWorkflowDispatch } from '../github';
import { updateWorkItem } from '../work-items';
import { createEscalation } from '../escalation';
import { appendEvent } from '../atc/events';

// Import the function under test — adjust path/name to match actual export
// If handleCodeCIFailure is not exported, export it or test via the health monitor cycle
import { handleCodeCIFailure } from '../atc/health-monitor';

const mockItem = {
  id: 'wi-test-001',
  status: 'executing',
  branch: 'feat/test-branch',
  handoffPath: 'handoffs/test.md',
  repoFullName: 'jamesstineheath/agent-forge',
  retryCount: 0,
  retryBudget: 1,
};

describe('handleCodeCIFailure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('triggers workflow dispatch on first failure (retry count 0)', async () => {
    await handleCodeCIFailure(mockItem as any, 'build error: cannot find module', {} as any);

    expect(triggerWorkflowDispatch).toHaveBeenCalledWith(
      'jamesstineheath',
      'agent-forge',
      'execute-handoff.yml',
      'feat/test-branch',
      expect.objectContaining({
        handoff_file: 'handoffs/test.md',
        retry_context: expect.stringContaining('build error'),
      })
    );
    expect(updateWorkItem).toHaveBeenCalledWith('wi-test-001', { retryCount: 1 });
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ci.code_retry_triggered' })
    );
    expect(createEscalation).not.toHaveBeenCalled();
  });

  it('marks failed and creates escalation when budget exhausted', async () => {
    const exhaustedItem = { ...mockItem, retryCount: 1, retryBudget: 1 };

    await handleCodeCIFailure(exhaustedItem as any, 'build error: type mismatch', {} as any);

    expect(triggerWorkflowDispatch).not.toHaveBeenCalled();
    expect(updateWorkItem).toHaveBeenCalledWith('wi-test-001', { status: 'failed' });
    expect(createEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: 'wi-test-001' })
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ci.code_retry_exhausted' })
    );
  });

  it('caps error logs at 4000 chars in retry_context', async () => {
    const longError = 'x'.repeat(10000);
    await handleCodeCIFailure(mockItem as any, longError, {} as any);

    const call = (triggerWorkflowDispatch as jest.Mock).mock.calls[0];
    const inputs = call[4] as Record<string, string>;
    const context = JSON.parse(inputs.retry_context);
    expect(context.errorLogs.length).toBeLessThanOrEqual(4000);
  });
});
```

**Note:** If `handleCodeCIFailure` is not directly exported from `health-monitor.ts`, export it with `export async function handleCodeCIFailure(...)` or test it by invoking the full health monitor cycle with mocked dependencies.

### Step 9: Verification

```bash
# Type check
npx tsc --noEmit

# Run tests
npx jest lib/__tests__/hlo-code-retry.test.ts --verbose

# Run full test suite to confirm no regressions
npm test

# Lint
npm run lint 2>/dev/null || true

# Build (if applicable)
npm run build 2>/dev/null || true
```

Fix any TypeScript errors before proceeding. Common issues:
- `retryCount` / `retryBudget` not on `WorkItem` type → add optional fields to `lib/types.ts`
- `appendEvent` signature mismatch → check `lib/atc/events.ts` for actual signature
- `createEscalation` signature mismatch → adapt call site, not the library function

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "fix: implement HLO code CI retry in health monitor

- Health monitor now detects 'code' CI failures and triggers re-execution
- workflow_dispatch called with error logs as retry_context input
- retryCount incremented on each attempt; escalation created on exhaustion
- Emits ci.code_retry_triggered and ci.code_retry_exhausted events
- execute-handoff.yml accepts optional retry_context workflow_dispatch input
- Unit tests cover retry trigger and budget exhaustion paths

Closes #<issue-number-if-known>"

git push origin fix/hlo-retry-code-ci-failures

gh pr create \
  --title "fix: implement HLO retry for code CI failures" \
  --body "## Summary

Fixes the HLO retry mechanism for code CI failures. The health monitor now:

1. Detects CI check failures classified as \`'code'\`
2. Triggers \`workflow_dispatch\` on \`execute-handoff.yml\` with error logs as \`retry_context\`
3. Increments \`retryCount\` on the work item in storage
4. Emits \`ci.code_retry_triggered\` event to the event log
5. On budget exhaustion: transitions work item to \`failed\` + creates escalation + emits \`ci.code_retry_exhausted\`

## Files Changed
- \`lib/atc/health-monitor.ts\` — retry trigger + exhaustion logic
- \`lib/types.ts\` — \`retryCount\` / \`retryBudget\` optional fields on WorkItem (if missing)
- \`lib/atc/types.ts\` / \`lib/event-bus-types.ts\` — new event type literals
- \`lib/github.ts\` — \`triggerWorkflowDispatch\` helper (if missing)
- \`.github/workflows/execute-handoff.yml\` — \`retry_context\` workflow_dispatch input
- \`lib/__tests__/hlo-code-retry.test.ts\` — unit tests

## Testing
- Unit tests pass for retry trigger and budget exhaustion
- TypeScript compiles clean
- No regressions in existing test suite

## Acceptance Criteria
- [x] Code CI failure triggers re-execution with error context
- [x] retryCount increments in storage
- [x] ci.code_retry_triggered event emitted
- [x] Budget exhaustion → failed status + escalation
- [x] ci.code_retry_exhausted event emitted" \
  --draft=false
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/hlo-retry-code-ci-failures
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed — e.g. "classifyCIFailure not yet exported from CI classifier work item; used stub instead"]
NEXT STEPS: [what remains — e.g. "replace classifyCIFailure stub with real import once dependency merges"]
```

## Escalation Protocol

If you encounter a blocker that cannot be resolved autonomously (e.g., the CI failure classifier dependency was never merged and its API is unknown, or `execute-handoff.yml` has a fundamentally incompatible structure):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-hlo-retry-code-ci-failures",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc/health-monitor.ts", "lib/types.ts"]
    }
  }'
```

## Key Implementation Notes

1. **Dependency on CI failure classifier:** The `classifyCIFailure` function is expected from the classifier work item. If it's not yet merged, implement the stub in Step 5 and add a `// TODO: replace stub` comment. The retry logic itself must still work end-to-end with the stub.

2. **Branch for dispatch:** `workflow_dispatch` must be called against `item.branch` (the PR branch), not `main`, so new commits from the re-execution land on the existing PR.

3. **Idempotency guard:** Before triggering a retry, check that the work item is not already in a retry-pending state (e.g., a recent `ci.code_retry_triggered` event within the last 15 minutes) to avoid double-firing during overlapping health monitor cycles.

4. **No-conflict zones:** Do not touch `vercel.json`, `app/api/agents/digest/`, `lib/digest.ts`, or any bootstrap scripts — those are owned by concurrent work items on other branches.