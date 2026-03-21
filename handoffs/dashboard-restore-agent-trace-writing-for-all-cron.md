<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard: Restore Agent Trace Writing for All Cron Agents

## Metadata
- **Branch:** `feat/restore-agent-trace-writing-cron-agents`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `lib/atc/dispatcher.ts`, `lib/atc/health-monitor.ts`, `lib/pm-agent.ts`, `app/api/agents/supervisor/cron/route.ts`, `app/api/agents/feedback-compiler/route.ts`, `lib/agent-traces.ts` (new)

## Context

**PRD-53 AC-8**: The Agents dashboard page reads agent traces from Vercel Blob at `af-data/agent-traces/{agent-name}/{timestamp}.json`. Currently, all four cron agents (Dispatcher, Health Monitor, Project Manager, Supervisor) have traces frozen at March 18, meaning their last-run timestamps on the dashboard are stale.

The Supervisor coordinator is responsible for writing traces, but this trace-writing is either broken, missing, or not called from each agent's cron handler. Additionally, the Feedback Compiler card shows last-run status based on Blob traces that don't exist — it should instead source this from GitHub Actions workflow run history.

**How the Agents dashboard reads traces:**
- Page: `app/(app)/agents/page.tsx`
- API: `app/api/agents/atc-metrics/route.ts` and/or a traces API
- Blob path: `af-data/agent-traces/{agent-name}/{timestamp}.json`
- Agent names expected: `dispatcher`, `health-monitor`, `project-manager`, `supervisor`

**Feedback Compiler** does not run as a Vercel cron — it runs as a GitHub Actions workflow (`.github/workflows/tlm-feedback-compiler.yml`). Its status must come from `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs` via the GitHub API, not Blob traces.

**Concurrent work note:** The concurrent branch `fix/dashboard-settings-page-with-kill-switch-concurren` touches `lib/hooks.ts`. Avoid modifying `lib/hooks.ts` in this handoff; any new data-fetching hooks should go in a separate file or be appended carefully. Do NOT touch `app/(app)/settings/page.tsx`, `components/settings-kill-switch.tsx`, `components/settings-concurrency.tsx`, `components/settings-force-opus.tsx`.

## Requirements

1. Create a shared `lib/agent-traces.ts` utility that writes a trace blob to `af-data/agent-traces/{agentName}/{timestamp}.json` with a consistent schema.
2. Each of the four cron agent handlers must call `writeAgentTrace(...)` at the end of each successful (or completed) run cycle: Dispatcher, Health Monitor, Project Manager, Supervisor.
3. The Feedback Compiler card on the Agents dashboard must show real last-run status sourced from the GitHub Actions workflow run API, not from a nonexistent Blob trace.
4. The existing `app/api/agents/feedback-compiler/route.ts` must return a `lastRun` field populated from the GitHub Actions API (latest run of `tlm-feedback-compiler.yml` in the agent-forge repo).
5. All four non-Feedback-Compiler agents must show current (post-deploy) timestamps on the Agents dashboard after their next cron execution.
6. The trace schema must include at minimum: `agentName`, `timestamp` (ISO 8601), `status` (`success` | `error` | `partial`), `durationMs`, and a `summary` string.
7. TypeScript must compile without errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/restore-agent-trace-writing-cron-agents
```

### Step 1: Audit existing trace-writing code

Before writing anything new, understand what already exists:

```bash
# Search for any existing trace writing
grep -r "agent-traces" --include="*.ts" --include="*.tsx" -l
grep -r "writeAgentTrace\|agent_trace\|agentTrace" --include="*.ts" --include="*.tsx" -l

# Check the feedback compiler API route
cat app/api/agents/feedback-compiler/route.ts

# Check how the agents page reads trace data
cat app/(app)/agents/page.tsx

# Check atc-metrics route for trace reading patterns
cat app/api/agents/atc-metrics/route.ts

# Check existing agent cron handlers
cat app/api/agents/dispatcher/cron/route.ts
cat app/api/agents/health-monitor/cron/route.ts
cat app/api/agents/supervisor/cron/route.ts
cat app/api/pm-agent/route.ts

# Check storage helpers
cat lib/storage.ts
```

Take note of:
- The exact Blob key format used when reading traces in the dashboard
- Whether a trace-reading utility already exists
- The current structure of `feedback-compiler/route.ts`
- How `lib/storage.ts` exposes `put`/`list`/`get` (Vercel Blob)

### Step 2: Create `lib/agent-traces.ts`

Create a shared utility for writing agent traces. This keeps all four cron handlers DRY.

```typescript
// lib/agent-traces.ts
import { put } from "@vercel/blob";

export type AgentTraceStatus = "success" | "error" | "partial";

export interface AgentTrace {
  agentName: string;
  timestamp: string; // ISO 8601
  status: AgentTraceStatus;
  durationMs: number;
  summary: string;
  metadata?: Record<string, unknown>;
}

/**
 * Writes an agent trace to Vercel Blob at:
 *   af-data/agent-traces/{agentName}/{timestamp}.json
 *
 * The Agents dashboard reads from this path to determine last-run status.
 */
export async function writeAgentTrace(trace: AgentTrace): Promise<void> {
  const key = `af-data/agent-traces/${trace.agentName}/${trace.timestamp}.json`;
  await put(key, JSON.stringify(trace), {
    access: "public",
    contentType: "application/json",
    // Overwrite if same timestamp (idempotent on retry)
    addRandomSuffix: false,
  });
}
```

> **Note:** Check `lib/storage.ts` — if it wraps `@vercel/blob` with a custom `blobPut` function, use that instead of importing `put` directly, to stay consistent with existing patterns.

### Step 3: Instrument the Dispatcher cron handler

Open `app/api/agents/dispatcher/cron/route.ts`. Locate where the dispatcher cycle completes (after the main `runDispatcher()` or equivalent call). Add trace writing:

```typescript
import { writeAgentTrace } from "@/lib/agent-traces";

// Inside the POST/GET handler, wrap the existing logic:
const startTime = Date.now();
let status: "success" | "error" | "partial" = "success";
let summary = "";

try {
  // ... existing dispatcher logic ...
  summary = `Dispatched cycle complete`; // adapt to actual result
} catch (err) {
  status = "error";
  summary = err instanceof Error ? err.message : String(err);
  throw err; // re-throw so Vercel cron sees the failure
} finally {
  await writeAgentTrace({
    agentName: "dispatcher",
    timestamp: new Date().toISOString(),
    status,
    durationMs: Date.now() - startTime,
    summary,
  }).catch(() => {}); // never let trace writing crash the agent
}
```

**Important:** Match the `agentName` string exactly to what the dashboard reads. Audit `app/(app)/agents/page.tsx` or `app/api/agents/atc-metrics/route.ts` for the exact name used (likely `"dispatcher"`).

### Step 4: Instrument the Health Monitor cron handler

Open `app/api/agents/health-monitor/cron/route.ts`. Apply the same pattern:

```typescript
import { writeAgentTrace } from "@/lib/agent-traces";

const startTime = Date.now();
let status: "success" | "error" | "partial" = "success";
let summary = "";

try {
  // ... existing health monitor logic ...
  summary = `Health monitor cycle complete`;
} catch (err) {
  status = "error";
  summary = err instanceof Error ? err.message : String(err);
  throw err;
} finally {
  await writeAgentTrace({
    agentName: "health-monitor",
    timestamp: new Date().toISOString(),
    status,
    durationMs: Date.now() - startTime,
    summary,
  }).catch(() => {});
}
```

### Step 5: Instrument the Project Manager handler

Open `app/api/pm-agent/route.ts` (or wherever the PM agent's scheduled/cron execution lives — check if there's a separate cron route at `app/api/agents/project-manager/cron/route.ts`). Apply the same pattern:

```typescript
import { writeAgentTrace } from "@/lib/agent-traces";

// agentName must match what the dashboard expects — likely "project-manager"
await writeAgentTrace({
  agentName: "project-manager",
  timestamp: new Date().toISOString(),
  status,
  durationMs: Date.now() - startTime,
  summary,
}).catch(() => {});
```

### Step 6: Instrument the Supervisor cron handler

Open `app/api/agents/supervisor/cron/route.ts`. This is the most complex agent. Locate the end of the main execution body and add trace writing:

```typescript
import { writeAgentTrace } from "@/lib/agent-traces";

await writeAgentTrace({
  agentName: "supervisor",
  timestamp: new Date().toISOString(),
  status,
  durationMs: Date.now() - startTime,
  summary,
}).catch(() => {});
```

### Step 7: Fix the Feedback Compiler API route

Open `app/api/agents/feedback-compiler/route.ts`. Currently it likely reads from a Blob path that doesn't exist. Replace the last-run logic with a GitHub Actions API call:

```typescript
// app/api/agents/feedback-compiler/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth"; // or however auth is imported in this repo

const GITHUB_REPO = "jamesstineheath/agent-forge";
const WORKFLOW_FILE = "tlm-feedback-compiler.yml";

export async function GET() {
  // Auth check — follow existing pattern in the file
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const ghPat = process.env.GH_PAT;
    if (!ghPat) {
      return NextResponse.json({ error: "GH_PAT not configured" }, { status: 500 });
    }

    // Fetch the latest run of the feedback compiler workflow
    const runsUrl = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`;
    const res = await fetch(runsUrl, {
      headers: {
        Authorization: `Bearer ${ghPat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `GitHub API error: ${res.status}` },
        { status: 502 }
      );
    }

    const data = await res.json();
    const latestRun = data.workflow_runs?.[0] ?? null;

    return NextResponse.json({
      lastRun: latestRun
        ? {
            id: latestRun.id,
            status: latestRun.status,        // "completed" | "in_progress" | "queued"
            conclusion: latestRun.conclusion, // "success" | "failure" | "skipped" | null
            createdAt: latestRun.created_at,
            updatedAt: latestRun.updated_at,
            htmlUrl: latestRun.html_url,
          }
        : null,
      source: "github-actions",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
```

> **Note:** Audit the existing `feedback-compiler/route.ts` thoroughly before replacing. If it already has other fields/logic (e.g. returning compiler history from `docs/feedback-compiler-history.json`), preserve those and only change/add the `lastRun` sourcing.

### Step 8: Verify agent name strings match the dashboard

```bash
# Find exact agent name strings used in the dashboard reads
grep -r "agent-traces\|agentName\|dispatcher\|health-monitor\|project-manager\|supervisor" \
  app/(app)/agents/page.tsx \
  app/api/agents/atc-metrics/route.ts \
  --include="*.ts" --include="*.tsx" 2>/dev/null | head -40
```

If the dashboard uses different name strings (e.g. `"health_monitor"` with underscore vs `"health-monitor"` with hyphen), update `lib/agent-traces.ts` calls accordingly. Consistency is critical.

### Step 9: Verify no overlap with concurrent work

```bash
git diff --name-only
# Must NOT include:
#   app/(app)/settings/page.tsx
#   components/settings-kill-switch.tsx
#   components/settings-concurrency.tsx
#   components/settings-force-opus.tsx
#   lib/hooks.ts
```

If `lib/hooks.ts` needs a new hook for the Feedback Compiler `lastRun` data, add it to `lib/feedback-compiler-hooks.ts` instead, or defer the hook addition and ensure the dashboard page imports directly or uses existing SWR patterns without touching `lib/hooks.ts`.

### Step 10: TypeScript verification and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors. Common issues:
- `put` import from `@vercel/blob` — check if the project uses `@vercel/blob` directly or a wrapper in `lib/storage.ts`
- Auth import path — check existing API routes for the correct import
- Missing `NEXT_PUBLIC_` prefix issues (none expected here, all server-side)

### Step 11: Commit, push, open PR

```bash
git add -A
git commit -m "fix: restore agent trace writing for all cron agents (PRD-53 AC-8)

- Add lib/agent-traces.ts shared utility for writing traces to Blob
- Instrument Dispatcher, Health Monitor, Project Manager, Supervisor cron
  handlers to write af-data/agent-traces/{name}/{timestamp}.json on each run
- Fix Feedback Compiler API route to source last-run status from GitHub
  Actions workflow runs instead of nonexistent Blob traces
- Agents dashboard will show current timestamps after next cron execution"

git push origin feat/restore-agent-trace-writing-cron-agents

gh pr create \
  --title "fix: restore agent trace writing for all cron agents (PRD-53 AC-8)" \
  --body "## Summary

Fixes PRD-53 AC-8: agent trace timestamps were frozen at March 18 on the Agents dashboard.

## Changes

### New: \`lib/agent-traces.ts\`
Shared utility that writes \`AgentTrace\` blobs to \`af-data/agent-traces/{agentName}/{timestamp}.json\`. Follows the path format the Agents dashboard already reads.

### Instrumented cron handlers
- \`app/api/agents/dispatcher/cron/route.ts\` — writes trace on each cycle
- \`app/api/agents/health-monitor/cron/route.ts\` — writes trace on each cycle
- PM agent cron handler — writes trace on each cycle
- \`app/api/agents/supervisor/cron/route.ts\` — writes trace on each cycle

Trace writing is fire-and-forget (\`.catch(() => {})\`) so a Blob failure never crashes the agent.

### Fixed: \`app/api/agents/feedback-compiler/route.ts\`
Now sources \`lastRun\` from GitHub Actions workflow runs API for \`tlm-feedback-compiler.yml\`. The Feedback Compiler runs as a GitHub Actions cron, not a Vercel cron, so Blob traces would never exist for it.

## Testing
- TypeScript compiles cleanly
- After deploy, trigger each cron agent manually via the dashboard trigger buttons; verify timestamps update on the Agents page
- Feedback Compiler card should show the real last GitHub Actions run status

## Concurrent work coordination
Does not touch \`lib/hooks.ts\`, \`app/(app)/settings/page.tsx\`, or any settings components (concurrent branch \`fix/dashboard-settings-page-with-kill-switch-concurren\`).
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/restore-agent-trace-writing-cron-agents
FILES CHANGED: [list what was modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [e.g. "PM agent cron handler not found at expected path — needs manual location"]
```

## Escalation Protocol

If you cannot locate the cron handler for Project Manager (the route may be at `app/api/pm-agent/route.ts` or `app/api/agents/project-manager/cron/route.ts` — check both), or if the dashboard agent name strings don't match any obvious pattern, escalate before guessing:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-53-ac-8-restore-agent-traces",
    "reason": "Cannot locate Project Manager cron handler or agent name strings are ambiguous in dashboard code",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "Step 5",
      "error": "PM agent cron path unclear; dashboard agent name format unclear",
      "filesChanged": ["lib/agent-traces.ts", "app/api/agents/dispatcher/cron/route.ts", "app/api/agents/health-monitor/cron/route.ts"]
    }
  }'
```