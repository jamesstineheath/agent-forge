# Agent Forge -- Display Priority and Rank on Work Item Detail Page

## Metadata
- **Branch:** `feat/display-priority-rank-work-item-detail`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/dashboard/work-items/[id]/page.tsx

## Context

The work item data model was recently extended with `priority` (P0/P1/P2) and `rank` (numeric) fields, added as part of the dispatch event log improvements (see merged PR: "feat: add priority and rank to dispatch event log entries"). These fields now exist on `WorkItem` in `lib/types.ts` but are not yet surfaced in the dashboard's work item detail view.

The detail page at `app/dashboard/work-items/[id]/page.tsx` currently displays metadata like status and `createdAt`. This task adds `Priority` and `Rank` display fields near that existing metadata, with color-coded badges for priority.

No concurrent work items touch `app/dashboard/work-items/[id]/page.tsx` — the only concurrent branch (`fix/vercel-spend-validation-checklist-and-adr-finaliza`) modifies docs only.

## Requirements

1. Add a **Priority** field to the work item detail view that displays the priority value as a colored badge:
   - `P0` → red/destructive styling
   - `P1` → yellow/warning styling
   - `P2` → gray/secondary styling
   - If `priority` is `undefined` or `null` → display `P1 (default)` with yellow/warning styling
2. Add a **Rank** field displaying the numeric rank value as plain text.
   - If `rank` is `undefined` or `null` → display `999 (default)`
3. Both fields must be placed **near the top of the detail view**, adjacent to existing metadata like `status` and `createdAt`.
4. TypeScript compilation must pass with zero errors (`npx tsc --noEmit`).
5. No changes to any other files — this is a single-file UI change.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/display-priority-rank-work-item-detail
```

### Step 1: Inspect existing files for context

Before editing, read the current state of the detail page and the WorkItem type:

```bash
cat app/dashboard/work-items/[id]/page.tsx
cat lib/types.ts | grep -A 30 "WorkItem"
```

Take note of:
- How the page fetches the work item (likely via `getWorkItem` or similar from `lib/work-items.ts`)
- How existing metadata fields (status, createdAt) are rendered — match that pattern
- What Badge/UI component variants are available (check `components/ui/badge.tsx` or similar)

```bash
ls components/ui/
cat components/ui/badge.tsx 2>/dev/null || echo "No badge component found"
```

If no `Badge` component exists, use inline `<span>` with Tailwind classes instead.

### Step 2: Implement the priority badge helper and field additions

Edit `app/dashboard/work-items/[id]/page.tsx` to add the following:

**2a. Priority badge helper** — add a small inline helper (or inline JSX) to map priority to badge styling. Example pattern:

```tsx
// Helper to get badge variant/classes for priority
function getPriorityDisplay(priority: string | undefined | null): {
  label: string;
  className: string;
} {
  switch (priority) {
    case 'P0':
      return { label: 'P0', className: 'bg-red-100 text-red-800 border-red-300' };
    case 'P2':
      return { label: 'P2', className: 'bg-gray-100 text-gray-700 border-gray-300' };
    case 'P1':
    default:
      return {
        label: priority ? 'P1' : 'P1 (default)',
        className: 'bg-yellow-100 text-yellow-800 border-yellow-300',
      };
  }
}
```

> **Note:** If the project uses shadcn/ui Badge with `variant` prop, prefer using `variant="destructive"` for P0, a custom variant or `className` override for P1/P2. Check what variants are available in `components/ui/badge.tsx` and adapt accordingly. If Badge accepts `className`, use that for color overrides.

**2b. Rank display helper:**

```tsx
function getRankDisplay(rank: number | undefined | null): string {
  return rank !== undefined && rank !== null ? String(rank) : '999 (default)';
}
```

**2c. Add the fields to the JSX** — place them near the top of the detail view, alongside status and createdAt. Match the existing layout pattern exactly. For example, if the page uses a definition list or a grid of label/value pairs:

```tsx
{/* Priority */}
<div className="flex items-center gap-2">
  <span className="text-sm font-medium text-muted-foreground">Priority</span>
  {(() => {
    const { label, className } = getPriorityDisplay(workItem.priority);
    return (
      <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${className}`}>
        {label}
      </span>
    );
  })()}
</div>

{/* Rank */}
<div className="flex items-center gap-2">
  <span className="text-sm font-medium text-muted-foreground">Rank</span>
  <span className="text-sm">{getRankDisplay(workItem.rank)}</span>
</div>
```

> **Adapt to the actual layout pattern** you see in Step 1. If the page uses a table, `<dl>`, or card grid, match that structure. The key requirement is that Priority and Rank appear near status/createdAt.

### Step 3: Verify TypeScript types

Check that `priority` and `rank` exist on the `WorkItem` type. If they're typed as optional (`priority?: 'P0' | 'P1' | 'P2'` and `rank?: number`), the helper functions above handle `undefined` correctly.

If the fields are missing from the type entirely, add them to `lib/types.ts`:

```typescript
// In the WorkItem interface/type, add:
priority?: 'P0' | 'P1' | 'P2';
rank?: number;
```

Only touch `lib/types.ts` if the fields are genuinely absent. The recent PR "feat: add priority and rank to dispatch event log entries" likely already added them.

### Step 4: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues:
- `workItem.priority` not typed → add to `WorkItem` type if missing
- Badge variant not accepting custom `className` → use inline `<span>` instead

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "feat: display priority and rank on work item detail page"
git push origin feat/display-priority-rank-work-item-detail
gh pr create \
  --title "feat: display priority and rank on work item detail page" \
  --body "## Summary

Adds Priority and Rank display fields to the work item detail page.

## Changes
- **Priority badge**: Displays P0 (red), P1 (yellow), P2 (gray); defaults to 'P1 (default)' when unset
- **Rank field**: Displays numeric rank; defaults to '999 (default)' when unset
- Both fields placed near existing metadata (status, createdAt)

## Files Changed
- \`app/dashboard/work-items/[id]/page.tsx\`

## Testing
- TypeScript: \`npx tsc --noEmit\` passes
- Build: \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/display-priority-rank-work-item-detail
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If blocked (e.g., `WorkItem` type is missing `priority`/`rank` and adding them to `lib/types.ts` conflicts with concurrent work, or the page structure is radically different from expectations):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "display-priority-rank-work-item-detail",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/dashboard/work-items/[id]/page.tsx"]
    }
  }'
```