# Agent Forge -- Pipeline/ATC Timeline Page Responsive Layout

## Metadata
- **Branch:** `feat/pipeline-responsive-layout`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/pipeline/page.tsx

## Context

The pipeline page (`app/(app)/pipeline/page.tsx`) shows active executions, ATC state, and potentially a timeline/swimlane visualization. Currently, the layout is not optimized for mobile viewports (390px width), likely causing horizontal overflow and cramped displays.

This is a purely cosmetic/layout change — no logic, API, or data model changes. The goal is to apply Tailwind responsive utilities to make the existing content stack gracefully on narrow screens while preserving desktop layout behavior.

Agent Forge uses Tailwind CSS v4 with the standard responsive prefix conventions (`md:`, `lg:`, etc.).

## Requirements

1. Multi-column grid layouts must collapse to single column on mobile (`grid-cols-1 md:grid-cols-2` or similar)
2. At 390px viewport width, no page-level horizontal scrolling
3. Long branch names and PR URLs must be truncated or wrapped without causing overflow (`truncate` or `break-words`)
4. If a timeline or swimlane visualization exists, it must scroll horizontally within its own container only (`overflow-x-auto` on the timeline wrapper, NOT on the page/body)
5. Status indicators and execution cards must be full-width on mobile
6. Page must have minimum 16px horizontal padding on mobile (`px-4 md:px-6`)
7. All text remains readable and status indicators are clearly visible at 390px

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/pipeline-responsive-layout
```

### Step 1: Read the current pipeline page

Read the full file contents to understand existing layout structure before making any changes:

```bash
cat app/(app)/pipeline/page.tsx
```

Also check if there are any sub-components or imported components specific to the pipeline page:

```bash
grep -r "pipeline" components/ --include="*.tsx" -l 2>/dev/null || true
ls app/\(app\)/pipeline/ 2>/dev/null || true
```

### Step 2: Apply responsive layout changes to `app/(app)/pipeline/page.tsx`

Based on what you find in Step 1, apply the following responsive patterns. Match the patterns to the actual structure found — do NOT blindly replace, read the file first.

**Pattern A — Page wrapper / top-level container:**
Find the outermost `div` wrapping the page content. Ensure it has mobile padding:
```tsx
// Before (example):
<div className="p-6">
// After:
<div className="px-4 md:px-6 py-6">
```

**Pattern B — Multi-column grids:**
Any `grid-cols-2`, `grid-cols-3`, or similar fixed-column grids should be made responsive:
```tsx
// Before (example):
<div className="grid grid-cols-2 gap-4">
// After:
<div className="grid grid-cols-1 md:grid-cols-2 gap-4">

// Before:
<div className="grid grid-cols-3 gap-4">
// After:
<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
```

**Pattern C — Execution cards / work item cards:**
Cards that sit in a flex row or fixed-width layout should be full-width on mobile:
```tsx
// Before (example):
<div className="flex gap-4">
  <div className="w-64 ...">
// After:
<div className="flex flex-col md:flex-row gap-4">
  <div className="w-full md:w-64 ...">
```

**Pattern D — Timeline or swimlane visualization:**
If a timeline, swimlane, or any wide visualization component exists, wrap it in a scrollable container but do NOT make the page scroll:
```tsx
// Wrap the timeline element:
<div className="overflow-x-auto w-full">
  {/* existing timeline component/div */}
</div>
```
The timeline inner container should keep its `min-width` or fixed width — do not change the visualization's internal sizing.

**Pattern E — Long text (branch names, PR URLs, repo names):**
Any element displaying branch names, PR URLs, commit SHAs, or long identifiers:
```tsx
// Before (example):
<span className="text-sm text-gray-600">{item.branch}</span>
// After:
<span className="text-sm text-gray-600 truncate max-w-full block">{item.branch}</span>

// For links:
<a href={item.prUrl} className="text-blue-600 truncate block max-w-full">{item.prUrl}</a>
```

**Pattern F — Flex rows that wrap poorly on mobile:**
Any `flex` rows containing multiple pieces of metadata that would overflow:
```tsx
// Before:
<div className="flex items-center gap-4">
  <span>Status</span><span>Branch</span><span>Duration</span>
// After:
<div className="flex flex-wrap items-center gap-2 md:gap-4">
  <span>Status</span><span>Branch</span><span>Duration</span>
```

**Pattern G — Status indicators:**
Status badges/pills should remain legible. If inside a flex container that wraps, ensure they don't get squished:
```tsx
// Add flex-shrink-0 to status badges so they don't compress:
<span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium flex-shrink-0 ...">
  {status}
</span>
```

### Step 3: Verify no TypeScript errors

```bash
npx tsc --noEmit
```

Fix any TypeScript errors before proceeding. The changes should be purely className string updates, so errors would be unusual — but check anyway.

### Step 4: Build check

```bash
npm run build
```

Resolve any build errors. Layout changes should not produce build errors unless a className was accidentally malformed.

### Step 5: Visual sanity check

Review the diff to confirm:
- No logic was changed, only `className` attributes
- No new imports were added (unless a layout wrapper component was needed)
- The structure/JSX hierarchy is unchanged
- Every `overflow-x-auto` is on a specific container, NOT on `body`, `html`, or the top-level page wrapper

```bash
git diff app/\(app\)/pipeline/page.tsx
```

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "fix: make pipeline page responsive for mobile viewports

- Collapse multi-column grids to single column on mobile
- Add px-4 md:px-6 mobile padding to page wrapper
- Truncate long branch names and PR URLs to prevent overflow
- Wrap timeline/swimlane visualization in overflow-x-auto container
- Add flex-wrap and flex-shrink-0 to status indicators and metadata rows
- Execution cards stack full-width on mobile

Resolves mobile viewport overflow at 390px width"

git push origin feat/pipeline-responsive-layout

gh pr create \
  --title "fix: pipeline page responsive layout for mobile viewports" \
  --body "## Summary

Makes the pipeline/ATC page responsive for 390px+ mobile viewports.

## Changes
- Multi-column grids collapse to single column on mobile (\`grid-cols-1 md:grid-cols-N\`)
- Page wrapper gets \`px-4 md:px-6\` mobile padding
- Long branch names and PR URLs use \`truncate\` to prevent horizontal overflow
- Timeline/swimlane visualization (if present) wrapped in \`overflow-x-auto\` container
- Flex rows get \`flex-wrap\` to prevent overflow on narrow screens
- Status badges get \`flex-shrink-0\` to stay legible

## Acceptance Criteria
- [x] At 390px, pipeline cards stack vertically with no page-level horizontal scroll
- [x] Branch names and PR URLs truncate without causing overflow
- [x] Timeline scrolls within its own container only
- [x] Status indicators visible and readable at 390px
- [x] Minimum 16px horizontal padding on mobile

## Risk
Low — className-only changes, no logic modified."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/pipeline-responsive-layout
FILES CHANGED: [app/(app)/pipeline/page.tsx]
SUMMARY: [what was done]
ISSUES: [what failed or was left incomplete]
NEXT STEPS: [remaining patterns to apply from Step 2]
```

## Escalation

If the pipeline page file does not exist at `app/(app)/pipeline/page.tsx`, or the file structure is fundamentally different from standard Next.js App Router layout (e.g., it's a client component with a completely custom canvas-based timeline requiring non-Tailwind changes), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "pipeline-responsive-layout",
    "reason": "Pipeline page structure incompatible with Tailwind-only responsive approach — may require canvas/SVG timeline rework or component restructuring beyond scope",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "2",
      "error": "File structure or timeline implementation requires non-trivial architectural changes",
      "filesChanged": []
    }
  }'
```