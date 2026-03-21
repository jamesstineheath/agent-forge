<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard Project Cleanup — PRD-53 AC-5/AC-6/AC-7

## Metadata
- **Branch:** `fix/dashboard-project-cleanup`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** app/(app)/projects/page.tsx, lib/projects.ts, lib/types.ts, lib/work-items.ts, lib/pm-agent.ts, lib/pm-prompts.ts

## Context

This handoff implements three remaining acceptance criteria from PRD-53 (Dashboard Projects):

- **AC-5**: PRD (Notion) status should be the authoritative source for project state shown in the dashboard. Currently the dashboard may show stale or derived status rather than the live Notion/PRD status.
- **AC-6**: When a project silently fails (e.g., no work items dispatched, decomposition never ran, blocked state not surfaced), the dashboard should show indicator labels so the issue is visible at a glance.
- **AC-7**: References to `PRJ-XX` identifiers in the codebase should be migrated to `PRD-XX` identifiers to match the canonical naming convention used in Notion and throughout the control plane.

The branch `fix/dashboard-project-cleanup` may already exist if this is a retry. The handoff file to execute is `handoffs/awaiting_handoff/233-dashboard-project-cleanup-prd53.md`.

Key patterns from this codebase:
- Projects are managed in `lib/projects.ts` and read via Notion API (`lib/notion.ts`)
- Work items are stored in Neon Postgres via Drizzle (`lib/db/`)
- Dashboard pages use Next.js App Router in `app/(app)/`
- The PM Agent (`lib/pm-agent.ts`) handles project health checks and decomposition

## Requirements

1. **AC-5 — PRD status as authoritative**: The projects dashboard page must display the Notion/PRD status as the canonical status. If a project has a Notion status, it should take precedence over any derived/computed status in the work item store.
2. **AC-6 — Silent failure indicator labels**: Projects in states that indicate silent failure (e.g., stuck in `executing` with no recent activity, `decomposing` with no work items created, `blocked` with no escalation) must show a visible label/badge (e.g., "⚠ Stalled", "⚠ No work items", "⚠ Blocked") on the dashboard.
3. **AC-7 — PRJ-XX → PRD-XX migration**: All string references to `PRJ-` prefix identifiers in source code (not data) should be updated to `PRD-`. This includes display labels, log messages, type comments, and any UI strings. Do not rename variables or database columns — only human-readable string labels.
4. All existing tests must pass after changes.
5. TypeScript must compile without errors (`npx tsc --noEmit`).
6. No regressions to other dashboard pages or agent cron routes.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/dashboard-project-cleanup 2>/dev/null || git checkout fix/dashboard-project-cleanup
```

### Step 1: Read the existing handoff spec

The spec-reviewed handoff file contains additional implementation detail. Read it first before making changes:

```bash
cat handoffs/awaiting_handoff/233-dashboard-project-cleanup-prd53.md
```

If that path doesn't exist, check:
```bash
ls handoffs/awaiting_handoff/
ls handoffs/
```

Use whatever detail is in the spec file to guide implementation. The requirements in this handoff are the authoritative acceptance criteria; the spec file may have additional implementation hints.

### Step 2: Understand existing project data flow

Read the relevant source files before making changes:

```bash
cat lib/projects.ts
cat lib/types.ts | grep -A 30 "Project"
cat lib/notion.ts | grep -A 20 "status\|Status"
cat app/\(app\)/projects/page.tsx
```

Understand:
- How `Project` type is defined (fields: `id`, `status`, `notionStatus`, `prdId`, etc.)
- How `lib/projects.ts` fetches and maps Notion project data
- How the projects page renders status

### Step 3: AC-5 — Make PRD/Notion status authoritative

**Goal**: When rendering project status in the dashboard, prefer the Notion-sourced status field over any derived status.

In `app/(app)/projects/page.tsx` (or wherever projects are displayed):

1. Identify where project status is rendered. Look for status badge/chip rendering.
2. If the `Project` type has both a computed `status` field and a raw `notionStatus` field, prefer `notionStatus` (or whatever field maps directly from Notion) for display.
3. If the `Project` type only has one `status` field but it's not being set from Notion data: update `lib/projects.ts` to set it from the Notion status response.

Example pattern to look for in `lib/projects.ts`:
```typescript
// Before: derived/fallback status
status: computedStatus ?? 'unknown',

// After: Notion status is authoritative
status: notionProject.status ?? computedStatus ?? 'unknown',
```

If `lib/notion.ts` fetches project data but doesn't expose the raw status string, add it to the return shape.

### Step 4: AC-6 — Silent failure indicator labels

**Goal**: Surface silent failure conditions as visible labels on the projects dashboard.

Define silent failure conditions. A project is silently failing if any of the following are true:
- Status is `executing` or `decomposing` but `updatedAt` (or last activity) is older than 2 hours with no associated work items in a non-terminal state
- Status is `blocked` with no active escalation record
- Status is `queued` and `updatedAt` is older than 30 minutes

In `app/(app)/projects/page.tsx`, add badge rendering logic. Example:

```tsx
function getSilentFailureLabel(project: Project): string | null {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  const updatedAt = new Date(project.updatedAt).getTime();

  if ((project.status === 'executing' || project.status === 'decomposing') 
      && updatedAt < twoHoursAgo) {
    return '⚠ Stalled';
  }
  if (project.status === 'blocked') {
    return '⚠ Blocked';
  }
  if (project.status === 'queued' && updatedAt < thirtyMinAgo) {
    return '⚠ Queued too long';
  }
  return null;
}
```

Then in the JSX render, show the label if non-null:
```tsx
{getSilentFailureLabel(project) && (
  <span className="ml-2 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
    {getSilentFailureLabel(project)}
  </span>
)}
```

Adjust Tailwind classes to match the existing design system used in `app/(app)/projects/page.tsx`. Check existing badge/chip components for the right class pattern.

### Step 5: AC-7 — PRJ-XX → PRD-XX string migration

**Goal**: Update human-readable string labels and display text from `PRJ-` prefix to `PRD-` prefix. Do NOT rename TypeScript variables, database columns, or function names — only visible strings and comments.

Run a targeted search:
```bash
grep -rn "PRJ-" --include="*.ts" --include="*.tsx" --include="*.md" . \
  | grep -v "node_modules" \
  | grep -v ".next" \
  | grep -v "handoffs/"
```

For each occurrence:
- If it's a string literal used in UI display, log message, or comment → change `PRJ-` to `PRD-`
- If it's a TypeScript identifier (variable name, function name, type name) → **leave it unchanged**
- If it's a database column name or Blob key → **leave it unchanged**

Common places to check:
- `lib/pm-agent.ts` — log messages referencing project IDs
- `lib/pm-prompts.ts` — prompt text referencing project format
- `app/(app)/projects/page.tsx` — display labels
- `lib/projects.ts` — status messages

Example:
```typescript
// Before
console.log(`Processing project PRJ-${id}`);
// After
console.log(`Processing project PRD-${id}`);
```

### Step 6: Check the Project type for completeness

Open `lib/types.ts` and verify the `Project` type has fields needed for AC-5 and AC-6:
- A field for Notion/PRD status (e.g., `notionStatus?: string`)
- A field for `updatedAt` timestamp

If `updatedAt` is missing from `Project`, add it:
```typescript
updatedAt: string; // ISO timestamp, used for stall detection
```

Then ensure `lib/projects.ts` populates it when constructing project objects.

### Step 7: Verify TypeScript and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors. Common issues:
- `Project` type fields added in Step 6 not populated in all construction sites
- `getSilentFailureLabel` function using a field that may be `undefined` — add null checks

### Step 8: Run tests

```bash
npm test
```

If tests fail due to the `Project` type shape change, update the test fixtures in `lib/__tests__/` to include the new fields with sensible defaults.

### Step 9: Manual smoke check

Review the changes holistically:
1. `app/(app)/projects/page.tsx` — does it render PRD status authoritatively? Does it show failure labels?
2. `lib/projects.ts` — does it correctly source status from Notion?
3. Grep confirms no remaining `PRJ-` in display strings: `grep -rn "PRJ-" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v .next | grep -v handoffs/`

### Step 10: Verification
```bash
npx tsc --noEmit
npm run build
npm test
```

All three must pass cleanly before proceeding.

### Step 11: Commit, push, open PR
```bash
git add -A
git commit -m "fix: PRD-53 AC-5/AC-6/AC-7 dashboard project cleanup

- AC-5: use Notion/PRD status as authoritative source in projects dashboard
- AC-6: add silent failure indicator labels (stalled, blocked, queued-too-long)
- AC-7: migrate PRJ-XX display strings to PRD-XX convention"

git push origin fix/dashboard-project-cleanup

gh pr create \
  --title "fix: Dashboard Project Cleanup — PRD-53 AC-5/AC-6/AC-7" \
  --body "## Summary
Implements remaining PRD-53 acceptance criteria:

### AC-5 — PRD status as authoritative
Notion/PRD status is now the canonical source for project status displayed in the dashboard. Derived/computed status is only used as a fallback when Notion status is unavailable.

### AC-6 — Silent failure indicator labels
Projects exhibiting silent failure conditions now show amber warning badges:
- **⚠ Stalled** — executing/decomposing with no activity for 2+ hours
- **⚠ Blocked** — project in blocked state
- **⚠ Queued too long** — queued for 30+ minutes

### AC-7 — PRJ-XX → PRD-XX migration
All human-readable string labels, log messages, and display text updated from \`PRJ-\` to \`PRD-\` prefix. TypeScript identifiers, DB columns, and Blob keys unchanged.

## Testing
- \`npx tsc --noEmit\` ✅
- \`npm run build\` ✅
- \`npm test\` ✅

## Risk
Medium — touches projects page and type definitions, no schema changes."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: fix/dashboard-project-cleanup
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [which ACs remain: AC-5, AC-6, AC-7]
```

## Escalation

If you encounter an unresolvable blocker (e.g., `Project` type shape is fundamentally incompatible with AC-5 Notion sourcing, or the projects page uses a completely different rendering pattern than expected):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "233",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["<list of files modified so far>"]
    }
  }'
```