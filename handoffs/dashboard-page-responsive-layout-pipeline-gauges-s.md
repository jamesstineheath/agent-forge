# Agent Forge -- Dashboard Page Responsive Layout (Pipeline Gauges + Stats)

## Metadata
- **Branch:** `feat/dashboard-responsive-layout`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/page.tsx

## Context

The main dashboard page (`app/(app)/page.tsx`) needs to be made responsive for mobile viewports (minimum 390px width). The dashboard contains a grid of stat cards and pipeline gauges that currently use fixed column counts, causing horizontal overflow or illegible content on narrow screens.

The goal is to apply standard Tailwind CSS responsive utilities so that:
- Mobile (< 640px): single column, full-width cards, 16px horizontal padding
- Small tablet+ (≥ 640px): 2-column grid
- Desktop (≥ 1024px): 3-column grid (or the existing desktop layout)

No new components or logic changes are needed — this is purely a Tailwind class adjustment task.

## Requirements

1. All grid containers in `app/(app)/page.tsx` must use responsive column classes (e.g., `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`) instead of fixed column counts
2. All stat cards and pipeline gauge cards must be `w-full` with no fixed pixel widths that cause horizontal scroll
3. The page wrapper must have `px-4 md:px-6` (or equivalent) horizontal padding on mobile
4. At 390px viewport width, all content stacks vertically in a single column with no horizontal scrolling
5. At 640px+ viewport width, cards arrange in at least a 2-column grid
6. Pipeline status summary/gauges must be readable without zooming at 390px width
7. No content is clipped or overflows the viewport at 390px width

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-responsive-layout
```

### Step 1: Inspect the current dashboard layout

Read the file to understand its current structure:
```bash
cat app/\(app\)/page.tsx
```

Look for:
- Outer wrapper/container div classes (padding, max-width)
- Grid containers (`grid grid-cols-*`)
- Individual card components and their width classes
- Any hardcoded `w-[Npx]` or `min-w-*` classes
- Pipeline gauge/stat sections

### Step 2: Apply responsive layout changes to `app/(app)/page.tsx`

Make the following targeted changes based on what you find in Step 1:

**A. Page wrapper padding:**
Find the outermost content container and ensure it has responsive horizontal padding. Replace or add:
```
px-4 md:px-6
```
If there's already a `p-*` or `px-*` class, adjust it to be mobile-friendly. Example:
```tsx
// Before (example)
<div className="p-6">
// After
<div className="px-4 md:px-6 py-6">
```

**B. Stat card grids:**
Find any grid with fixed columns like `grid-cols-2`, `grid-cols-3`, `grid-cols-4` and make them responsive:
```tsx
// Before (example)
<div className="grid grid-cols-3 gap-4">
// After
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
```

For 4-column grids:
```tsx
// Before
<div className="grid grid-cols-4 gap-4">
// After
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
```

For 2-column grids:
```tsx
// Before
<div className="grid grid-cols-2 gap-4">
// After
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

**C. Fixed-width cards:**
Replace any `w-[Npx]` or `min-w-[Npx]` on cards with `w-full`:
```tsx
// Before
<div className="w-[320px] ...">
// After
<div className="w-full ...">
```

**D. Pipeline gauge/status section:**
If the pipeline section uses a flex row or fixed columns, make it stack on mobile:
```tsx
// Before (example)
<div className="flex gap-4">
// After
<div className="flex flex-col sm:flex-row gap-4">
```
Or if it's a grid:
```tsx
// Before
<div className="grid grid-cols-3 gap-6">
// After
<div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
```

**E. Text and overflow safety:**
Ensure no text elements have `whitespace-nowrap` without a paired `truncate` or `overflow-hidden` on the container. Add `overflow-hidden` or `min-w-0` to flex children as needed to prevent text overflow.

Apply all changes to `app/(app)/page.tsx` following exactly the patterns found in the actual file content.

### Step 3: Check for any related component files

If the dashboard imports card components that have fixed widths, check those files:
```bash
# Find component imports in the dashboard
grep -n "import" app/\(app\)/page.tsx | head -30
```

If any imported components (e.g., `components/stat-card.tsx`, `components/pipeline-gauge.tsx`) have hardcoded fixed widths that would cause horizontal scroll at 390px, update those files as well using the same `w-full` approach.

### Step 4: Verification
```bash
# Type check
npx tsc --noEmit

# Build check
npm run build
```

Both commands must complete without errors. If there are pre-existing type errors unrelated to this change, note them in the PR but do not let them block the PR.

### Step 5: Commit, push, open PR
```bash
git add -A
git commit -m "feat: make dashboard page responsive for mobile viewports

- Convert fixed grid-cols to responsive grid-cols-1 sm:grid-cols-2 lg:grid-cols-3
- Add px-4 md:px-6 padding for mobile breathing room
- Ensure cards use w-full with no fixed pixel widths
- Stack pipeline gauges vertically on mobile with flex-col sm:flex-row
- No content overflows at 390px viewport width

Closes: dashboard responsive layout"
git push origin feat/dashboard-responsive-layout
gh pr create \
  --title "feat: dashboard page responsive layout (pipeline gauges + stats)" \
  --body "## Summary
Makes the main dashboard page (\`app/(app)/page.tsx\`) responsive for mobile viewports (390px minimum).

## Changes
- Converted fixed grid column counts to responsive: \`grid-cols-1 sm:grid-cols-2 lg:grid-cols-3\`
- Added \`px-4 md:px-6\` horizontal padding to the page wrapper
- Ensured all stat cards and pipeline gauge cards use \`w-full\`
- Pipeline status section stacks vertically on mobile

## Acceptance Criteria
- [x] At 390px viewport width, all dashboard cards stack in a single column with no horizontal scroll
- [x] At 640px+, cards arrange in a 2-column grid
- [x] Pipeline gauges/stats readable without zooming at 390px
- [x] Minimum 16px horizontal padding on mobile
- [x] No content clipped or overflowing at 390px

## Risk
Low — Tailwind class changes only, no logic or data changes."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-responsive-layout
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```