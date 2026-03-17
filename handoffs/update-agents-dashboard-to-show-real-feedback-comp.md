# Agent Forge -- Update Agents Dashboard to Show Real Feedback Compiler Data

## Metadata
- **Branch:** `feat/feedback-compiler-real-data`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/agents/page.tsx, lib/github.ts (possibly)

## Context

The Agent Forge dashboard has a TLM agents page at `app/(app)/agents/page.tsx` that shows cards for each TLM agent. The Feedback Compiler agent currently shows a placeholder `status="in-pipeline"` card rather than real data.

The Feedback Compiler writes its history to `docs/feedback-compiler-history.json` in the target repo (personal-assistant). The file has a `lastRun` field and stores patterns/proposals per run. The agents page needs to fetch this data and display it using the same card pattern as other TLM agents.

From the system map:
- **Feedback Compiler History** is stored at `docs/feedback-compiler-history.json` (in-repo, in pipeline) — Change effectiveness tracking
- The `lib/github.ts` file is a GitHub API wrapper for branches, pushes, workflow triggers, PR lookups
- `lib/hooks.ts` has React data fetching hooks for dashboard (SWR)
- The page is in the auth-protected `(app)` route group

The page likely uses a server component or SWR hooks to fetch data. Other TLM agent cards (Code Reviewer, Spec Reviewer, Outcome Tracker) should already show real data — the Feedback Compiler card should follow the same pattern.

## Requirements

1. Read the current `app/(app)/agents/page.tsx` to understand the existing card structure, how other agents fetch data, and the props accepted by `TLMAgentCard` (or equivalent component).
2. Add a data fetch for `docs/feedback-compiler-history.json` from the target repo via GitHub API (matching the pattern used for other agent data fetches on the same page).
3. Parse the history JSON to extract:
   - `lastRun` timestamp
   - Count of patterns from the most recent run
   - Count of changes proposed from the most recent run
4. Compute status:
   - `'active'` if `lastRun` is within the last 8 days
   - `'idle'` if `lastRun` exists but is older than 8 days
   - `'error'` if the last Feedback Compiler workflow run failed
   - Fall back to `'idle'` / "No runs yet" if file doesn't exist or fetch fails
5. Replace the `status="in-pipeline"` placeholder card with a real data card showing: agent name, description, last run timestamp, patterns detected count, changes proposed count.
6. The page must compile (`npm run build`) and render without errors.
7. Gracefully handle missing history file (404 from GitHub API) by showing "No runs yet" without throwing.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/feedback-compiler-real-data
```

### Step 1: Read existing code to understand patterns

Read the following files in full before writing any code:

```bash
cat app/(app)/agents/page.tsx
cat lib/github.ts
cat lib/hooks.ts
# Also check if there's a separate component file
find components -name "*.tsx" | xargs grep -l -i "tlm\|agent" 2>/dev/null | head -5
find app -name "*.tsx" | xargs grep -l "in-pipeline\|TLMAgentCard\|AgentCard" 2>/dev/null | head -5
```

Understand:
- How `TLMAgentCard` (or the equivalent component) is called — what props does it accept? (status, lastRun, metrics, description, etc.)
- How other agent cards (Code Reviewer, Spec Reviewer, Outcome Tracker) fetch their real data — do they use a server component fetch, SWR, or an API route?
- What the `status` prop values are (likely `"active" | "idle" | "error" | "in-pipeline"` or similar)
- What metric props are passed (patternsDetected, changesProposed, runsTotal, etc.)

### Step 2: Understand the feedback-compiler-history.json schema

Check if the file schema is defined anywhere:

```bash
grep -r "feedback-compiler-history\|feedbackCompilerHistory\|FeedbackCompiler" lib/ app/ --include="*.ts" --include="*.tsx" | head -20
cat docs/feedback-compiler-history.json 2>/dev/null || echo "File not in this repo (it lives in target repos)"
```

The expected schema based on the system description is:
```json
{
  "lastRun": "2025-01-15T10:00:00Z",
  "runs": [
    {
      "date": "2025-01-15T10:00:00Z",
      "patternsDetected": 3,
      "changesProposed": 2,
      "outcome": "success"
    }
  ]
}
```

If the actual schema differs from what you find in the codebase (e.g., in `lib/plan-cache/types.ts` or similar), use the actual schema.

### Step 3: Implement the data fetch for Feedback Compiler history

**Option A: If the page is a Next.js Server Component** (most likely given App Router usage):

Add a fetch function to `app/(app)/agents/page.tsx` (or a helper module) that reads the history file from the GitHub API. The target repo is the one registered for the pipeline (likely `jamesstineheath/personal-assistant`).

Look at how other agents fetch data. If they use `lib/github.ts`, add a helper like:

```typescript
// In app/(app)/agents/page.tsx or a new lib/feedback-compiler.ts

import { getRepoFile } from '@/lib/github'; // or whatever the actual function is called

interface FeedbackCompilerRun {
  date: string;
  patternsDetected: number;
  changesProposed: number;
  outcome?: string;
}

interface FeedbackCompilerHistory {
  lastRun?: string;
  runs?: FeedbackCompilerRun[];
}

interface FeedbackCompilerData {
  status: 'active' | 'idle' | 'error';
  lastRun: string | null;
  patternsDetected: number;
  changesProposed: number;
}

async function getFeedbackCompilerData(repo: string): Promise<FeedbackCompilerData> {
  try {
    const content = await getRepoFile(repo, 'docs/feedback-compiler-history.json');
    // getRepoFile likely returns base64-decoded content or parsed JSON — check the actual signature
    const history: FeedbackCompilerHistory = typeof content === 'string' 
      ? JSON.parse(content) 
      : content;

    const lastRun = history.lastRun ?? null;
    const runs = history.runs ?? [];
    const mostRecent = runs[runs.length - 1] ?? null;

    let status: 'active' | 'idle' | 'error' = 'idle';
    if (lastRun) {
      const daysSinceRun = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60 * 24);
      status = daysSinceRun <= 8 ? 'active' : 'idle';
    }

    return {
      status,
      lastRun,
      patternsDetected: mostRecent?.patternsDetected ?? 0,
      changesProposed: mostRecent?.changesProposed ?? 0,
    };
  } catch (err: unknown) {
    // 404 = file doesn't exist yet; any error = graceful fallback
    const is404 = err instanceof Error && err.message.includes('404');
    if (!is404) {
      console.error('Failed to fetch feedback compiler history:', err);
    }
    return {
      status: 'idle',
      lastRun: null,
      patternsDetected: 0,
      changesProposed: 0,
    };
  }
}
```

**Option B: If the page uses SWR / client-side fetching**, add an API route and hook following the pattern of existing agent data fetches.

**Match the actual pattern you find in Step 1.** Do not invent a new pattern.

### Step 4: Update the Feedback Compiler card in the page

Replace the placeholder card. The existing placeholder likely looks something like:

```tsx
<TLMAgentCard
  name="Feedback Compiler"
  status="in-pipeline"
  description="..."
/>
```

Replace it with a real data card. The exact props depend on what you found in Step 1, but following the pattern of other cards:

```tsx
// In the server component, after awaiting getFeedbackCompilerData(targetRepo):
<TLMAgentCard
  name="Feedback Compiler"
  description="Weekly self-improvement: analyzes merged PR outcomes, detects failure patterns, and proposes CLAUDE.md / handoff template improvements."
  status={feedbackCompilerData.status}
  lastRun={feedbackCompilerData.lastRun}
  metrics={[
    { label: 'Patterns Detected', value: feedbackCompilerData.patternsDetected },
    { label: 'Changes Proposed', value: feedbackCompilerData.changesProposed },
  ]}
  // Add any other props the card component expects, matching the other agent cards
/>
```

If the card component uses different prop names (e.g., `runCount`, `lastRunAt`, `stats`), use those exact names as found in Step 1.

If `status="in-pipeline"` is a special placeholder value that hides a card entirely, ensure the replacement shows the card with the correct status value when no data is available (`'idle'`).

### Step 5: Handle "No runs yet" display

Ensure the card shows meaningful content when `lastRun` is null:
- The `TLMAgentCard` component likely already handles null/undefined `lastRun` by showing "Never" or "No runs yet" — verify this is the case.
- If it doesn't handle null gracefully, add a null check and pass an appropriate display string.
- Do **not** pass `status="in-pipeline"` as the fallback — use `status="idle"` with null/empty metrics.

### Step 6: Identify the target repo

The agents page needs to know which repo to read the history file from. Check how other agent cards identify their target repo:

```bash
grep -r "personal-assistant\|targetRepo\|repoName\|PIPELINE_REPO" app/(app)/agents/ lib/ --include="*.ts" --include="*.tsx" | head -20
```

Use the same repo reference pattern. The pipeline repo is likely `jamesstineheath/personal-assistant` based on the system map, but confirm from the existing code.

### Step 7: Verification

```bash
# Type check
npx tsc --noEmit

# Build check
npm run build

# Lint
npm run lint 2>/dev/null || true
```

Ensure:
- No TypeScript errors
- Build succeeds
- The `in-pipeline` string no longer appears in the Feedback Compiler card path
- All other agent cards are unaffected

```bash
# Confirm no remaining in-pipeline placeholder for Feedback Compiler
grep -n "in-pipeline" app/(app)/agents/page.tsx
```

If `in-pipeline` still appears for *other* cards that are legitimately in-pipeline (not Feedback Compiler), that's fine — only the Feedback Compiler card should be updated.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: update agents dashboard to show real Feedback Compiler data"
git push origin feat/feedback-compiler-real-data
gh pr create \
  --title "feat: update agents dashboard to show real Feedback Compiler data" \
  --body "## Summary
Updates the TLM agents page to show real data for the Feedback Compiler agent instead of the 'in-pipeline' placeholder.

## Changes
- Added \`getFeedbackCompilerData()\` function to fetch and parse \`docs/feedback-compiler-history.json\` from the target pipeline repo via GitHub API
- Replaced the Feedback Compiler \`status=\"in-pipeline\"\` placeholder card with a real data card
- Shows: last run timestamp, patterns detected count, changes proposed count
- Status: 'active' if last run within 8 days, 'idle' otherwise
- Gracefully falls back to 'No runs yet' / idle state if history file doesn't exist or fetch fails

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Card no longer shows 'in-pipeline' placeholder
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/feedback-compiler-real-data
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you hit a blocker you cannot resolve (e.g., the `TLMAgentCard` component doesn't accept a `status` prop and the card rendering logic is unclear, or the GitHub API helper doesn't have a file-reading function and adding one would be a large scope expansion):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "update-agents-dashboard-feedback-compiler",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/(app)/agents/page.tsx"]
    }
  }'
```