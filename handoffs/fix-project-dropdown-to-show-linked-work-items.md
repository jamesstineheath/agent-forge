<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Fix Project Dropdown to Show Linked Work Items

## Metadata
- **Branch:** `feat/fix-project-dropdown-linked-work-items`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/page.tsx, app/(app)/pipeline/page.tsx, app/(app)/work-items/page.tsx, lib/hooks.ts, components/ui/

## Context

The project dropdown in the Agent Forge dashboard is not showing linked work items. PR #139 attempted to fix this but was closed due to merge conflicts. This task re-implements the fix from scratch against current main.

The Agent Forge dashboard has a project dropdown (likely in the pipeline or dashboard view) that filters or displays work items associated with a project. The bug is that when a project is selected, the associated work items are not rendered/fetched correctly.

Key patterns in this repo:
- React data fetching is done via SWR hooks defined in `lib/hooks.ts`
- Work item CRUD lives in `lib/work-items.ts`
- The dashboard uses Next.js App Router (`app/(app)/`)
- Types are defined in `lib/types.ts` (WorkItem has a `projectId` or similar field linking it to a project)
- UI components are shadcn/ui in `components/ui/`

## Requirements

1. Identify the project dropdown component and the code path responsible for filtering/displaying linked work items.
2. Fix the bug so that selecting a project in the dropdown correctly shows all work items linked to that project.
3. Ensure the fix works for the pipeline view, dashboard, and any other view that uses the project dropdown filter.
4. Do not break existing functionality (work items with no project, the "all projects" / unfiltered view, etc.).
5. The fix must compile with zero TypeScript errors (`npx tsc --noEmit`).
6. The fix must not introduce new lint or build errors (`npm run build`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/fix-project-dropdown-linked-work-items
```

### Step 1: Understand the data model

Inspect the relevant types to understand how work items are linked to projects:

```bash
grep -n "projectId\|project_id\|projectName\|ProjectId" lib/types.ts
grep -n "WorkItem\|Project" lib/types.ts | head -60
```

Look for the `WorkItem` type — it should have a field like `projectId?: string` or `project?: string` that links it to a project.

Also check the Project type to understand what identifier is used:
```bash
grep -n "id\|name\|slug" lib/types.ts | head -40
```

### Step 2: Find the project dropdown and filtering logic

Search for where the project dropdown is rendered and where work items are filtered by project:

```bash
grep -rn "projectId\|project_id\|selectedProject\|projectFilter\|filterByProject" app/ components/ lib/ --include="*.tsx" --include="*.ts" | grep -v "node_modules"
grep -rn "dropdown\|Select.*project\|project.*Select\|ProjectDropdown\|projectDropdown" app/ components/ --include="*.tsx" | grep -v "node_modules"
grep -rn "work.item\|workItem\|work_item" app/(app)/page.tsx app/(app)/pipeline/page.tsx 2>/dev/null | head -40
```

Identify the exact file(s) containing the dropdown and the filtering/display logic.

### Step 3: Read the relevant source files in full

Once you've identified the relevant files (likely 1–3 files), read them carefully:

```bash
cat app/(app)/page.tsx
cat app/(app)/pipeline/page.tsx
cat lib/hooks.ts
cat lib/work-items.ts
```

Also check for any API route that fetches work items, since it may need a `projectId` query param:
```bash
cat app/api/work-items/route.ts 2>/dev/null || find app/api -name "route.ts" | xargs grep -l "work.item\|workItem" 2>/dev/null
```

### Step 4: Diagnose the bug

Common causes for a project dropdown not showing linked work items:

**A) Filter comparison mismatch** — e.g., comparing `item.projectId` (UUID) against `project.name` (string), or a case sensitivity issue:
```ts
// Bug: comparing wrong fields
workItems.filter(item => item.projectId === selectedProject.name)

// Fix: compare matching fields
workItems.filter(item => item.projectId === selectedProject.id)
```

**B) Missing/incorrect filter application** — the filter state is set but never applied to the rendered list:
```ts
// Bug: filtering original list but rendering unfiltered list
const filtered = workItems.filter(...);
return <WorkItemList items={workItems} />  // should be `filtered`

// Fix:
return <WorkItemList items={filtered} />
```

**C) SWR hook not passing project filter to API** — the hook fetches all work items regardless of selected project, but the UI expects pre-filtered results:
```ts
// lib/hooks.ts — may need to accept a projectId param
export function useWorkItems(projectId?: string) {
  const url = projectId ? `/api/work-items?projectId=${projectId}` : '/api/work-items';
  return useSWR<WorkItem[]>(url, fetcher);
}
```

**D) API route not filtering by projectId** — the API returns all work items regardless of query params:
```ts
// app/api/work-items/route.ts
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId');
  const items = await listWorkItems();
  const filtered = projectId ? items.filter(i => i.projectId === projectId) : items;
  return Response.json(filtered);
}
```

**E) Stale/missing re-fetch** — SWR cache is not invalidated when the selected project changes. The SWR key must change when the filter changes (passing `projectId` into the key fixes this automatically if using approach C above).

Apply whichever fix(es) match the actual bug found.

### Step 5: Implement the fix

Based on your diagnosis in Step 4, implement the minimal targeted fix. Do not refactor unrelated code.

If the bug is in the filter comparison (approach A or B), fix the relevant `.filter()` call in the component file.

If the bug requires a hook change (approach C), update `lib/hooks.ts`:
```ts
// Example: add optional projectId to useWorkItems
export function useWorkItems(projectId?: string) {
  const key = projectId ? `/api/work-items?projectId=${encodeURIComponent(projectId)}` : '/api/work-items';
  return useSWR<WorkItem[]>(key, fetcher);
}
```

If the API also needs updating (approach D), update the route handler to filter by `projectId` when provided.

Update call sites to pass the selected project ID:
```tsx
// In the component that has the dropdown:
const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>();
const { data: workItems } = useWorkItems(selectedProjectId);
```

### Step 6: Verify the fix compiles

```bash
npx tsc --noEmit
```

Fix any TypeScript errors before proceeding.

### Step 7: Build verification

```bash
npm run build
```

Ensure zero build errors.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "fix: project dropdown now correctly shows linked work items"
git push origin feat/fix-project-dropdown-linked-work-items
gh pr create \
  --title "fix: project dropdown shows linked work items" \
  --body "## Summary

Re-implements the fix from closed PR #139 (which had merge conflicts) against current main.

## Root Cause
[Fill in after diagnosis — describe which comparison/filter was broken]

## Fix
[Fill in — describe what was changed and why]

## Testing
- TypeScript: \`npx tsc --noEmit\` passes
- Build: \`npm run build\` passes
- Manually verified: selecting a project in the dropdown filters work items correctly
- Verified: unfiltered/all-projects view still works

Closes #139 (supersedes)"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/fix-project-dropdown-linked-work-items
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or remains unclear]
NEXT STEPS: [what remains to complete the fix]
```

## Escalation

If you cannot identify the dropdown component or the bug after thorough search, or if the fix requires architectural changes beyond a simple filter correction, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-project-dropdown-linked-work-items",
    "reason": "Cannot identify root cause of project dropdown filter bug after code inspection",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "4",
      "error": "Describe what you found and why you are blocked",
      "filesChanged": []
    }
  }'
```