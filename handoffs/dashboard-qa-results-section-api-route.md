# Agent Forge -- Dashboard QA Results Section — API Route

## Metadata
- **Branch:** `feat/qa-results-api-route`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/qa-results/route.ts

## Context

Agent Forge is the control plane for a multi-repo autonomous dev orchestration platform. The system includes a TLM QA Agent that runs post-deploy verification across target repos and records outcomes in `docs/tlm-action-ledger.json` files. Each entry in the ledger has an `agentType` field (e.g., `'qa-agent'`).

This task adds a new API route at `/api/qa-results` that aggregates QA metrics from:
1. The local `docs/tlm-action-ledger.json` in the agent-forge repo itself
2. Remote `docs/tlm-action-ledger.json` files from target repos (`personal-assistant` and `rez-sniper`) fetched via GitHub API using `GH_PAT`

The route will be consumed by the dashboard to show QA health, graduation status, and per-repo breakdowns. This is a read-only, new-file-only task with no risk of conflicting with concurrent work (the concurrent branch only touches `handoffs/` and ephemeral scripts).

The existing auth pattern in this repo uses `lib/auth.ts` (Auth.js v5). However, API routes that serve dashboard data typically check session auth. Look at other API routes like `app/api/events/route.ts` or `app/api/work-items/route.ts` for the auth pattern to follow.

### Expected Ledger Entry Shape

```typescript
// Each entry in tlm-action-ledger.json
{
  agentType: string;           // filter for 'qa-agent'
  timestamp: string;           // ISO 8601
  repo: string;                // e.g. 'jamesstineheath/agent-forge'
  outcome: 'pass' | 'fail';
  durationMs?: number;
  failureCategory?: string;    // e.g. 'deploy_timeout', 'assertion_failed'
  summary?: string;
  prNumber?: number;
  [key: string]: unknown;
}
```

The ledger file may not exist yet (TLM QA Agent is currently DISABLED per CLAUDE.md). The endpoint must handle missing files gracefully.

## Requirements

1. `app/api/qa-results/route.ts` must exist and export a named `GET` handler
2. The GET handler reads and merges ledger data from:
   - Local file `docs/tlm-action-ledger.json` (relative to repo root)
   - GitHub API fetch of `docs/tlm-action-ledger.json` from `jamesstineheath/personal-assistant`
   - GitHub API fetch of `docs/tlm-action-ledger.json` from `jamesstineheath/rez-sniper`
3. Filter all entries to only those with `agentType === 'qa-agent'`
4. Support `?days=N` query parameter (default: 30) to filter entries by timestamp recency
5. Return a JSON response with these fields:
   - `passRate`: number (0–100, percentage)
   - `totalRuns`: number
   - `failureCategories`: `{ category: string; count: number }[]` sorted by count descending
   - `averageDurationMs`: number (0 if no duration data)
   - `perRepo`: `{ repo: string; passRate: number; totalRuns: number }[]`
   - `recentRuns`: last 10 entries (sorted newest-first) with fields: `timestamp`, `repo`, `outcome`, `durationMs`, `failureCategory`, `summary`, `prNumber`
   - `graduationStatus`: `{ currentRuns: number; requiredRuns: 20; falseNegativeRate: number; graduated: boolean }`
6. `graduationStatus.graduated` is `true` when `currentRuns >= 20` AND `falseNegativeRate < 0.05` (i.e., <5% false negatives — entries with `outcome: 'fail'` that have `failureCategory: 'false_negative'`)
7. Return HTTP 200 with zeroed/empty values when no ledger data exists — never 404 or 500 for missing ledger files
8. Return HTTP 401 if user is not authenticated (follow existing auth pattern)
9. Use `GH_PAT` env var for GitHub API calls; gracefully skip a repo if the env var is missing or the fetch fails

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/qa-results-api-route
```

### Step 1: Study existing API route auth patterns

Before writing code, inspect two existing API routes to understand the auth pattern:

```bash
cat app/api/events/route.ts
cat app/api/work-items/route.ts
```

Note: look for how they import and call `auth()` from `lib/auth.ts` and how they return `NextResponse.json(...)`. Use the same pattern.

### Step 2: Understand the ledger schema

```bash
# Check if a local ledger exists (may not — that's fine)
cat docs/tlm-action-ledger.json 2>/dev/null || echo "No local ledger yet"

# Check lib/types.ts for any existing ledger types
grep -n "ledger\|LedgerEntry\|ActionLedger\|agentType" lib/types.ts || echo "No ledger types yet"
```

### Step 3: Create the API route

Create `app/api/qa-results/route.ts` with the following implementation:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { readFile } from 'fs/promises';
import path from 'path';

// Shape of a single ledger entry
interface LedgerEntry {
  agentType: string;
  timestamp: string;
  repo: string;
  outcome: 'pass' | 'fail';
  durationMs?: number;
  failureCategory?: string;
  summary?: string;
  prNumber?: number;
  [key: string]: unknown;
}

// Shape of the aggregated response
interface QAResultsResponse {
  passRate: number;
  totalRuns: number;
  failureCategories: { category: string; count: number }[];
  averageDurationMs: number;
  perRepo: { repo: string; passRate: number; totalRuns: number }[];
  recentRuns: {
    timestamp: string;
    repo: string;
    outcome: 'pass' | 'fail';
    durationMs?: number;
    failureCategory?: string;
    summary?: string;
    prNumber?: number;
  }[];
  graduationStatus: {
    currentRuns: number;
    requiredRuns: number;
    falseNegativeRate: number;
    graduated: boolean;
  };
}

const TARGET_REPOS = [
  'jamesstineheath/personal-assistant',
  'jamesstineheath/rez-sniper',
];

const LEDGER_PATH = 'docs/tlm-action-ledger.json';

function emptyResponse(): QAResultsResponse {
  return {
    passRate: 0,
    totalRuns: 0,
    failureCategories: [],
    averageDurationMs: 0,
    perRepo: [],
    recentRuns: [],
    graduationStatus: {
      currentRuns: 0,
      requiredRuns: 20,
      falseNegativeRate: 0,
      graduated: false,
    },
  };
}

async function readLocalLedger(): Promise<LedgerEntry[]> {
  try {
    const filePath = path.join(process.cwd(), LEDGER_PATH);
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function fetchRemoteLedger(repo: string, ghPat: string): Promise<LedgerEntry[]> {
  try {
    const url = `https://api.github.com/repos/${repo}/contents/${LEDGER_PATH}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${ghPat}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'agent-forge',
      },
    });

    if (!response.ok) {
      // 404 = ledger doesn't exist yet; other errors = skip gracefully
      return [];
    }

    const data = await response.json();
    // GitHub API returns file content as base64
    if (data.encoding === 'base64' && data.content) {
      const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  } catch {
    return [];
  }
}

function aggregateEntries(entries: LedgerEntry[]): QAResultsResponse {
  if (entries.length === 0) return emptyResponse();

  const totalRuns = entries.length;
  const passingRuns = entries.filter((e) => e.outcome === 'pass').length;
  const passRate = totalRuns > 0 ? (passingRuns / totalRuns) * 100 : 0;

  // Average duration
  const entriesWithDuration = entries.filter((e) => typeof e.durationMs === 'number');
  const averageDurationMs =
    entriesWithDuration.length > 0
      ? entriesWithDuration.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) /
        entriesWithDuration.length
      : 0;

  // Failure categories (only from failed runs)
  const failedEntries = entries.filter((e) => e.outcome === 'fail');
  const categoryMap = new Map<string, number>();
  for (const entry of failedEntries) {
    const cat = entry.failureCategory ?? 'unknown';
    categoryMap.set(cat, (categoryMap.get(cat) ?? 0) + 1);
  }
  const failureCategories = Array.from(categoryMap.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  // Per-repo breakdown
  const repoMap = new Map<string, { pass: number; total: number }>();
  for (const entry of entries) {
    const existing = repoMap.get(entry.repo) ?? { pass: 0, total: 0 };
    existing.total += 1;
    if (entry.outcome === 'pass') existing.pass += 1;
    repoMap.set(entry.repo, existing);
  }
  const perRepo = Array.from(repoMap.entries()).map(([repo, { pass, total }]) => ({
    repo,
    passRate: total > 0 ? (pass / total) * 100 : 0,
    totalRuns: total,
  }));

  // Recent runs — sorted newest first, take last 10
  const recentRuns = [...entries]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10)
    .map((e) => ({
      timestamp: e.timestamp,
      repo: e.repo,
      outcome: e.outcome,
      durationMs: e.durationMs,
      failureCategory: e.failureCategory,
      summary: e.summary,
      prNumber: e.prNumber,
    }));

  // Graduation status
  // False negatives = failed runs with failureCategory === 'false_negative'
  const falseNegatives = failedEntries.filter(
    (e) => e.failureCategory === 'false_negative'
  ).length;
  const falseNegativeRate = totalRuns > 0 ? falseNegatives / totalRuns : 0;
  const REQUIRED_RUNS = 20;
  const graduated = totalRuns >= REQUIRED_RUNS && falseNegativeRate < 0.05;

  return {
    passRate,
    totalRuns,
    failureCategories,
    averageDurationMs,
    perRepo,
    recentRuns,
    graduationStatus: {
      currentRuns: totalRuns,
      requiredRuns: REQUIRED_RUNS,
      falseNegativeRate,
      graduated,
    },
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Parse ?days=N query param
  const { searchParams } = new URL(request.url);
  const daysParam = searchParams.get('days');
  const days = daysParam ? Math.max(1, parseInt(daysParam, 10)) : 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Gather all ledger entries
  const allEntries: LedgerEntry[] = [];

  // Local ledger
  const localEntries = await readLocalLedger();
  allEntries.push(...localEntries);

  // Remote ledger entries via GitHub API
  const ghPat = process.env.GH_PAT;
  if (ghPat) {
    const remoteResults = await Promise.allSettled(
      TARGET_REPOS.map((repo) => fetchRemoteLedger(repo, ghPat))
    );
    for (const result of remoteResults) {
      if (result.status === 'fulfilled') {
        allEntries.push(...result.value);
      }
    }
  }

  // Filter: only qa-agent entries within the time window
  const filtered = allEntries.filter((entry) => {
    if (entry.agentType !== 'qa-agent') return false;
    try {
      return new Date(entry.timestamp) >= cutoff;
    } catch {
      return false;
    }
  });

  const response = aggregateEntries(filtered);
  return NextResponse.json(response);
}
```

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- If `auth()` signature differs from what's in `lib/auth.ts`, adjust the import/call pattern to match other routes.
- If `readFile` is not available, confirm `fs/promises` is accessible in Next.js App Router server components (it is, since these run server-side).

### Step 5: Verify build succeeds

```bash
npm run build
```

If the build fails due to the new route, check:
- That `import path from 'path'` resolves (it should in server routes)
- That `import { readFile } from 'fs/promises'` resolves (it should in server routes)
- That the `auth` import path matches the actual export in `lib/auth.ts`

### Step 6: Quick smoke test (optional, if dev server is available)

```bash
# Start dev server in background and test the endpoint
npm run dev &
sleep 5
# Should get 401 without auth (since session won't exist in curl)
curl -s http://localhost:3000/api/qa-results | jq .
# Should return {"error":"Unauthorized"} with HTTP 401
kill %1
```

### Step 7: Run tests

```bash
npm test 2>/dev/null || echo "No test suite configured or tests passed"
```

### Step 8: Commit, push, open PR

```bash
git add app/api/qa-results/route.ts
git commit -m "feat: add /api/qa-results endpoint for dashboard QA metrics"
git push origin feat/qa-results-api-route
gh pr create \
  --title "feat: Dashboard QA Results API route" \
  --body "## Summary

Adds \`GET /api/qa-results\` endpoint that aggregates TLM QA Agent outcomes from:
- Local \`docs/tlm-action-ledger.json\`  
- Remote ledger from \`jamesstineheath/personal-assistant\` (via GitHub API)
- Remote ledger from \`jamesstineheath/rez-sniper\` (via GitHub API)

## Response shape
\`\`\`json
{
  \"passRate\": 87.5,
  \"totalRuns\": 8,
  \"failureCategories\": [{\"category\": \"deploy_timeout\", \"count\": 1}],
  \"averageDurationMs\": 4200,
  \"perRepo\": [{\"repo\": \"jamesstineheath/agent-forge\", \"passRate\": 100, \"totalRuns\": 2}],
  \"recentRuns\": [...],
  \"graduationStatus\": {\"currentRuns\": 8, \"requiredRuns\": 20, \"falseNegativeRate\": 0, \"graduated\": false}
}
\`\`\`

## Query params
- \`?days=N\` — filter to last N days (default: 30)

## Acceptance criteria
- [x] Route exists and exports GET handler
- [x] Filters entries by \`agentType === 'qa-agent'\`
- [x] Supports \`?days=N\` time window filtering
- [x] Returns empty/zero values when no ledger data exists
- [x] Returns 401 when unauthenticated
- [x] Gracefully handles missing ledger files (local and remote)

## Concurrent work
No file overlap with concurrent branch \`fix/bootstrap-rez-sniper-push-execute-handoffyml-via-g\`."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/qa-results-api-route
FILES CHANGED: [app/api/qa-results/route.ts]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

### Common blockers and resolutions

**`auth()` import fails or signature mismatch:**
```bash
# Check the actual auth export
grep -n "export" lib/auth.ts
# Look at how other routes call auth
grep -rn "auth()" app/api/ --include="*.ts" | head -5
```
Adjust the import and call pattern to match exactly.

**`readFile` not available (edge runtime):**
If the route is configured for edge runtime, use `fetch` with a relative URL to read the local file instead. But App Router routes default to Node.js runtime, so this should not be an issue.

**TypeScript strict mode issues with `unknown` indexing:**
Replace `entry.failureCategory` with `(entry as LedgerEntry).failureCategory` or ensure the interface is correctly typed. All fields on `LedgerEntry` are explicitly typed, so this should be fine.

**Build error about dynamic `fs` usage:**
Add this at the top of the file if needed:
```typescript
export const runtime = 'nodejs'; // explicit, though it's the default
```

## Escalation Protocol

If you hit a blocker that cannot be resolved after 3 attempts:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/api/qa-results/route.ts"]
    }
  }'
```