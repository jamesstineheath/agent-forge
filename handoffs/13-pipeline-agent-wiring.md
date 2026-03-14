# Handoff 13: Pipeline Agent Wiring + E2E

## Metadata
- **Branch:** `feat/pipeline-escalation-wiring`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $6
- **Risk Level:** low
- **Depends On:** Handoff 11 (Escalation State Machine), Handoff 12 (Gmail Integration)
- **Date:** 2026-03-14
- **Executor:** Claude Code (GitHub Actions)

## Context

Agent Forge's escalation capability (Handoff 11) and Gmail integration (Handoff 12) are now in place. However, the pipeline agents running in target repos (personal-assistant, rez-sniper) cannot yet call the escalation API because:

1. The `/api/escalations` POST endpoint has no authentication, making it vulnerable
2. The pipeline agents (Spec Reviewer, Executor, Code Reviewer) don't know when or how to escalate
3. No E2E test exists to verify the full escalation flow works end-to-end

This handoff wires the escalation capability into the pipeline by:
- Adding Bearer token authentication to the escalation POST endpoint
- Embedding escalation instructions in handoff metadata/execution context
- Updating target repo workflows to pass the shared secret
- Adding an E2E test script to verify the complete flow

**Assumption:** Handoff 11 (Escalation State Machine) and Handoff 12 (Gmail Integration) have already merged. This means:
- `lib/escalation.ts` exists with full escalate/resolve flow
- `lib/gmail.ts` exists with email send/poll
- WorkItem has "blocked" status
- ATC polls for email replies and resolves escalations
- `/api/escalations` POST endpoint exists
- Escalation interface has: `id, workItemId, reason, confidenceScore, contextSnapshot, status, threadId, ...`

## Pre-flight Self-Check

Before starting:
- [ ] Verify that `lib/escalation.ts` exists in agent-forge (from Handoff 11)
- [ ] Verify that `lib/gmail.ts` exists in agent-forge (from Handoff 12)
- [ ] Verify that `app/api/escalations/route.ts` exists and has a POST handler
- [ ] Verify that `lib/orchestrator.ts` exists and has a `dispatchWorkItem()` function
- [ ] Verify that `jamesstineheath/personal-assistant` repo exists and has `.github/workflows/execute-handoff.yml`
- [ ] Verify that `jamesstineheath/rez-sniper` repo exists and has `.github/workflows/execute-handoff.yml`
- [ ] Have a GitHub token with `repo` scope available (via GITHUB_TOKEN in Actions or personal token)
- [ ] Have Vercel API token available if updating env vars is needed (likely manual post-execution)

If any of these don't exist, abort and notify the Spec Reviewer.

## Step 0: Branch setup

```bash
cd /tmp/agent-forge
git clone https://github.com/jamesstineheath/agent-forge.git .
git fetch origin
git checkout -b feat/pipeline-escalation-wiring origin/main
```

Verify branch is clean and up to date:
```bash
git status
git log -1 --oneline
```

## Step 1: Add Bearer token auth to /api/escalations POST endpoint

**File:** `app/api/escalations/route.ts`

**Action:** Update the POST handler to check for `Authorization: Bearer {AGENT_FORGE_API_SECRET}` header.

**Find:** The POST function that handles escalation creation (should start with `export async function POST(req: Request)`).

**Replace:**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { createEscalation, resolveEscalation, getEscalations } from '@/lib/escalation';

const API_SECRET = process.env.AGENT_FORGE_API_SECRET;

function validateAuthToken(req: NextRequest): boolean {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return false;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;

  const token = parts[1];
  return token === API_SECRET;
}

export async function POST(req: NextRequest) {
  // Validate Bearer token
  if (!validateAuthToken(req)) {
    return NextResponse.json(
      { error: 'Unauthorized: Invalid or missing authentication token' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const { workItemId, reason, confidenceScore, contextSnapshot } = body;

    if (!workItemId || !reason) {
      return NextResponse.json(
        { error: 'Missing required fields: workItemId, reason' },
        { status: 400 }
      );
    }

    const escalation = await createEscalation({
      workItemId,
      reason,
      confidenceScore: confidenceScore || 0.5,
      contextSnapshot: contextSnapshot || {},
    });

    return NextResponse.json(escalation, { status: 201 });
  } catch (error) {
    console.error('Failed to create escalation:', error);
    return NextResponse.json(
      { error: 'Failed to create escalation' },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  // GET remains unauthenticated (dashboard reads it)
  try {
    const escalations = await getEscalations();
    return NextResponse.json(escalations);
  } catch (error) {
    console.error('Failed to fetch escalations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch escalations' },
      { status: 500 }
    );
  }
}
```

**Verify:** The code imports `NextRequest` and uses `validateAuthToken()` to check the Bearer token before processing POST requests. GET requests are unauthenticated.

## Step 2: Update lib/orchestrator.ts to include escalation context in handoffs

**File:** `lib/orchestrator.ts`

**Action:** Find the function that generates handoff content or execution prompts. Add escalation instructions to the metadata or execution context that gets written to the target repo.

**Find:** The section where handoff metadata is set (typically in `dispatchWorkItem()` or a helper function that builds handoff content). Look for where the execution prompt or handoff instructions are constructed.

**Add to the handoff metadata section** (insert before the handoff is written to disk/pushed):

```typescript
/**
 * Escalation context for pipeline agents
 * Pipeline agents running in target repos will use this to call Agent Forge escalation API
 */
const escalationContext = {
  apiUrl: process.env.AGENT_FORGE_URL || 'https://agent-forge-phi.vercel.app',
  apiSecret: 'AGENT_FORGE_API_SECRET', // Secret will be injected by target repo's GitHub Actions
  instructions: `
## Escalation Protocol

If during execution you encounter ANY of the following, escalate to Agent Forge instead of guessing:
1. **Ambiguous handoff instructions** - The handoff step is unclear or has conflicting requirements
2. **Failed retries** - You've attempted a step 2+ times and it keeps failing
3. **Out-of-scope decisions** - The handoff requires a decision that wasn't pre-authorized or isn't in the spec
4. **High-impact changes** - The handoff involves architectural changes, security modifications, or breaking changes
5. **Missing context** - Critical context or dependencies are missing and you cannot proceed safely

### How to escalate:

Use curl to POST to Agent Forge's escalation API:

\`\`\`bash
curl -X POST {AGENT_FORGE_URL}/api/escalations \\
  -H "Authorization: Bearer {AGENT_FORGE_API_SECRET}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "workItemId": "{WORK_ITEM_ID}",
    "reason": "Brief description of why you cannot proceed",
    "confidenceScore": 0.5,
    "contextSnapshot": {
      "step": "{current_step_number}",
      "lastAction": "{what you were trying to do}",
      "error": "{error message if applicable}"
    }
  }'
\`\`\`

Replace \`{AGENT_FORGE_URL}\`, \`{AGENT_FORGE_API_SECRET}\`, \`{WORK_ITEM_ID}\` with the actual values provided by the orchestrator.

After escalation, the handoff will be marked as "blocked" and a Spec Reviewer will handle it via email.
`,
};

// When building the handoff content, include this context:
const handoffWithEscalation = {
  ...handoffContent,
  metadata: {
    ...handoffContent.metadata,
    escalation: escalationContext,
  },
};
```

**Verify:** The orchestrator now includes escalation instructions in the handoff metadata. The instructions should be clear about when and how to escalate.

## Step 3: Create E2E test script

**File:** `scripts/test-escalation-e2e.ts`

**Action:** Create a new file with complete E2E test logic.

**Complete content:**

```typescript
import { config } from 'dotenv';
config();

const API_URL = process.env.AGENT_FORGE_URL || 'http://localhost:3000';
const API_SECRET = process.env.AGENT_FORGE_API_SECRET;

if (!API_SECRET) {
  console.error('ERROR: AGENT_FORGE_API_SECRET environment variable is not set');
  process.exit(1);
}

interface WorkItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

interface Escalation {
  id: string;
  workItemId: string;
  reason: string;
  confidenceScore: number;
  status: string;
  threadId?: string;
  createdAt: string;
}

async function createTestWorkItem(): Promise<string> {
  console.log('Creating test work item...');
  const res = await fetch(`${API_URL}/api/workitems`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test E2E Escalation',
      description: 'Automated E2E test work item',
      repo: 'test-repo',
      priority: 'medium',
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to create work item: ${res.status} ${res.statusText}`);
  }

  const data: WorkItem = await res.json();
  console.log(`Created work item: ${data.id}`);
  return data.id;
}

async function getWorkItem(id: string): Promise<WorkItem> {
  const res = await fetch(`${API_URL}/api/workitems/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to get work item: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function createEscalation(workItemId: string, reason: string): Promise<Escalation> {
  console.log(`Creating escalation for work item ${workItemId}...`);
  const res = await fetch(`${API_URL}/api/escalations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      workItemId,
      reason,
      confidenceScore: 0.7,
      contextSnapshot: {
        testStep: 1,
        testReason: 'E2E test escalation',
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create escalation: ${res.status} ${text}`);
  }

  const data: Escalation = await res.json();
  console.log(`Created escalation: ${data.id}`);
  return data;
}

async function resolveEscalation(escalationId: string, resolution: string): Promise<Escalation> {
  console.log(`Resolving escalation ${escalationId}...`);
  const res = await fetch(`${API_URL}/api/escalations/${escalationId}/resolve`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resolution,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to resolve escalation: ${res.status} ${text}`);
  }

  const data: Escalation = await res.json();
  console.log(`Resolved escalation: ${data.id}`);
  return data;
}

async function deleteWorkItem(id: string): Promise<void> {
  console.log(`Cleaning up work item ${id}...`);
  const res = await fetch(`${API_URL}/api/workitems/${id}`, {
    method: 'DELETE',
  });

  if (!res.ok) {
    console.warn(`Failed to delete work item: ${res.status} ${res.statusText}`);
  } else {
    console.log(`Deleted work item: ${id}`);
  }
}

async function runE2ETest() {
  console.log('Starting Agent Forge Escalation E2E Test\n');

  let testWorkItemId: string | null = null;
  let escalationId: string | null = null;

  try {
    // Step 1: Create test work item
    testWorkItemId = await createTestWorkItem();

    // Step 2: Verify work item status is "queued"
    let workItem = await getWorkItem(testWorkItemId);
    if (workItem.status !== 'queued') {
      throw new Error(`Expected work item status "queued", got "${workItem.status}"`);
    }
    console.log(`Work item status verified: ${workItem.status}\n`);

    // Step 3: Create escalation
    const escalation = await createEscalation(
      testWorkItemId,
      'Test E2E escalation scenario'
    );
    escalationId = escalation.id;

    if (escalation.status !== 'pending') {
      throw new Error(`Expected escalation status "pending", got "${escalation.status}"`);
    }
    console.log(`Escalation status verified: ${escalation.status}\n`);

    // Step 4: Verify work item status changed to "blocked"
    workItem = await getWorkItem(testWorkItemId);
    if (workItem.status !== 'blocked') {
      throw new Error(`Expected work item status "blocked" after escalation, got "${workItem.status}"`);
    }
    console.log(`Work item status changed to: ${workItem.status}\n`);

    // Step 5: Resolve escalation
    const resolved = await resolveEscalation(
      escalationId,
      'Test resolution - proceeding with execution'
    );

    if (resolved.status !== 'resolved') {
      throw new Error(`Expected escalation status "resolved", got "${resolved.status}"`);
    }
    console.log(`Escalation status verified: ${resolved.status}\n`);

    // Step 6: Verify work item status changed back to "queued"
    workItem = await getWorkItem(testWorkItemId);
    if (workItem.status !== 'queued') {
      throw new Error(`Expected work item status "queued" after resolution, got "${workItem.status}"`);
    }
    console.log(`Work item status changed back to: ${workItem.status}\n`);

    console.log('='.repeat(50));
    console.log('E2E TEST PASSED');
    console.log('='.repeat(50));
    console.log('\nEscalation flow verified:');
    console.log('  1. Created work item (status: queued)');
    console.log('  2. Created escalation (status: pending)');
    console.log('  3. Work item transitioned to blocked');
    console.log('  4. Resolved escalation (status: resolved)');
    console.log('  5. Work item returned to queued');

    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(50));
    console.error('E2E TEST FAILED');
    console.error('='.repeat(50));
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  } finally {
    // Cleanup
    if (testWorkItemId) {
      await deleteWorkItem(testWorkItemId);
    }
  }
}

runE2ETest();
```

**Verify:** File is created at `scripts/test-escalation-e2e.ts` with complete E2E test logic.

## Step 4: Update execute-handoff.yml in personal-assistant repo

**File:** `jamesstineheath/personal-assistant:.github/workflows/execute-handoff.yml`

**Action:** Use GitHub API to read the current workflow file, add `AGENT_FORGE_API_SECRET` to the env block, and add escalation instructions to the execution prompt section.

**Modification logic:**

Find the `env:` block in the workflow. If it doesn't exist, add it. Add or update `AGENT_FORGE_API_SECRET`:

```yaml
env:
  AGENT_FORGE_URL: "https://agent-forge-phi.vercel.app"
  AGENT_FORGE_API_SECRET: ${{ secrets.AGENT_FORGE_API_SECRET }}
```

Find the section where the Claude Code execution prompt is defined. Add escalation instructions to the prompt.

## Step 5: Update execute-handoff.yml in rez-sniper repo

**File:** `jamesstineheath/rez-sniper:.github/workflows/execute-handoff.yml`

**Action:** Apply identical changes to rez-sniper's workflow.

## Step 6: Test the E2E script locally

```bash
export AGENT_FORGE_URL="https://agent-forge-phi.vercel.app"
export AGENT_FORGE_API_SECRET="<value from Vercel>"
npx tsx scripts/test-escalation-e2e.ts
```

## Step 7: Commit, push, and open PR

```bash
git add -A
git commit -m "feat(escalation): wire pipeline agent escalation + E2E test

- Add Bearer token auth to POST /api/escalations endpoint
- Update lib/orchestrator.ts to include escalation context in handoffs
- Add E2E test script (scripts/test-escalation-e2e.ts) to verify full flow
- Update personal-assistant execute-handoff.yml with escalation instructions
- Update rez-sniper execute-handoff.yml with escalation instructions
- Add AGENT_FORGE_API_SECRET to both target repo secrets"

git push -u origin feat/pipeline-escalation-wiring
```

## Verification

- [ ] `/app/api/escalations/route.ts` POST handler checks for Bearer token
- [ ] Token validation returns 401 for missing/invalid tokens
- [ ] GET `/api/escalations` remains unauthenticated (for dashboard)
- [ ] `lib/orchestrator.ts` includes escalation context in handoff metadata
- [ ] `scripts/test-escalation-e2e.ts` exists and runs without errors
- [ ] Personal-assistant execute-handoff.yml updated with env vars and instructions
- [ ] Rez-sniper execute-handoff.yml updated with env vars and instructions

## Session Abort Protocol

If at any point execution fails:

1. **Check the error:** File not found (H11/H12 didn't merge), auth failure, API error
2. **Notify:** Provide Spec Reviewer with step, error, and recommended resolution
3. **Revert:** If partial changes committed, reset to origin/main
4. **Document:** Update Notion work item with abort reason

---

**Max Budget:** $6
**Risk Level:** low
**Estimated Execution Time:** 25-35 minutes
