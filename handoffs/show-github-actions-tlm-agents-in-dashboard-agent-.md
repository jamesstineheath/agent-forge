<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Show GitHub Actions TLM Agents in Dashboard Agent Heartbeat

## Metadata
- **Branch:** `feat/tlm-agents-dashboard`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/agents/page.tsx, app/api/agents/tlm-agents/route.ts, components/tlm-agent-heartbeat.tsx, lib/github.ts

## Context

The Agent Heartbeat section on the Agents dashboard tab (`app/(app)/agents/page.tsx`) displays health metrics for the 4 Vercel cron-based autonomous agents (Dispatcher, Health Monitor, PM Agent, Supervisor). However, the 6 GitHub Actions-based TLM agents are completely invisible in the dashboard:

- **TLM Code Reviewer** — `.github/workflows/tlm-review.yml`
- **TLM Spec Reviewer** — `.github/workflows/tlm-spec-review.yml`
- **TLM Outcome Tracker** — `.github/workflows/tlm-outcome-tracker.yml`
- **TLM Feedback Compiler** — `.github/workflows/tlm-feedback-compiler.yml`
- **TLM Trace Reviewer** — `.github/workflows/tlm-trace-reviewer.yml`
- **TLM QA Agent** — `.github/workflows/tlm-qa-agent.yml`

The GitHub API helper `lib/github.ts` already has workflow run functionality. We need to inspect what's available (likely `getWorkflowRuns` or similar) and build:
1. An API route (`/api/agents/tlm-agents`) that queries recent GitHub Actions runs for each TLM workflow
2. A new React component (`components/tlm-agent-heartbeat.tsx`) to display last run time, conclusion, run count, and success rate
3. Integration into the existing Agents page

The existing hooks pattern uses SWR (`lib/hooks.ts`) for data fetching. Follow the same patterns used by the existing ATC metrics and agent health displays.

## Requirements

1. Create an API route `GET /api/agents/tlm-agents` that:
   - Is protected by session auth (same pattern as other agent API routes)
   - Queries the last 10 runs for each of the 6 TLM workflows in the agent-forge repo (`jamesstineheath/agent-forge`)
   - Returns per-workflow: `name`, `workflowFile`, `lastRunAt` (ISO string or null), `lastConclusion` (success/failure/skipped/cancelled/null), `totalRuns`, `successRate` (0–1 float)
   - Handles GitHub API errors gracefully (returns empty/null data for a workflow if it fails, does not crash the whole route)

2. Create a React component `components/tlm-agent-heartbeat.tsx` that:
   - Accepts the API response data as props or fetches via SWR hook
   - Displays a "TLM Agents (GitHub Actions)" section with a table/card grid showing each workflow's: display name, last run time (relative, e.g. "2h ago"), conclusion badge (color-coded: green=success, red=failure, yellow=skipped/cancelled, gray=never run), run count, and success rate (as a percentage)
   - Shows a loading skeleton while fetching
   - Shows an error state if the API fails

3. Add a SWR hook `useTlmAgents()` in `lib/hooks.ts` following the existing hook patterns

4. Integrate the new component into `app/(app)/agents/page.tsx` — add a "TLM Agents" section below the existing Agent Heartbeat section

5. The implementation must compile with `npx tsc --noEmit` and not break existing functionality

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/tlm-agents-dashboard
```

### Step 1: Inspect existing GitHub API helpers
```bash
cat lib/github.ts | grep -n "workflow\|Workflow\|run\|Run" | head -40
cat lib/hooks.ts | head -80
cat app/(app)/agents/page.tsx
cat app/api/agents/atc-metrics/route.ts
```

Understand what GitHub workflow run functions already exist (likely `getWorkflowRuns(owner, repo, workflowId)`), the auth patterns used in API routes, and the SWR hook patterns in `lib/hooks.ts`.

### Step 2: Add `getWorkflowRuns` to `lib/github.ts` if missing

Check if a function to fetch workflow runs already exists. If not, add one. If it exists but needs adjustment, extend it. The function signature should be:

```typescript
export async function getWorkflowRuns(
  owner: string,
  repo: string,
  workflowFile: string,
  perPage = 10
): Promise<Array<{
  id: number;
  created_at: string;
  conclusion: string | null;
  status: string;
}>>
```

Implementation using the GitHub REST API:
```typescript
export async function getWorkflowRuns(
  owner: string,
  repo: string,
  workflowFile: string,
  perPage = 10
) {
  const octokit = getOctokit(); // use existing octokit init pattern
  const response = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: workflowFile,
    per_page: perPage,
  });
  return response.data.workflow_runs.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    conclusion: r.conclusion,
    status: r.status,
  }));
}
```

Check the existing `lib/github.ts` for how octokit is initialized (look for `new Octokit`, `getOctokit`, or `octokit` instantiation patterns) and match that exactly.

### Step 3: Create the API route `app/api/agents/tlm-agents/route.ts`

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getWorkflowRuns } from "@/lib/github";

const REPO_OWNER = "jamesstineheath";
const REPO_NAME = "agent-forge";

const TLM_WORKFLOWS = [
  { name: "TLM Code Reviewer", file: "tlm-review.yml" },
  { name: "TLM Spec Reviewer", file: "tlm-spec-review.yml" },
  { name: "TLM Outcome Tracker", file: "tlm-outcome-tracker.yml" },
  { name: "TLM Feedback Compiler", file: "tlm-feedback-compiler.yml" },
  { name: "TLM Trace Reviewer", file: "tlm-trace-reviewer.yml" },
  { name: "TLM QA Agent", file: "tlm-qa-agent.yml" },
];

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await Promise.all(
    TLM_WORKFLOWS.map(async (workflow) => {
      try {
        const runs = await getWorkflowRuns(
          REPO_OWNER,
          REPO_NAME,
          workflow.file,
          10
        );
        const completedRuns = runs.filter((r) => r.conclusion !== null);
        const successCount = completedRuns.filter(
          (r) => r.conclusion === "success"
        ).length;
        const lastRun = runs[0] ?? null;
        return {
          name: workflow.name,
          workflowFile: workflow.file,
          lastRunAt: lastRun?.created_at ?? null,
          lastConclusion: lastRun?.conclusion ?? null,
          totalRuns: runs.length,
          successRate:
            completedRuns.length > 0
              ? successCount / completedRuns.length
              : null,
        };
      } catch (err) {
        console.error(`Failed to fetch runs for ${workflow.file}:`, err);
        return {
          name: workflow.name,
          workflowFile: workflow.file,
          lastRunAt: null,
          lastConclusion: null,
          totalRuns: 0,
          successRate: null,
        };
      }
    })
  );

  return NextResponse.json({ workflows: results, fetchedAt: new Date().toISOString() });
}
```

### Step 4: Add `useTlmAgents` hook to `lib/hooks.ts`

Open `lib/hooks.ts` and append a new hook following the exact same pattern as the existing hooks (likely using `useSWR`):

```typescript
export interface TlmWorkflowStatus {
  name: string;
  workflowFile: string;
  lastRunAt: string | null;
  lastConclusion: string | null;
  totalRuns: number;
  successRate: number | null;
}

export interface TlmAgentsData {
  workflows: TlmWorkflowStatus[];
  fetchedAt: string;
}

export function useTlmAgents() {
  const { data, error, isLoading } = useSWR<TlmAgentsData>(
    "/api/agents/tlm-agents",
    fetcher,
    { refreshInterval: 60000 } // refresh every 60 seconds
  );
  return { data, error, isLoading };
}
```

Make sure `fetcher` is the same fetcher function used by other hooks in the file (don't redefine it).

### Step 5: Create component `components/tlm-agent-heartbeat.tsx`

```typescript
"use client";

import { useTlmAgents, TlmWorkflowStatus } from "@/lib/hooks";
import { formatDistanceToNow } from "date-fns";

function ConclusionBadge({ conclusion }: { conclusion: string | null }) {
  if (!conclusion) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
        Never run
      </span>
    );
  }
  const styles: Record<string, string> = {
    success: "bg-green-100 text-green-800",
    failure: "bg-red-100 text-red-800",
    skipped: "bg-yellow-100 text-yellow-800",
    cancelled: "bg-yellow-100 text-yellow-800",
  };
  const style = styles[conclusion] ?? "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style}`}>
      {conclusion}
    </span>
  );
}

function WorkflowRow({ workflow }: { workflow: TlmWorkflowStatus }) {
  const lastRunAgo = workflow.lastRunAt
    ? formatDistanceToNow(new Date(workflow.lastRunAt), { addSuffix: true })
    : "—";
  const successPct =
    workflow.successRate !== null
      ? `${Math.round(workflow.successRate * 100)}%`
      : "—";
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="py-2 pr-4 text-sm font-medium text-gray-900 whitespace-nowrap">
        {workflow.name}
      </td>
      <td className="py-2 pr-4">
        <ConclusionBadge conclusion={workflow.lastConclusion} />
      </td>
      <td className="py-2 pr-4 text-sm text-gray-500 whitespace-nowrap">
        {lastRunAgo}
      </td>
      <td className="py-2 pr-4 text-sm text-gray-500 text-right">
        {workflow.totalRuns}
      </td>
      <td className="py-2 text-sm text-gray-500 text-right">{successPct}</td>
    </tr>
  );
}

export function TlmAgentHeartbeat() {
  const { data, error, isLoading } = useTlmAgents();

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-8 bg-gray-100 rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-red-600">
        Failed to load TLM agent status. Check GitHub API connectivity.
      </p>
    );
  }

  if (!data || data.workflows.length === 0) {
    return <p className="text-sm text-gray-500">No workflow data available.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-gray-200">
            <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Agent
            </th>
            <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Last Result
            </th>
            <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Last Run
            </th>
            <th className="pb-2 pr-4 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">
              Runs
            </th>
            <th className="pb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">
              Success Rate
            </th>
          </tr>
        </thead>
        <tbody>
          {data.workflows.map((wf) => (
            <WorkflowRow key={wf.workflowFile} workflow={wf} />
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-gray-400">
        Last fetched: {formatDistanceToNow(new Date(data.fetchedAt), { addSuffix: true })}
      </p>
    </div>
  );
}
```

**Note:** Check whether `date-fns` is already a dependency with `cat package.json | grep date-fns`. If not present, use a simpler relative time helper:

```typescript
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
```

And replace `formatDistanceToNow(new Date(workflow.lastRunAt), { addSuffix: true })` with `relativeTime(workflow.lastRunAt)` throughout.

### Step 6: Integrate into `app/(app)/agents/page.tsx`

Open the agents page and add the TLM section. Inspect the current structure first:
```bash
cat app/(app)/agents/page.tsx
```

Find where the existing agent heartbeat section ends (look for the closing of the last agent card/section). Add the TLM Agents section immediately after:

```tsx
import { TlmAgentHeartbeat } from "@/components/tlm-agent-heartbeat";

// ... inside the page component, after the existing agent heartbeat section:

<section className="mt-8">
  <div className="flex items-center justify-between mb-4">
    <h2 className="text-lg font-semibold text-gray-900">
      TLM Agents{" "}
      <span className="text-sm font-normal text-gray-500">(GitHub Actions)</span>
    </h2>
  </div>
  <div className="bg-white rounded-lg border border-gray-200 p-4">
    <TlmAgentHeartbeat />
  </div>
</section>
```

Adapt the className values to match the existing styling patterns on the page (inspect what card/section styles are already in use).

### Step 7: TypeScript check and build verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- The `auth()` import path — check existing API routes for the correct import
- The `getWorkflowRuns` return type — make sure it matches what `lib/github.ts` actually returns
- The `useSWR` import and `fetcher` reference in hooks.ts

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 8: Verification
```bash
npx tsc --noEmit
npm run build
```

Confirm no TypeScript errors or build failures.

### Step 9: Commit, push, open PR
```bash
git add -A
git commit -m "feat: show GitHub Actions TLM agents in dashboard Agent Heartbeat"
git push origin feat/tlm-agents-dashboard
gh pr create \
  --title "feat: show GitHub Actions TLM agents in dashboard Agent Heartbeat" \
  --body "## Summary

Adds a 'TLM Agents (GitHub Actions)' section to the Agents dashboard tab, making the 6 GitHub Actions-based TLM agents visible alongside the existing Vercel cron agents.

## Changes

- **\`app/api/agents/tlm-agents/route.ts\`** — New authenticated API route that queries the last 10 runs for each of 6 TLM workflows via GitHub API, returning last run time, conclusion, run count, and success rate
- **\`lib/hooks.ts\`** — Added \`useTlmAgents()\` SWR hook (60s refresh interval)
- **\`components/tlm-agent-heartbeat.tsx\`** — New component with table view, color-coded conclusion badges, relative timestamps, and loading/error states
- **\`app/(app)/agents/page.tsx\`** — Integrated \`TlmAgentHeartbeat\` component in a new section below existing agent heartbeat
- **\`lib/github.ts\`** — Added/extended \`getWorkflowRuns\` if it wasn't already present

## Workflows tracked
- TLM Code Reviewer (\`tlm-review.yml\`)
- TLM Spec Reviewer (\`tlm-spec-review.yml\`)
- TLM Outcome Tracker (\`tlm-outcome-tracker.yml\`)
- TLM Feedback Compiler (\`tlm-feedback-compiler.yml\`)
- TLM Trace Reviewer (\`tlm-trace-reviewer.yml\`)
- TLM QA Agent (\`tlm-qa-agent.yml\`)

## Risk
Low — additive only, no existing code paths modified except appending to hooks.ts and agents page."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/tlm-agents-dashboard
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you hit a blocker you cannot resolve (e.g. `getWorkflowRuns` doesn't exist and the GitHub API auth pattern is unclear, or the agents page structure differs significantly from expectations):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "tlm-agents-dashboard",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["<list of files modified so far>"]
    }
  }'
```