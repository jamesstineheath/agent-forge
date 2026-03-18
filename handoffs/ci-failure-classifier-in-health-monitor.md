<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- CI Failure Classifier in Health Monitor

## Metadata
- **Branch:** `feat/ci-failure-classifier-health-monitor`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `lib/atc/health-monitor.ts`, `lib/atc/tracing.ts`, `lib/__tests__/ci-failure-classifier.test.ts`

## Context

The Health Monitor (`lib/atc/health-monitor.ts`) is one of four autonomous agents in the ATC architecture (ADR-010). It handles stall detection, merge conflict recovery, and failed item reconciliation. Currently it detects that CI has failed but lacks nuance: it cannot distinguish infra failures (flaky runner, cancelled job, timeout) from real code failures (`npm run build`, `npm test`).

Adding a `classifyCIFailure(runId)` function enables smarter recovery logic downstream — e.g., auto-retrying infra failures without human escalation, while escalating persistent code failures.

The project uses `lib/atc/tracing.ts` for structured event tracing across the agent codebase. The GitHub API wrapper lives in `lib/github.ts`. The health monitor already imports from `lib/atc/types.ts`, `lib/atc/events.ts`, and `lib/github.ts`.

**No files overlap with concurrent work items** (`handoffs/bootstrap-rez-sniper-workflows.md`, `scripts/bootstrap-rez-sniper.sh`, `app/api/agents/digest/cron/route.ts`, `lib/digest.ts`, `vercel.json`). Safe to proceed.

## Requirements

1. Add `classifyCIFailure(runId: number, repoFullName: string)` function to `lib/atc/health-monitor.ts` (or a co-located utility file if the module is already very large).
2. The function calls the GitHub API to fetch workflow run jobs and their steps for the given `runId`.
3. Find the **first failed step** across all jobs (by job order, then step order within job).
4. Apply classification rules:
   - **`'infra'`**: Failed step name matches `'checkout'`, `'Set up job'`, `'setup-node'`, or `'actions/checkout'`; OR job/run conclusion is `'cancelled'` or `'timed_out'`.
   - **`'code'`**: Failed step name matches `'npm run build'`, `'npm test'`, `'Run npm run build'`, `'Run npm test'`; OR any user-defined step occurring after the setup phase.
   - **`'unknown'`**: Anything unrecognized — treat same as `'code'` (safer default) but return classification `'unknown'` so callers can distinguish.
5. Return type: `{ classification: 'infra' | 'code' | 'unknown', failedStep: string, reason: string }`.
6. Emit trace event `ci.failure_detected` (before classification) and `ci.failure_classified` (after) using the existing tracing infrastructure in `lib/atc/tracing.ts`.
7. Add unit tests in `lib/__tests__/ci-failure-classifier.test.ts` covering:
   - Checkout failure → `'infra'`
   - `npm run build` failure → `'code'`
   - Unrecognized step name → `'unknown'`
   - Cancelled conclusion with no failed step → `'infra'`
   - Trace events are emitted for both detection and classification.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/ci-failure-classifier-health-monitor
```

### Step 1: Inspect existing files

Read the relevant source files before writing any code:

```bash
cat lib/atc/health-monitor.ts
cat lib/atc/tracing.ts
cat lib/github.ts
cat lib/atc/types.ts
cat lib/atc/events.ts
```

Note:
- What tracing function signatures look like (e.g., `trace(event: string, data: object)` or similar).
- What GitHub API methods are already available on the client in `lib/github.ts` — specifically whether `listWorkflowRunJobs` or equivalent is already wrapped.
- Whether `health-monitor.ts` is already large — if >500 lines, add the classifier as a named export in a new file `lib/atc/ci-classifier.ts` and re-export from `health-monitor.ts`.

### Step 2: Add GitHub API method if missing

If `lib/github.ts` does not already have a method to fetch workflow run jobs and steps, add one:

```typescript
// In lib/github.ts — add to the GitHubClient class or exported functions

export async function getWorkflowRunJobs(
  repoFullName: string,
  runId: number,
  token: string
): Promise<WorkflowRunJobsResponse> {
  const [owner, repo] = repoFullName.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/jobs`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} fetching jobs for run ${runId}`);
  }
  return res.json();
}

// Minimal types (add near other GitHub types in the file or in lib/types.ts)
export interface WorkflowRunJob {
  id: number;
  name: string;
  conclusion: string | null;
  steps?: WorkflowRunStep[];
}

export interface WorkflowRunStep {
  name: string;
  conclusion: string | null;
  number: number;
}

export interface WorkflowRunJobsResponse {
  total_count: number;
  jobs: WorkflowRunJob[];
}
```

If these types already exist under different names, reuse them. Do **not** duplicate type definitions.

### Step 3: Implement the classifier

If `health-monitor.ts` is ≤500 lines, add the classifier directly in that file as an exported function. If it is >500 lines, create `lib/atc/ci-classifier.ts` instead and re-export from `health-monitor.ts`.

```typescript
// Classification constants — easy to extend later
const INFRA_STEP_NAMES = new Set([
  'Set up job',
  'checkout',
  'actions/checkout',
  'setup-node',
  'actions/setup-node',
  'Set up runner',
]);

const CODE_STEP_NAMES = new Set([
  'npm run build',
  'Run npm run build',
  'npm test',
  'Run npm test',
  'npm run test',
  'Run npm run test',
  'npx tsc',
  'Run npx tsc',
]);

const INFRA_CONCLUSIONS = new Set(['cancelled', 'timed_out']);

export interface CIFailureClassification {
  classification: 'infra' | 'code' | 'unknown';
  failedStep: string;
  reason: string;
}

/**
 * Classifies a GitHub Actions workflow run failure without LLM calls.
 * Returns classification, the name of the first failed step, and a human-readable reason.
 */
export async function classifyCIFailure(
  runId: number,
  repoFullName: string
): Promise<CIFailureClassification> {
  // Emit detection trace event BEFORE fetching (captures intent)
  traceEvent('ci.failure_detected', { runId, repoFullName });

  let jobsResponse: WorkflowRunJobsResponse;
  try {
    jobsResponse = await getWorkflowRunJobs(repoFullName, runId, process.env.GH_PAT ?? '');
  } catch (err) {
    const result: CIFailureClassification = {
      classification: 'unknown',
      failedStep: 'unknown',
      reason: `Failed to fetch workflow run jobs: ${String(err)}`,
    };
    traceEvent('ci.failure_classified', { runId, repoFullName, ...result });
    return result;
  }

  // Check for infra-level conclusion on the run level
  // (jobs with cancelled/timed_out conclusion)
  for (const job of jobsResponse.jobs) {
    if (job.conclusion && INFRA_CONCLUSIONS.has(job.conclusion)) {
      const result: CIFailureClassification = {
        classification: 'infra',
        failedStep: job.name,
        reason: `Job "${job.name}" concluded with "${job.conclusion}"`,
      };
      traceEvent('ci.failure_classified', { runId, repoFullName, ...result });
      return result;
    }
  }

  // Find first failed step across all jobs
  let firstFailedStep: { jobName: string; stepName: string } | null = null;

  outer: for (const job of jobsResponse.jobs) {
    const steps = job.steps ?? [];
    // Sort by step number to ensure correct ordering
    const sorted = [...steps].sort((a, b) => a.number - b.number);
    for (const step of sorted) {
      if (step.conclusion === 'failure') {
        firstFailedStep = { jobName: job.name, stepName: step.name };
        break outer;
      }
    }
  }

  if (!firstFailedStep) {
    // No failed step found — treat as unknown
    const result: CIFailureClassification = {
      classification: 'unknown',
      failedStep: 'none',
      reason: 'No failed step found in workflow run jobs',
    };
    traceEvent('ci.failure_classified', { runId, repoFullName, ...result });
    return result;
  }

  const stepName = firstFailedStep.stepName;

  // Apply classification rules
  let result: CIFailureClassification;

  if (INFRA_STEP_NAMES.has(stepName)) {
    result = {
      classification: 'infra',
      failedStep: stepName,
      reason: `Step "${stepName}" is a known infra/setup step`,
    };
  } else if (CODE_STEP_NAMES.has(stepName)) {
    result = {
      classification: 'code',
      failedStep: stepName,
      reason: `Step "${stepName}" is a known build/test step`,
    };
  } else {
    // Unknown step — safer default is 'unknown' (caller decides how to treat it)
    result = {
      classification: 'unknown',
      failedStep: stepName,
      reason: `Step "${stepName}" is not in the known infra or code step lists`,
    };
  }

  traceEvent('ci.failure_classified', { runId, repoFullName, ...result });
  return result;
}
```

**Important:** Replace `traceEvent` with whatever the actual tracing function signature is in `lib/atc/tracing.ts`. Read the file in Step 1 and adapt accordingly.

### Step 4: Write unit tests

Create `lib/__tests__/ci-failure-classifier.test.ts`:

```typescript
import { classifyCIFailure, CIFailureClassification } from '../atc/health-monitor'; // or '../atc/ci-classifier'

// Mock GH_PAT
process.env.GH_PAT = 'test-token';

// Mock lib/github.ts getWorkflowRunJobs
jest.mock('../github', () => ({
  ...jest.requireActual('../github'),
  getWorkflowRunJobs: jest.fn(),
}));

// Mock tracing
jest.mock('../atc/tracing', () => ({
  traceEvent: jest.fn(),
}));

import { getWorkflowRunJobs } from '../github';
import { traceEvent } from '../atc/tracing';

const mockGetJobs = getWorkflowRunJobs as jest.MockedFunction<typeof getWorkflowRunJobs>;
const mockTrace = traceEvent as jest.MockedFunction<typeof traceEvent>;

describe('classifyCIFailure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies checkout failure as infra', async () => {
    mockGetJobs.mockResolvedValueOnce({
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'build',
          conclusion: 'failure',
          steps: [
            { name: 'Set up job', conclusion: 'success', number: 1 },
            { name: 'checkout', conclusion: 'failure', number: 2 },
            { name: 'npm run build', conclusion: null, number: 3 },
          ],
        },
      ],
    });

    const result = await classifyCIFailure(123, 'owner/repo');

    expect(result.classification).toBe('infra');
    expect(result.failedStep).toBe('checkout');
    expect(result.reason).toContain('infra');
  });

  it('classifies npm run build failure as code', async () => {
    mockGetJobs.mockResolvedValueOnce({
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'build',
          conclusion: 'failure',
          steps: [
            { name: 'Set up job', conclusion: 'success', number: 1 },
            { name: 'checkout', conclusion: 'success', number: 2 },
            { name: 'npm run build', conclusion: 'failure', number: 3 },
          ],
        },
      ],
    });

    const result = await classifyCIFailure(456, 'owner/repo');

    expect(result.classification).toBe('code');
    expect(result.failedStep).toBe('npm run build');
  });

  it('returns unknown for unrecognized step name', async () => {
    mockGetJobs.mockResolvedValueOnce({
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'build',
          conclusion: 'failure',
          steps: [
            { name: 'Set up job', conclusion: 'success', number: 1 },
            { name: 'Run some-custom-script.sh', conclusion: 'failure', number: 2 },
          ],
        },
      ],
    });

    const result = await classifyCIFailure(789, 'owner/repo');

    expect(result.classification).toBe('unknown');
    expect(result.failedStep).toBe('Run some-custom-script.sh');
  });

  it('classifies cancelled job conclusion as infra (no specific failed step needed)', async () => {
    mockGetJobs.mockResolvedValueOnce({
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'build',
          conclusion: 'cancelled',
          steps: [],
        },
      ],
    });

    const result = await classifyCIFailure(999, 'owner/repo');

    expect(result.classification).toBe('infra');
    expect(result.reason).toContain('cancelled');
  });

  it('emits ci.failure_detected and ci.failure_classified trace events', async () => {
    mockGetJobs.mockResolvedValueOnce({
      total_count: 1,
      jobs: [
        {
          id: 1,
          name: 'build',
          conclusion: 'failure',
          steps: [
            { name: 'npm test', conclusion: 'failure', number: 1 },
          ],
        },
      ],
    });

    await classifyCIFailure(111, 'owner/repo');

    const eventNames = mockTrace.mock.calls.map((call) => call[0]);
    expect(eventNames).toContain('ci.failure_detected');
    expect(eventNames).toContain('ci.failure_classified');
  });
});
```

**Adapt mock paths** to match the actual module structure observed in Step 1. If `getWorkflowRunJobs` is a method on a class rather than a named export, adjust the mock accordingly.

### Step 5: Verify tracing import

Open `lib/atc/tracing.ts` and verify the exported function name and signature. Common patterns:

```typescript
// Pattern A — named export
export function traceEvent(event: string, data?: Record<string, unknown>): void

// Pattern B — default export object
import tracer from './tracing'; tracer.trace(...)

// Pattern C — Otel-style span
```

Use whatever pattern exists. Do not create a new tracing function — integrate with what's there. If no tracing file exists at that path, check `lib/tracing.ts` or look for `console.log`-based structured logging in the health monitor and match that pattern instead.

### Step 6: Verification

```bash
# Type check
npx tsc --noEmit

# Run tests
npm test -- --testPathPattern="ci-failure-classifier"

# Full build check
npm run build
```

If any type errors arise from the new GitHub API types conflicting with existing ones, resolve by reusing existing types from `lib/types.ts` or `lib/github.ts` rather than introducing duplicates.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add classifyCIFailure to health monitor with trace events"
git push origin feat/ci-failure-classifier-health-monitor
gh pr create \
  --title "feat: CI failure classifier in Health Monitor" \
  --body "## Summary

Adds \`classifyCIFailure(runId, repoFullName)\` to the Health Monitor agent.

### What it does
- Calls GitHub API to fetch workflow run jobs and steps
- Finds the first failed step across all jobs
- Classifies as \`'infra'\` (checkout/setup failures, cancelled/timed_out), \`'code'\` (build/test failures), or \`'unknown'\` (unrecognized steps)
- Emits \`ci.failure_detected\` and \`ci.failure_classified\` trace events

### Classification rules
| Classification | Triggers |
|---|---|
| \`infra\` | Step: \`Set up job\`, \`checkout\`, \`setup-node\`; or job conclusion: \`cancelled\`/\`timed_out\` |
| \`code\` | Step: \`npm run build\`, \`npm test\`, variants |
| \`unknown\` | Anything else (safer default) |

### Files changed
- \`lib/atc/health-monitor.ts\` (or \`lib/atc/ci-classifier.ts\` if extracted)
- \`lib/github.ts\` (new \`getWorkflowRunJobs\` helper if needed)
- \`lib/__tests__/ci-failure-classifier.test.ts\` (new)

### Testing
All acceptance criteria covered by unit tests with mocked GitHub API and tracing."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/ci-failure-classifier-health-monitor
FILES CHANGED: [list what was modified]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "tracing.ts has no exported function matching expected signature"]
NEXT STEPS: [e.g., "Wire classifyCIFailure return value into Health Monitor stall recovery path; adapt mock in test to match class-based GitHub client"]
```

If the blocker is architectural (e.g., `lib/atc/tracing.ts` doesn't exist and there's no clear tracing pattern), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "ci-failure-classifier-health-monitor",
    "reason": "lib/atc/tracing.ts does not exist and no clear tracing pattern found in codebase",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 5",
      "error": "Cannot find module lib/atc/tracing — no tracing infrastructure exists",
      "filesChanged": ["lib/atc/health-monitor.ts", "lib/github.ts"]
    }
  }'
```