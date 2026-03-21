<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard: render verified and partial work item statuses

## Metadata
- **Branch:** `feat/dashboard-verified-partial-statuses`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `components/status-badge.tsx`, `components/pipeline-stages.tsx`, `app/(app)/pipeline/page.tsx`, `lib/types.ts`

## Context

PRD-53 AC-1 requires the dashboard to correctly render `verified` and `partial` as distinct visual statuses across all work item UI components. Currently these statuses likely fall through to a default/unknown style.

The work item lifecycle (from SYSTEM_MAP.md) includes these terminal states:
- **Verified**: All acceptance criteria passed post-merge validation
- **Partial**: Some acceptance criteria failed post-merge validation; gap analysis filed

These must be visually distinct from each other and from adjacent statuses like `merged` and `failed`.

The `PipelineStages` component must include `verified` and `partial` in its stage flow visualization (they appear after `merged` in the lifecycle).

**Concurrent work to avoid:** The branch `fix/dashboard-dynamic-agent-count-replaces-hardcoded-v` touches `app/(app)/agents/page.tsx`, `app/api/agents/count/route.ts`, and `lib/hooks.ts`. Do not modify those files.

## Requirements

1. `verified` status renders with a distinct color (green/teal family, indicating success) and label "Verified" across all work item display surfaces.
2. `partial` status renders with a distinct color (yellow/amber family, indicating partial success) and label "Partial" across all work item display surfaces.
3. Neither status falls through to a default/unknown/gray style.
4. The `PipelineStages` component includes `verified` and `partial` as named stages in the correct position in the flow (after `merged`).
5. All existing status colors/labels remain unchanged.
6. TypeScript compiles without errors (`npx tsc --noEmit`).
7. `npm run build` succeeds.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-verified-partial-statuses
```

### Step 1: Audit existing status handling

Locate all files that contain status color/label mappings and the `PipelineStages` component:

```bash
# Find status color/label maps
grep -rn "verified\|partial\|merged\|executing\|reviewing" \
  --include="*.tsx" --include="*.ts" \
  -l app/ components/ lib/ | grep -v node_modules

# Find the specific status badge / color utility
grep -rn "statusColor\|status_color\|getStatus\|StatusBadge\|statusLabel\|statusMap\|colorMap" \
  --include="*.tsx" --include="*.ts" \
  app/ components/ lib/ | grep -v node_modules

# Find PipelineStages
grep -rn "PipelineStages\|pipeline-stages\|stageFlow\|stage_flow" \
  --include="*.tsx" --include="*.ts" \
  app/ components/ | grep -v node_modules
```

Read the files identified. Common locations based on the codebase patterns:
- `components/status-badge.tsx` — likely has a color/label map keyed by status string
- `components/pipeline-stages.tsx` — the stage flow visualization
- `app/(app)/pipeline/page.tsx` — pipeline overview page
- Possibly inline status styling in work item cards/queue components

### Step 2: Update `lib/types.ts` if needed

Open `lib/types.ts` and find the `WorkItem` type or status union type. If `verified` and `partial` are not already in the status union, add them:

```typescript
// Find the status type — it likely looks something like:
export type WorkItemStatus =
  | 'filed'
  | 'ready'
  | 'queued'
  | 'generating'
  | 'executing'
  | 'reviewing'
  | 'merged'
  | 'failed'
  | 'blocked'
  | 'parked'
  // Add if missing:
  | 'verified'
  | 'partial';
```

Only modify this file if `verified`/`partial` are genuinely absent from the type definition.

### Step 3: Update status color/label mappings

Find the central status-to-color and status-to-label mappings. These are likely in `components/status-badge.tsx` or a shared utility. Add entries for `verified` and `partial`:

**Color scheme (Tailwind CSS classes):**
- `verified` → green/teal, e.g. `bg-green-100 text-green-800` (or `bg-emerald-100 text-emerald-800`) — distinct from `merged` (which may already use green; pick teal/emerald to differentiate)
- `partial` → amber/yellow, e.g. `bg-amber-100 text-amber-800`

**Example — if there's a map like this:**
```typescript
const statusColors: Record<string, string> = {
  filed:      'bg-gray-100 text-gray-600',
  ready:      'bg-blue-100 text-blue-700',
  queued:     'bg-blue-100 text-blue-700',
  generating: 'bg-purple-100 text-purple-700',
  executing:  'bg-indigo-100 text-indigo-700',
  reviewing:  'bg-yellow-100 text-yellow-700',
  merged:     'bg-green-100 text-green-800',
  failed:     'bg-red-100 text-red-700',
  blocked:    'bg-red-100 text-red-700',
  parked:     'bg-orange-100 text-orange-700',
  // ADD:
  verified:   'bg-emerald-100 text-emerald-800',
  partial:    'bg-amber-100 text-amber-800',
};
```

**Example — if there's a label map:**
```typescript
const statusLabels: Record<string, string> = {
  // ... existing entries ...
  verified: 'Verified',
  partial:  'Partial',
};
```

**Important:** Match the exact pattern already used in the file. Don't refactor existing entries — only add the two new ones.

If status styling is done with a `switch` statement instead of a map, add `case 'verified':` and `case 'partial':` cases in the appropriate position (after `merged`).

### Step 4: Update `PipelineStages` component

Open the `PipelineStages` component (likely `components/pipeline-stages.tsx`). This component visualizes the work item lifecycle flow.

Find where the stages array/list is defined. It probably looks like:

```typescript
const stages = [
  'filed', 'ready', 'queued', 'generating', 'executing', 'reviewing', 'merged'
];
```

Add `verified` and `partial` after `merged`. Since both are terminal post-merge states (not sequential), they should be represented as branching terminal states. Follow whatever pattern the component already uses for branching (e.g., `failed`, `blocked`, `parked` are also non-linear terminals).

If the component shows a linear flow with side branches for error states, add `verified` and `partial` as terminal nodes after `merged` (similar to how `failed` branches off from in-progress states).

If the component just uses an ordered array and highlights the current stage, add both after `merged` — `verified` first (happy path), then `partial`:

```typescript
const stages = [
  'filed', 'ready', 'queued', 'generating', 'executing', 'reviewing', 
  'merged', 'verified', 'partial'
];
```

Ensure each stage in the array has a corresponding color/label entry (handled in Step 3).

### Step 5: Audit remaining work item display components

Search for any inline status handling in other components that wasn't caught in Step 1:

```bash
grep -rn "'merged'\|\"merged\"\|status === 'merged'\|status == \"merged\"" \
  --include="*.tsx" \
  app/ components/ | grep -v node_modules
```

Check these files for exhaustive status handling. Common components to check:
- Work item cards in the queue view
- Work item detail modal/page
- Project cards (which may show aggregate status)
- Any status filter dropdowns (add `verified` and `partial` as filter options if a filter list exists)

For each file found, apply the same pattern: add `verified` and `partial` entries using the same color/label values from Step 3.

### Step 6: Check for status filter/selector components

```bash
grep -rn "statusOptions\|filterStatus\|status.*filter\|filter.*status" \
  --include="*.tsx" --include="*.ts" \
  app/ components/ | grep -v node_modules
```

If there are filter dropdown options lists, add `verified` and `partial` to them so users can filter by these statuses.

### Step 7: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build
```

Fix any type errors before proceeding. Common issues:
- If `WorkItemStatus` is a strict union and you added to it, ensure all `switch` exhaustiveness checks still compile
- If there are `Record<WorkItemStatus, string>` maps, all new union members must have entries

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: render verified and partial work item statuses in dashboard (PRD-53 AC-1)"
git push origin feat/dashboard-verified-partial-statuses
gh pr create \
  --title "feat: render verified and partial work item statuses (PRD-53 AC-1)" \
  --body "## Summary
Adds correct visual rendering for \`verified\` and \`partial\` work item statuses across all dashboard UI components.

## Changes
- **Status color/label maps**: Added \`verified\` (emerald/green) and \`partial\` (amber/yellow) entries so neither falls through to default/unknown styling
- **PipelineStages**: Added both statuses to the stage flow visualization in the correct post-merge position
- **Type definitions**: Ensured \`WorkItemStatus\` union includes both terminal states (if not already present)
- Any additional work item display components (queue, detail, project cards) updated with the new status entries

## Visual Design
- \`verified\`: Emerald/teal green — distinct from \`merged\` green, signals post-merge validation success
- \`partial\`: Amber/yellow — signals partial acceptance criteria success with gap analysis filed

## Acceptance Criteria (PRD-53 AC-1)
- [x] \`verified\` renders with distinct color and label across all work item surfaces
- [x] \`partial\` renders with distinct color and label across all work item surfaces
- [x] Neither status falls through to default/unknown style
- [x] PipelineStages includes both in the stage flow
- [x] TypeScript compiles clean
- [x] Build passes

## No Conflicts
Does not touch \`app/(app)/agents/page.tsx\`, \`app/api/agents/count/route.ts\`, or \`lib/hooks.ts\` (concurrent branch \`fix/dashboard-dynamic-agent-count-replaces-hardcoded-v\`)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-verified-partial-statuses
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., status handling is deeply coupled across 10+ files with no clear central map, or `verified`/`partial` are handled by a server-side enum that requires schema migration):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "dashboard-verified-partial-statuses",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["<list of files modified so far>"]
    }
  }'
```