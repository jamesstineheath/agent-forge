# Agent Forge -- Update dashboard to display direct-source items and triggeredBy

## Metadata
- **Branch:** `feat/dashboard-direct-source-display`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/work-items/page.tsx, lib/types.ts

## Context

Agent Forge has recently added support for "direct-source" work items (fast-lane items filed via `/api/fast-lane` or `/api/mcp`). These items have a `source` field that can be `"project"`, `"manual"`, or `"direct"`, and a `triggeredBy` field indicating attribution (e.g., which MCP tool or PA bridge filed the item). There is also a new `"escalated"` status for direct-source items that hit a blocker.

The dashboard work items view currently does not surface these fields visually. This task adds:
1. Source type badges (project=blue, manual=gray, direct=green)
2. `triggeredBy` attribution shown below the item title
3. An amber/orange visual indicator for `"escalated"` status
4. A filter/tab to show only `direct` source items (Fast Lane view)

### Relevant types (from `lib/types.ts`)
The `WorkItem` type already includes `source` and `triggeredBy` fields based on recent merged PRs. Confirm the exact shape at the start of execution.

### Existing patterns
- The project uses Tailwind CSS v4 and shadcn/ui components
- Status badges already exist for statuses like `"merged"`, `"executing"`, etc. — follow the same pattern
- The work items page is at `app/(app)/work-items/page.tsx`
- SWR hooks for data fetching are in `lib/hooks.ts`

## Requirements

1. The work items list renders a source badge on each item: `project` = blue, `manual` = gray, `direct` = green
2. The `triggeredBy` field (when present) is shown as small secondary text below the item title
3. The `"escalated"` status is rendered with an amber/orange badge labeled "Escalated" (distinct from other statuses)
4. A "Fast Lane" filter tab/button is available that filters the list to show only items where `source === "direct"`
5. Existing display for `project` and `manual` source items is visually unchanged except for the addition of the source badge and triggeredBy text
6. The filter UI matches the existing filter/tab pattern already present in the work items page
7. No TypeScript errors introduced

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-direct-source-display
```

### Step 1: Inspect existing code

Read the following files to understand current structure before making changes:

```bash
cat app/(app)/work-items/page.tsx
cat lib/types.ts
cat lib/hooks.ts
# Check for any WorkItemCard or similar component
find components -name "*.tsx" | xargs grep -l -i "workitem\|work-item\|work_item" 2>/dev/null || true
```

Key things to confirm:
- The shape of `WorkItem` type (does it have `source`, `triggeredBy`, `status` fields?)
- How status badges are currently rendered (look for existing badge/pill patterns)
- Whether there's a filter/tab component already (look for status filter tabs)
- The exact import paths for shadcn/ui `Badge` or similar components

### Step 2: Update `lib/types.ts` if needed

If `WorkItem` does not already have `source` and `triggeredBy` fields, add them:

```typescript
// In the WorkItem interface/type, ensure these fields exist:
source?: "project" | "manual" | "direct";
triggeredBy?: string;
// status should already include "escalated" — if not, add it:
// status: "filed" | "ready" | "queued" | "generating" | "executing" | "reviewing" | "merged" | "blocked" | "parked" | "escalated";
```

Only modify `lib/types.ts` if these fields are missing.

### Step 3: Update the work items page

Open `app/(app)/work-items/page.tsx` and make the following changes:

#### 3a: Add source badge helper

Add a helper function near the top of the file (or inline) to map source to badge color:

```tsx
function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const variants: Record<string, string> = {
    project: "bg-blue-100 text-blue-800",
    manual: "bg-gray-100 text-gray-700",
    direct: "bg-green-100 text-green-800",
  };
  const labels: Record<string, string> = {
    project: "Project",
    manual: "Manual",
    direct: "Fast Lane",
  };
  const cls = variants[source] ?? "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {labels[source] ?? source}
    </span>
  );
}
```

#### 3b: Update status badge rendering for "escalated"

Find where statuses are rendered as badges. Add handling for `"escalated"`:

```tsx
// In whatever status color/variant mapping exists, add:
escalated: "bg-amber-100 text-amber-800",  // or equivalent Tailwind classes
// Label: "Escalated"
```

If status badges use a `switch` or object map, extend it. Example pattern to follow:
```tsx
const statusColors: Record<string, string> = {
  // ...existing entries...
  escalated: "bg-amber-100 text-amber-800",
};
const statusLabels: Record<string, string> = {
  // ...existing entries...
  escalated: "Escalated",
};
```

#### 3c: Add triggeredBy display

In the work item row/card render, after the title, add:

```tsx
{item.triggeredBy && (
  <p className="text-xs text-muted-foreground mt-0.5">
    via {item.triggeredBy}
  </p>
)}
```

#### 3d: Add source badge to item display

In the work item row/card, alongside the status badge (or after the title line), render `<SourceBadge source={item.source} />`.

#### 3e: Add "Fast Lane" filter tab

Find the existing filter/tab UI (likely filtering by status or showing "All", "Active", "Merged" etc.). Add a "Fast Lane" tab that filters `source === "direct"`.

The filter state management pattern will be visible from the existing code. Follow it exactly. For example, if there's a `statusFilter` state:

```tsx
// Add a separate sourceFilter state or extend the existing filter
const [sourceFilter, setSourceFilter] = React.useState<"all" | "direct">("all");

// In the filter tabs UI, add:
<button
  onClick={() => setSourceFilter(sourceFilter === "direct" ? "all" : "direct")}
  className={cn(
    "...", // match existing tab button classes
    sourceFilter === "direct" && "..." // active class
  )}
>
  ⚡ Fast Lane
</button>

// In the filtered items computation:
const filteredItems = items
  .filter(item => /* existing status filter */)
  .filter(item => sourceFilter === "direct" ? item.source === "direct" : true);
```

**Important:** Adapt this pattern to whatever filter mechanism already exists in the file. Don't introduce a new pattern if one exists.

### Step 4: Handle edge cases

- Items with no `source` field (older items): source badge should not render (already handled by `if (!source) return null`)
- Items with no `triggeredBy`: triggeredBy line should not render (already handled by conditional)
- The "escalated" status badge must not break existing status rendering for other statuses

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues:
- `source` field not in `WorkItem` type → add it to `lib/types.ts`
- Tailwind classes not recognized → use standard Tailwind v4 utility classes
- Import missing for `cn` utility → import from `lib/utils`

### Step 6: Visual sanity check (optional)

If you can run the dev server, verify:
```bash
npm run dev
# Navigate to /work-items in browser
```

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add source badge, triggeredBy, escalated status, and fast lane filter to work items dashboard"
git push origin feat/dashboard-direct-source-display
gh pr create \
  --title "feat: display source type, triggeredBy, and fast lane filter on work items dashboard" \
  --body "## Summary

Updates the work items dashboard to surface direct-source (fast lane) item metadata:

- **Source badges**: project=blue, manual=gray, direct=green (labeled 'Fast Lane')
- **triggeredBy**: shown as small secondary text below the item title when present
- **Escalated status**: amber/orange badge distinct from other statuses
- **Fast Lane filter**: tab/button to filter the list to only direct-source items

## Changes
- \`app/(app)/work-items/page.tsx\`: Source badge helper, status badge update for 'escalated', triggeredBy display, Fast Lane filter tab
- \`lib/types.ts\`: Added \`source\` and \`triggeredBy\` fields to WorkItem (if not already present)

## Testing
- TypeScript: \`npx tsc --noEmit\` passes
- Build: \`npm run build\` passes
- Existing project/manual item display is unchanged except for added source badge"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-direct-source-display
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker that cannot be resolved autonomously (e.g., `WorkItem` type is in a different location than expected, the work items page has a significantly different structure requiring architectural decisions, or `npm run build` fails with errors unrelated to this change):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "update-dashboard-direct-source-display",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/(app)/work-items/page.tsx", "lib/types.ts"]
    }
  }'
```