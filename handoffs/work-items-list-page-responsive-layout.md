# Agent Forge -- Work Items List Page Responsive Layout

## Metadata
- **Branch:** `feat/work-items-responsive-layout`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/work-items/page.tsx, components/work-item-row.tsx, components/work-item-card.tsx

## Context

The work items list page (`app/(app)/work-items/page.tsx`) currently displays work items in a tabular or list format optimized for desktop viewports. On mobile (390px), the multi-column layout causes horizontal scrolling and cramped UI. 

This is a UI-only change — no data fetching logic, API routes, or business logic changes are required. The goal is to make the page fully usable on mobile by switching to a card-based layout at narrow viewports, ensuring action buttons meet minimum touch target sizes, and making filter controls full-width.

The codebase uses **Tailwind CSS v4** and **shadcn/ui** components. Responsive patterns in this repo follow standard Tailwind breakpoint conventions (`md:` prefix for ≥768px).

## Requirements

1. At 390px viewport width, work items render as stacked cards with no horizontal scrolling
2. Each mobile card shows: title, status badge, repo name — prominently; priority and dates are secondary or hidden on mobile
3. All action buttons (dispatch, edit, delete, etc.) have a minimum height of 44px on mobile
4. Filter/search controls are full-width (`w-full`) on mobile, reverting to their default width at `md:` breakpoint
5. The page container uses `overflow-x-hidden` to prevent horizontal scroll
6. Desktop view (≥768px) remains unchanged — table or existing list layout preserved
7. No TypeScript errors introduced

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/work-items-responsive-layout
```

### Step 1: Audit the current work items page and components

Read the existing files to understand the current structure before making changes:

```bash
cat app/\(app\)/work-items/page.tsx
```

Also check for any referenced components:
```bash
ls components/ | grep -i work
ls components/ui/
```

Look for:
- How work items are rendered (table, div list, etc.)
- What columns/fields are shown per row
- Where action buttons live
- Where filter/search controls are defined

### Step 2: Add `overflow-x-hidden` to the page container

In `app/(app)/work-items/page.tsx`, locate the outermost container div and add `overflow-x-hidden`. Example:

```tsx
// Before
<div className="p-6 space-y-4">

// After
<div className="overflow-x-hidden p-6 space-y-4">
```

### Step 3: Make filter/search controls full-width on mobile

Locate any `<input>`, `<select>`, or filter wrapper divs. Apply `w-full md:w-auto` or adjust the filter row to wrap properly:

```tsx
// Filter row — stack on mobile, row on md+
<div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
  <Input
    placeholder="Search work items..."
    className="w-full md:w-64"
    // ...existing props
  />
  {/* Any select/filter dropdowns */}
  <Select ...>
    <SelectTrigger className="w-full md:w-40">
      ...
    </SelectTrigger>
  </Select>
</div>
```

### Step 4: Implement responsive work item rendering

This is the core change. The implementation depends on what the audit in Step 1 reveals:

#### Option A: If work items are rendered in a `<table>`

Hide non-essential columns on mobile using `hidden md:table-cell`, and ensure the table itself doesn't force horizontal scroll:

```tsx
<div className="overflow-x-auto md:overflow-x-visible">
  <table className="w-full min-w-0">
    <thead>
      <tr>
        <th className="text-left">Title</th>
        <th className="hidden md:table-cell text-left">Repo</th>
        <th className="text-left">Status</th>
        <th className="hidden md:table-cell text-left">Priority</th>
        <th className="hidden md:table-cell text-left">Created</th>
        <th className="text-left">Actions</th>
      </tr>
    </thead>
    <tbody>
      {workItems.map((item) => (
        <tr key={item.id}>
          <td className="py-2 pr-2">
            <div className="font-medium">{item.title}</div>
            {/* Show repo + priority inline on mobile */}
            <div className="md:hidden text-xs text-muted-foreground mt-0.5">
              {item.repo} · {item.priority}
            </div>
          </td>
          <td className="hidden md:table-cell py-2 pr-2">{item.repo}</td>
          <td className="py-2 pr-2">
            <StatusBadge status={item.status} />
          </td>
          <td className="hidden md:table-cell py-2 pr-2">{item.priority}</td>
          <td className="hidden md:table-cell py-2 pr-2">{item.createdAt}</td>
          <td className="py-2">
            <div className="flex gap-2">
              <Button className="min-h-[44px] min-w-[44px] px-3" ...>
                Dispatch
              </Button>
              {/* other action buttons */}
            </div>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

#### Option B: If work items are rendered as divs/cards already

Adjust the card layout to stack properly on mobile:

```tsx
{workItems.map((item) => (
  <div
    key={item.id}
    className="flex flex-col gap-2 p-4 border rounded-lg md:flex-row md:items-center md:justify-between"
  >
    {/* Primary info — always visible */}
    <div className="flex-1 min-w-0">
      <div className="font-medium truncate">{item.title}</div>
      <div className="flex flex-wrap items-center gap-2 mt-1">
        <StatusBadge status={item.status} />
        <span className="text-xs text-muted-foreground">{item.repo}</span>
        {/* Priority hidden on mobile, shown md+ */}
        <span className="hidden md:inline text-xs text-muted-foreground">
          {item.priority}
        </span>
      </div>
    </div>
    {/* Actions */}
    <div className="flex gap-2 flex-shrink-0">
      <Button
        size="sm"
        className="min-h-[44px] flex-1 md:flex-none"
        // ...
      >
        Dispatch
      </Button>
      {/* other buttons */}
    </div>
  </div>
))}
```

#### Option C: Create a dedicated mobile card layout alongside desktop table

Use a show/hide approach for clean separation:

```tsx
{/* Desktop table — hidden on mobile */}
<div className="hidden md:block">
  {/* existing table markup unchanged */}
</div>

{/* Mobile card list — shown only on mobile */}
<div className="md:hidden space-y-3">
  {workItems.map((item) => (
    <div key={item.id} className="border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-medium leading-tight">{item.title}</h3>
        <StatusBadge status={item.status} className="shrink-0" />
      </div>
      <p className="text-sm text-muted-foreground">{item.repo}</p>
      <div className="flex gap-2">
        <Button className="min-h-[44px] flex-1" variant="outline" size="sm">
          Edit
        </Button>
        <Button className="min-h-[44px] flex-1" size="sm">
          Dispatch
        </Button>
      </div>
    </div>
  ))}
</div>
```

**Choose the option that requires the least restructuring of existing code.** Option C is safest since it leaves the desktop table untouched.

### Step 5: Ensure action button touch targets

Review all `<Button>` components in the work items page and any work item list components. Add `min-h-[44px]` to any that don't already have it:

```tsx
// For icon-only buttons, ensure both min-h and min-w
<Button variant="ghost" size="icon" className="min-h-[44px] min-w-[44px]">
  <EditIcon className="h-4 w-4" />
</Button>

// For text buttons
<Button size="sm" className="min-h-[44px] px-4">
  Dispatch
</Button>
```

### Step 6: Handle any work item components in `components/`

If Step 1 reveals components like `components/work-item-row.tsx` or a similar file, apply the same responsive patterns there. The audit will reveal the exact structure.

### Step 7: Verification

```bash
# Type check
npx tsc --noEmit

# Build
npm run build
```

Manually verify the layout visually if possible, or review the markup changes to confirm:
- `overflow-x-hidden` is on the page container
- Filter inputs have `w-full` on mobile
- Mobile cards/rows show title + status badge + repo name
- All `<Button>` elements have `min-h-[44px]`
- Desktop layout (md:) is unchanged

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: responsive layout for work items list page

- Add overflow-x-hidden to page container
- Filter controls full-width on mobile (w-full md:w-auto)
- Work items render as stacked cards on mobile (<md breakpoint)
- Mobile cards show title, status badge, repo name
- All action buttons have min-h-[44px] touch targets
- Desktop table/list layout unchanged"

git push origin feat/work-items-responsive-layout

gh pr create \
  --title "feat: work items list page responsive layout" \
  --body "## Summary
Makes the work items list page fully usable on mobile (390px viewport).

## Changes
- \`overflow-x-hidden\` on page container prevents horizontal scroll
- Filter/search controls are \`w-full\` on mobile
- Work items display as stacked cards on mobile showing title, status badge, and repo name
- Action buttons have \`min-h-[44px]\` for adequate touch targets
- Desktop layout (md+) is preserved unchanged

## Acceptance Criteria
- [x] No horizontal scroll at 390px viewport width
- [x] Title and status badge visible on mobile without hiding meaning
- [x] Action buttons ≥44px height
- [x] Filter controls full-width on mobile
- [x] No TypeScript errors

## Risk
Low — UI-only changes, no logic or data fetching modified."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/work-items-responsive-layout
FILES CHANGED: [list files actually modified]
SUMMARY: [what responsive changes were applied]
ISSUES: [what couldn't be completed, e.g. "couldn't locate filter component"]
NEXT STEPS: [e.g. "apply min-h-[44px] to remaining action buttons in components/work-item-row.tsx"]
```