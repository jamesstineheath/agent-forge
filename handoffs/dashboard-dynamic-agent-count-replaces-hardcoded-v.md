<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard: Dynamic Agent Count Replaces Hardcoded Values

## Metadata
- **Branch:** `feat/dashboard-dynamic-agent-count`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/(app)/agents/page.tsx`, `app/api/agents/count/route.ts`, `lib/hooks.ts`

## Context

The Agents page dashboard currently uses hardcoded or formula-based values for:
1. The header badge showing total agent count
2. PA Agents section showing static/fabricated status
3. Feedback Compiler status (reads from nonexistent Blob traces rather than GitHub Actions workflow runs)

This is PRD-53 Dashboard UI Alignment, AC-3. The fix should derive agent counts from real data:
- **Cron agents** (Dispatcher, Health Monitor, Project Manager, Supervisor): count + status from the existing health API (`/api/agents/atc-metrics` or individual agent status endpoints)
- **TLM agents**: count + status from GitHub Actions workflow status API
- **PA Agents section**: either source real status from the PA MCP endpoint or hide/collapse behind a toggle
- **Feedback Compiler**: status from GitHub Actions workflow runs (`.github/workflows/tlm-feedback-compiler.yml` runs)

**⚠️ Concurrent Work Warning:** The branch `fix/dashboard-supervisor-phase-execution-log-on-agents` is actively modifying `app/(app)/agents/page.tsx` and `components/agent-dashboard.tsx`. **Do NOT modify `components/agent-dashboard.tsx`**. Minimize changes to `app/(app)/agents/page.tsx` — if the concurrent branch has merged, rebase first. If it hasn't merged, scope changes to a new dedicated component and a new API route to avoid merge conflicts.

The safest approach: create a **new API route** (`/api/agents/count`) that returns live counts, and a **new React component** (`components/agent-count-badge.tsx`) that the agents page can import. Keep the diff in `app/(app)/agents/page.tsx` minimal (swap one badge import/usage).

## Requirements

1. A new API route `GET /api/agents/count` returns a JSON object with:
   - `cronAgents`: count of enabled cron agents (should be 4: Dispatcher, Health Monitor, Project Manager, Supervisor)
   - `tlmAgents`: count of TLM agents detected from registered repos' workflow runs (Spec Review, Code Review, Outcome Tracker, Feedback Compiler, Trace Reviewer, QA Agent = 6 per repo, or the count from repo config)
   - `total`: sum of the above
   - `paAgentsAvailable`: boolean — whether PA MCP endpoint is reachable (defaults to `false` if unavailable)
   - `feedbackCompilerLastRun`: ISO timestamp of the last successful `tlm-feedback-compiler` workflow run, or `null`
2. The Agents page header badge uses this live count instead of any hardcoded number or formula.
3. The Feedback Compiler card/status on the Agents page sources its "last run" from GitHub Actions (the new API route or a dedicated fetch), not from Blob traces.
4. The PA Agents section is either:
   - Collapsed behind a "Show PA Agents (data unavailable)" toggle when `paAgentsAvailable === false`, OR
   - Removed entirely if no PA MCP integration exists in the codebase
5. No hardcoded status arrays remain for agent counts or Feedback Compiler status.
6. TypeScript compiles with no errors (`npx tsc --noEmit`).
7. The existing `npm run build` passes.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-dynamic-agent-count
```

### Step 1: Audit current Agents page for hardcoded values

Read the current state of the agents page and related files to understand what needs changing:

```bash
cat app/\(app\)/agents/page.tsx
cat components/agent-dashboard.tsx 2>/dev/null || echo "FILE NOT FOUND"
cat lib/hooks.ts | grep -A 20 "agent\|Agent\|count\|Count"
cat app/api/agents/atc-metrics/route.ts 2>/dev/null || echo "FILE NOT FOUND"
cat app/api/agents/feedback-compiler/route.ts 2>/dev/null || echo "FILE NOT FOUND"
```

Look specifically for:
- Any literal numbers like `4`, `6`, `10` used as agent counts
- Static arrays like `['Dispatcher', 'Health Monitor', ...]` used for rendering
- References to PA agents or feedback compiler with hardcoded status strings
- How the header badge is currently rendered (look for `Badge`, `pill`, count expressions)

### Step 2: Create the `/api/agents/count` route

Create `app/api/agents/count/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getRegisteredRepos } from '@/lib/repos';
import { github } from '@/lib/github';

// The 4 autonomous cron agents defined in ADR-010
const CRON_AGENTS = [
  'Dispatcher',
  'Health Monitor',
  'Project Manager',
  'Supervisor',
] as const;

// TLM workflow file names present in each data-plane repo
const TLM_WORKFLOW_FILES = [
  'tlm-review.yml',
  'tlm-spec-review.yml',
  'tlm-outcome-tracker.yml',
  'tlm-feedback-compiler.yml',
  'tlm-trace-reviewer.yml',
] as const;

export async function GET() {
  try {
    // Cron agents are always 4 (fixed by ADR-010 architecture)
    const cronAgentCount = CRON_AGENTS.length;

    // Detect TLM agents by checking registered repos for workflow files
    let tlmAgentCount = 0;
    let feedbackCompilerLastRun: string | null = null;

    try {
      const repos = await getRegisteredRepos();
      // Count distinct TLM workflow types across all registered repos
      // (each repo contributes up to TLM_WORKFLOW_FILES.length agents)
      const repoCount = repos.length;
      tlmAgentCount = repoCount * TLM_WORKFLOW_FILES.length;

      // Fetch last Feedback Compiler run from GitHub Actions
      // Use the first registered repo that has the workflow, or fall back to self
      const targetRepo = repos[0]; // primary target repo
      if (targetRepo) {
        try {
          const [owner, repo] = targetRepo.fullName.split('/');
          const runs = await github.listWorkflowRuns(
            owner,
            repo,
            'tlm-feedback-compiler.yml',
            { perPage: 1, status: 'completed' }
          );
          if (runs && runs.length > 0 && runs[0].conclusion === 'success') {
            feedbackCompilerLastRun = runs[0].updated_at ?? runs[0].created_at ?? null;
          }
        } catch {
          // Workflow may not exist yet — leave as null
        }
      }
    } catch {
      // Repo registry unavailable — TLM count stays 0
    }

    // PA agents: check if PA MCP endpoint env var is configured
    const paAgentsAvailable = !!(
      process.env.PA_MCP_ENDPOINT || process.env.PA_AGENT_URL
    );

    return NextResponse.json({
      cronAgents: cronAgentCount,
      tlmAgents: tlmAgentCount,
      total: cronAgentCount + tlmAgentCount,
      paAgentsAvailable,
      feedbackCompilerLastRun,
      cronAgentNames: CRON_AGENTS,
    });
  } catch (error) {
    console.error('[agents/count] Error fetching agent count:', error);
    return NextResponse.json(
      { error: 'Failed to fetch agent count' },
      { status: 500 }
    );
  }
}
```

**Important**: After writing this file, check the actual signatures of `getRegisteredRepos()` in `lib/repos.ts` and `github` in `lib/github.ts` to ensure you're calling them correctly. Adjust field names (e.g., `fullName` vs `full_name`) to match the actual types.

```bash
cat lib/repos.ts | head -80
cat lib/github.ts | grep -A 10 "listWorkflowRuns\|WorkflowRun"
```

If `listWorkflowRuns` doesn't exist on the github client, use the GitHub REST API directly or the Octokit client. Check how other routes call GitHub (e.g., `app/api/agents/health-monitor/cron/route.ts`):

```bash
grep -r "listWorkflowRuns\|actions.listWorkflowRuns\|octokit" app/api/ lib/ --include="*.ts" -l
```

Adapt the GitHub API call to the existing pattern in the codebase.

### Step 3: Create the `AgentCountBadge` component

Create `components/agent-count-badge.tsx`:

```typescript
'use client';

import useSWR from 'swr';

interface AgentCountData {
  cronAgents: number;
  tlmAgents: number;
  total: number;
  paAgentsAvailable: boolean;
  feedbackCompilerLastRun: string | null;
  cronAgentNames: string[];
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface AgentCountBadgeProps {
  className?: string;
}

export function AgentCountBadge({ className }: AgentCountBadgeProps) {
  const { data, isLoading } = useSWR<AgentCountData>(
    '/api/agents/count',
    fetcher,
    { refreshInterval: 60_000 } // refresh every 60s
  );

  if (isLoading || !data) {
    return (
      <span className={`inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 ${className ?? ''}`}>
        —
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 ${className ?? ''}`}
      title={`${data.cronAgents} cron agents + ${data.tlmAgents} TLM agents`}
    >
      {data.total} agents
    </span>
  );
}

export function useFeedbackCompilerStatus() {
  const { data } = useSWR<AgentCountData>(
    '/api/agents/count',
    fetcher,
    { refreshInterval: 300_000 } // 5 min for feedback compiler
  );
  return {
    lastRun: data?.feedbackCompilerLastRun ?? null,
    isLoading: !data,
  };
}

export function usePAAgentsAvailable() {
  const { data } = useSWR<AgentCountData>(
    '/api/agents/count',
    fetcher,
    { revalidateOnFocus: false }
  );
  return data?.paAgentsAvailable ?? false;
}
```

### Step 4: Update the Agents page — minimal, targeted changes only

Read the current agents page carefully:

```bash
cat app/\(app\)/agents/page.tsx
```

Make **only** the following surgical changes to `app/(app)/agents/page.tsx`:

1. **Header badge**: Find where the agent count badge/number is rendered. Replace the hardcoded count/formula with `<AgentCountBadge />`. Import it from `@/components/agent-count-badge`.

2. **Feedback Compiler status**: Find references to Blob-based trace reads for Feedback Compiler. Replace with the `useFeedbackCompilerStatus()` hook. If Feedback Compiler status is rendered server-side, convert that section to a small client component that uses the hook, or pass the data from the new API route.

3. **PA Agents section**: Find the PA Agents section. Check if there's a real PA MCP integration (`PA_MCP_ENDPOINT` or similar):
   ```bash
   grep -r "PA\|pa_agent\|pa-agent\|mcp" app/ lib/ --include="*.ts" -i | grep -v node_modules | head -20
   ```
   - If no real integration exists: wrap the PA Agents section in a collapsible `<details>` or a conditional that hides it by default with a label "PA Agents (status unavailable)".
   - If a real integration exists: wire it up to `usePAAgentsAvailable()`.

**Do NOT touch** the overall page structure, the supervisor phase log section, or anything related to `components/agent-dashboard.tsx` to avoid conflicts with the concurrent branch.

Example minimal diff pattern for the badge (adjust to match actual code):
```tsx
// Before (example):
<span className="badge">{4 + tlmAgentCount} agents</span>

// After:
import { AgentCountBadge } from '@/components/agent-count-badge';
// ...
<AgentCountBadge />
```

### Step 5: Add SWR hook to `lib/hooks.ts` (optional)

If the project convention is to put all SWR hooks in `lib/hooks.ts`, add `useAgentCount` there instead of in the component file:

```bash
# Check existing pattern
grep -n "export function use" lib/hooks.ts | head -20
```

If hooks are defined in `lib/hooks.ts`, move the hook there and import from `lib/hooks` in the component. If hooks are co-located with components, leave them in `components/agent-count-badge.tsx`.

### Step 6: Handle auth on the new route

Check if other `/api/agents/*` routes require authentication:

```bash
head -30 app/api/agents/atc-metrics/route.ts
head -30 app/api/agents/feedback-compiler/route.ts
```

If they use session auth or `CRON_SECRET` / `AGENT_FORGE_API_SECRET` checks, apply the same pattern to `app/api/agents/count/route.ts`. The dashboard calls this from the browser, so it should use session auth (same as other dashboard-facing routes).

### Step 7: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build

# Verify new route exists and TypeScript is clean
grep -r "hardcoded\|// TODO.*count\|= 4.*agent\|= 6.*agent" app/\(app\)/agents/page.tsx || echo "No hardcoded counts found — good"

# Check no references to nonexistent blob traces for feedback compiler
grep -r "feedbackCompiler.*blob\|blob.*feedbackCompiler\|tlm-feedback-compiler.*traces" app/ lib/ --include="*.ts" | grep -v "node_modules" || echo "No stale blob references — good"
```

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: dynamic agent count badge and live feedback compiler status

- Add /api/agents/count route: derives cron agent count (4, per ADR-010),
  TLM agent count from registered repos, feedbackCompilerLastRun from
  GitHub Actions workflow runs
- Add AgentCountBadge component with 60s SWR refresh
- Replace hardcoded agent count badge on Agents page with AgentCountBadge
- Replace nonexistent Blob trace reads for Feedback Compiler with GH Actions
- Collapse PA Agents section behind toggle when PA MCP unavailable
- No hardcoded status arrays remain

Part of PRD-53 Dashboard UI Alignment, AC-3"

git push origin feat/dashboard-dynamic-agent-count

gh pr create \
  --title "feat: Dashboard dynamic agent count replaces hardcoded values (PRD-53 AC-3)" \
  --body "## Summary

Replaces hardcoded agent counts and fabricated status values on the Agents dashboard page with live data.

## Changes

- **New route** \`/api/agents/count\`: returns \`cronAgents\` (always 4 per ADR-010), \`tlmAgents\` (from registered repo count × TLM workflow count), \`feedbackCompilerLastRun\` (from GitHub Actions), \`paAgentsAvailable\` (env var check)
- **New component** \`components/agent-count-badge.tsx\`: SWR-backed badge with 60s refresh, \`useFeedbackCompilerStatus\` hook, \`usePAAgentsAvailable\` hook
- **Agents page**: surgical swap of hardcoded badge → \`<AgentCountBadge />\`, Feedback Compiler status wired to GH Actions, PA Agents section collapsed when data unavailable

## Avoided files (concurrent branch conflict prevention)
- \`components/agent-dashboard.tsx\` — not modified
- Minimal changes to \`app/(app)/agents/page.tsx\` (badge swap + PA section only)

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Badge shows live count with tooltip showing cron vs TLM breakdown

Closes PRD-53 AC-3"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-dynamic-agent-count
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "PA section still uses hardcoded data", "feedbackCompilerLastRun wiring incomplete"]
```

## Escalation Protocol

If blocked on ambiguous requirements (e.g., unclear whether PA MCP integration exists, unclear GitHub API client interface), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-53-ac3-dynamic-agent-count",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/agents/count/route.ts", "components/agent-count-badge.tsx", "app/(app)/agents/page.tsx"]
    }
  }'
```