<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- PRD-54 AC-6: Daily digest email includes bugs summary

## Metadata
- **Branch:** `feat/prd-54-ac-6-daily-digest-bugs-summary`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/pm-agent.ts, lib/pm-prompts.ts, lib/types.ts

## Context

Agent Forge has a daily PM digest email composed by `composeDigest()` in `lib/pm-agent.ts`. The digest uses a `DigestContext` type (defined somewhere in `lib/pm-prompts.ts` or `lib/types.ts`) and a `buildDigestPrompt()` function in `lib/pm-prompts.ts` to produce a Claude-generated summary email.

This AC adds a bugs section to that digest by:
1. Querying the Notion Bugs database (`023f3621-2885-468d-a8cf-2e0bd1458bb3`) for recent activity
2. Extending `DigestContext` with a `bugs` field
3. Wiring the data through `composeDigest()` → `buildDigestPrompt()`

**Concurrent work note:** AC-4 (branch `fix/prd-54-ac-4-auto-close-bugs-in-notion-when-work-it`) is touching `lib/bugs.ts`. If `lib/bugs.ts` already exists and has a `fetchBugsSummary`-style helper, import from it. If not, implement `fetchBugsSummary()` directly in `lib/pm-agent.ts` to avoid conflicting with concurrent work on `lib/bugs.ts`.

**Pattern reference:** `queryProjects()` in `lib/notion.ts` shows the standard pattern for Notion database queries (`databases/{dbId}/query` with filters). Follow that exact pattern.

## Requirements

1. A `fetchBugsSummary()` function exists that queries Notion database `023f3621-2885-468d-a8cf-2e0bd1458bb3` and returns `newCount`, `fixedCount`, `fixedWithPRs`, and `openBySeverity` (critical/high/medium/low counts).
2. `DigestContext` (wherever defined) gains an optional `bugs` field matching the specified shape.
3. `composeDigest()` calls `fetchBugsSummary()` and attaches the result to `digestContext.bugs`.
4. `buildDigestPrompt()` includes the bugs section in the prompt template so Claude generates a readable paragraph about bug activity.
5. TypeScript compiles with no errors (`npx tsc --noEmit`).
6. `fetchBugsSummary()` does not modify `lib/bugs.ts` or `lib/event-reactor.ts` (concurrent work files).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/prd-54-ac-6-daily-digest-bugs-summary
```

### Step 1: Locate existing types and patterns

Read the relevant files to understand the current shape before making changes:

```bash
# Find where DigestContext is defined
grep -rn "DigestContext" lib/
grep -rn "composeDigest" lib/
grep -rn "buildDigestPrompt" lib/
# Check if bugs.ts exists and if it has fetchBugsSummary
ls lib/bugs.ts 2>/dev/null && grep -n "fetchBugsSummary\|BugsSummary" lib/bugs.ts || echo "lib/bugs.ts not found or no relevant exports"
# Review the Notion query pattern
grep -A 30 "queryProjects" lib/notion.ts
# Review composeDigest signature and body
grep -A 60 "composeDigest" lib/pm-agent.ts
```

### Step 2: Add `BugsSummary` type and extend `DigestContext`

Locate where `DigestContext` is defined (likely `lib/pm-prompts.ts` or `lib/types.ts`). Add the `BugsSummary` type and extend `DigestContext`.

**Add the `BugsSummary` type:**
```typescript
export interface BugsSummary {
  newCount: number;
  fixedCount: number;
  fixedWithPRs: Array<{ title: string; prUrl: string }>;
  openBySeverity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}
```

**Extend `DigestContext`** (add optional field):
```typescript
bugs?: BugsSummary;
```

### Step 3: Implement `fetchBugsSummary()`

**Decision logic:**
- If `lib/bugs.ts` exists AND already exports a function that returns `BugsSummary`-compatible data, import from it instead of duplicating.
- Otherwise, implement `fetchBugsSummary()` directly in `lib/pm-agent.ts`.

**Do NOT modify `lib/bugs.ts` or `lib/event-reactor.ts`** (concurrent work files).

Add the following to `lib/pm-agent.ts` (or import it if available from `lib/bugs.ts`):

```typescript
import { BugsSummary } from './pm-prompts'; // or lib/types.ts, wherever you put it

const BUGS_DB_ID = '023f3621-2885-468d-a8cf-2e0bd1458bb3';

async function fetchBugsSummary(): Promise<BugsSummary> {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) {
    console.warn('[fetchBugsSummary] NOTION_API_KEY not set, returning empty summary');
    return {
      newCount: 0,
      fixedCount: 0,
      fixedWithPRs: [],
      openBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    };
  }

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const headers = {
    Authorization: `Bearer ${notionKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  // 1. Bugs filed in last 24h
  const newBugsRes = await fetch(
    `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter: {
          property: 'created_time',
          date: { after: yesterday },
        },
      }),
    }
  );
  const newBugsData = newBugsRes.ok ? await newBugsRes.json() : { results: [] };
  const newCount: number = newBugsData.results?.length ?? 0;

  // 2. Bugs fixed in last 24h
  const fixedBugsRes = await fetch(
    `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: 'Status',
              status: { equals: 'Fixed' },
            },
            {
              timestamp: 'last_edited_time',
              last_edited_time: { after: yesterday },
            },
          ],
        },
      }),
    }
  );
  const fixedBugsData = fixedBugsRes.ok ? await fixedBugsRes.json() : { results: [] };
  const fixedResults: any[] = fixedBugsData.results ?? [];
  const fixedCount = fixedResults.length;

  // Extract PR URLs from fixed bugs (look for a "PR" or "URL" property)
  const fixedWithPRs = fixedResults
    .map((page: any) => {
      const titleProp = page.properties?.Name ?? page.properties?.Title;
      const title =
        titleProp?.title?.[0]?.plain_text ?? titleProp?.rich_text?.[0]?.plain_text ?? 'Untitled';
      const prProp =
        page.properties?.PR ??
        page.properties?.['PR URL'] ??
        page.properties?.['Pull Request'];
      const prUrl =
        prProp?.url ?? prProp?.rich_text?.[0]?.plain_text ?? '';
      return prUrl ? { title, prUrl } : null;
    })
    .filter(Boolean) as Array<{ title: string; prUrl: string }>;

  // 3. Open bugs by severity
  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const openBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };

  await Promise.all(
    severities.map(async (severity) => {
      const res = await fetch(
        `https://api.notion.com/v1/databases/${BUGS_DB_ID}/query`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            filter: {
              and: [
                {
                  property: 'Status',
                  status: { does_not_equal: 'Fixed' },
                },
                {
                  property: 'Status',
                  status: { does_not_equal: "Won't Fix" },
                },
                {
                  property: 'Severity',
                  select: { equals: severity.charAt(0).toUpperCase() + severity.slice(1) },
                },
              ],
            },
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        openBySeverity[severity] = data.results?.length ?? 0;
      }
    })
  );

  return { newCount, fixedCount, fixedWithPRs, openBySeverity };
}
```

> **Note on Notion filter syntax:** `created_time` is a built-in timestamp property filtered via `{ timestamp: 'created_time', created_time: { after: yesterday } }`. If the `created_time` filter syntax above doesn't work at runtime, check `queryProjects()` in `lib/notion.ts` for the exact filter shape used in this codebase and match it. The `Status` property filter shape may also differ (e.g., `select` vs `status`) — inspect actual Notion DB property types if needed. Prefer resilience: catch errors per-query and default to 0.

### Step 4: Wire `fetchBugsSummary()` into `composeDigest()`

In `lib/pm-agent.ts`, locate `composeDigest()` and add the bugs fetch. The pattern should look like:

```typescript
async function composeDigest(/* existing params */): Promise<string> {
  // ... existing code that builds digestContext ...

  // Add bugs summary (graceful fallback on error)
  let bugs: BugsSummary | undefined;
  try {
    bugs = await fetchBugsSummary();
  } catch (err) {
    console.error('[composeDigest] Failed to fetch bugs summary:', err);
  }

  const digestContext: DigestContext = {
    // ... existing fields ...
    bugs,
  };

  return buildDigestPrompt(digestContext);
}
```

Adapt to whatever the existing `composeDigest()` structure looks like — preserve all existing logic, only add the `bugs` fetch and field assignment.

### Step 5: Update `buildDigestPrompt()` in `lib/pm-prompts.ts`

Locate `buildDigestPrompt()` and add the bugs section to the prompt template. Find where the existing sections are appended and add after them:

```typescript
// Inside buildDigestPrompt(), after existing sections:
if (context.bugs) {
  const { newCount, fixedCount, fixedWithPRs, openBySeverity } = context.bugs;
  const { critical, high, medium, low } = openBySeverity;
  const totalOpen = critical + high + medium + low;

  const fixedPRList =
    fixedWithPRs.length > 0
      ? fixedWithPRs.map((b) => `  - ${b.title}: ${b.prUrl}`).join('\n')
      : '  (none with linked PRs)';

  prompt += `
## Bugs (last 24h)
- New bugs filed: ${newCount}
- Bugs fixed: ${fixedCount}
${fixedWithPRs.length > 0 ? `  Fixed bugs with PRs:\n${fixedPRList}` : ''}
- Open bugs: ${totalOpen} total (${critical} critical, ${high} high, ${medium} medium, ${low} low)

Generate a concise bugs paragraph summarizing the above. Highlight if there are critical open bugs or a spike in new filings.
`;
}
```

Adapt the exact string concatenation/template style to match whatever pattern `buildDigestPrompt()` already uses (template literals, string concatenation, array join, etc.).

### Step 6: Verification

```bash
# Type check
npx tsc --noEmit

# Lint if configured
npm run lint 2>/dev/null || true

# Build
npm run build

# Confirm no imports from lib/bugs.ts were modified (concurrent work guard)
git diff --name-only | grep -E "lib/bugs\.ts|lib/event-reactor\.ts" && echo "WARNING: modified concurrent work files" || echo "OK: no concurrent files touched"
```

Fix any TypeScript errors before proceeding.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: PRD-54 AC-6 — include bugs summary in daily digest email"
git push origin feat/prd-54-ac-6-daily-digest-bugs-summary
gh pr create \
  --title "feat: PRD-54 AC-6 — daily digest email includes bugs summary" \
  --body "## Summary

Adds a bugs section to the daily PM digest email.

### Changes
- **\`lib/pm-agent.ts\`**: Added \`fetchBugsSummary()\` (queries Notion Bugs DB \`023f3621-2885-468d-a8cf-2e0bd1458bb3\`) and wired it into \`composeDigest()\`
- **\`lib/pm-prompts.ts\`** (and/or \`lib/types.ts\`): Extended \`DigestContext\` with optional \`bugs\` field; updated \`buildDigestPrompt()\` with bugs section template
  
### Bugs section data
- New bugs filed in last 24h
- Bugs fixed in last 24h (with PR links if available)
- Open bug count by severity (critical / high / medium / low)

### Concurrent work
Did not modify \`lib/bugs.ts\` or \`lib/event-reactor.ts\` (AC-4 branch).

### Acceptance criteria
- [x] \`fetchBugsSummary()\` queries Notion Bugs DB with correct filters
- [x] \`DigestContext.bugs\` field added
- [x] \`composeDigest()\` populates bugs context
- [x] \`buildDigestPrompt()\` includes bugs paragraph template
- [x] TypeScript compiles clean
- [x] Graceful fallback if Notion API unavailable"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/prd-54-ac-6-daily-digest-bugs-summary
FILES CHANGED: [list of modified files]
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "Notion filter syntax unclear for created_time timestamp filter" or "DigestContext not found in expected locations"]
NEXT STEPS: [what remains]
```

## Escalation

If blocked on any of the following, escalate via the API:
- `DigestContext` cannot be found anywhere in the codebase
- `composeDigest()` does not exist or has a completely unexpected signature
- The Notion Bugs database property names (`Status`, `Severity`) differ from what's documented and it's unclear how to filter

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "prd-54-ac-6",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/pm-agent.ts", "lib/pm-prompts.ts"]
    }
  }'
```