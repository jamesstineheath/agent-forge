# Agent Forge -- Repos and Settings Pages Responsive Layout

## Metadata
- **Branch:** `feat/repos-settings-responsive-layout`
- **Priority:** medium
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/(app)/repos/page.tsx, app/(app)/settings/page.tsx

## Context

The Agent Forge dashboard has a pipeline page that was recently made responsive (see merged PR "fix: pipeline page responsive layout for mobile viewports"). This task applies the same responsive treatment to two remaining pages:

1. **Repos page** (`app/(app)/repos/page.tsx`) — displays registered target repositories with metadata (concurrency limits, status, last sync). Currently likely uses a grid or flex layout that may overflow on narrow viewports.
2. **Settings page** (`app/(app)/settings/page.tsx`) — contains configuration forms/cards. Form inputs may not be full-width on mobile and buttons may lack sufficient touch targets.

The stack is Next.js App Router with Tailwind CSS v4 and shadcn/ui components. Follow the same responsive patterns used in the pipeline page fix.

## Requirements

1. Repo cards use `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3` so they stack in a single column at 390px viewport width
2. Repo card metadata (name, status, concurrency limits, last sync) remains visible and readable on mobile without zooming or horizontal scrolling
3. Both pages use `px-4 md:px-6` for consistent mobile padding
4. Settings form inputs are full-width on mobile (`w-full`)
5. All form inputs and buttons on both pages have a minimum height of 44px (`min-h-[44px]`)
6. No horizontal overflow on either page at 390px viewport width
7. All text remains legible (no overflow ellipsis that hides critical info on mobile)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/repos-settings-responsive-layout
```

### Step 1: Inspect current repos page

Read the current file to understand its structure before making changes:

```bash
cat app/\(app\)/repos/page.tsx
```

### Step 2: Update repos page for mobile responsiveness

Open `app/(app)/repos/page.tsx` and apply the following changes:

**Page container:** Add `px-4 md:px-6` to the top-level container. If there is an existing `px-6` or `p-6`, change it to `px-4 md:px-6`.

**Repo cards grid:** Replace any existing grid or flex layout wrapping the repo cards with:
```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {/* repo cards */}
</div>
```

**Individual repo cards:** Ensure each card:
- Does NOT use fixed widths (remove any `w-[Xpx]` or `min-w-[Xpx]`)
- Uses `w-full` so it fills its grid cell
- Metadata rows (name, status, concurrency, last sync) use `flex flex-wrap gap-x-4 gap-y-1` or a vertical stack so they don't overflow
- Status badges and text use `text-sm` or smaller to fit mobile widths
- Action buttons (edit, delete, etc.) have `min-h-[44px]` and `min-w-[44px]`

**Example card structure to target:**
```tsx
<div className="w-full rounded-lg border bg-card p-4 flex flex-col gap-3">
  <div className="flex items-start justify-between gap-2">
    <h3 className="font-semibold text-sm leading-tight break-all">{repo.name}</h3>
    <StatusBadge ... />
  </div>
  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <span>Concurrency: {repo.concurrencyLimit}</span>
    <span>Last sync: {repo.lastSync}</span>
  </div>
  <div className="flex gap-2 mt-auto">
    <Button size="sm" className="min-h-[44px] flex-1">Edit</Button>
    {/* other actions */}
  </div>
</div>
```

Adapt to match the actual component structure found in the file — do not restructure unnecessarily, just apply responsive classes.

### Step 3: Inspect current settings page

```bash
cat app/\(app\)/settings/page.tsx
```

### Step 4: Update settings page for mobile responsiveness

Open `app/(app)/settings/page.tsx` and apply the following changes:

**Page container:** Ensure `px-4 md:px-6` is on the outermost container.

**Settings cards/sections:** Each settings card or section should be `w-full`. Remove any `max-w-` constraints that would cause side-scrolling on small viewports (but keep `max-w-` on inner form elements if they're centering content, not causing overflow).

**Form inputs:** All `<Input>`, `<Select>`, `<Textarea>` elements should have:
```tsx
className="w-full min-h-[44px] ..."
```
If using shadcn/ui `Input`, add `className="min-h-[44px]"` since shadcn inputs default to `h-9` (36px).

**Labels + inputs:** Use vertical stacking on mobile:
```tsx
<div className="flex flex-col gap-1.5">
  <Label htmlFor="...">...</Label>
  <Input id="..." className="w-full min-h-[44px]" />
</div>
```

**Multi-column form rows:** If any row uses `grid grid-cols-2` or `flex` for side-by-side fields, change to `grid grid-cols-1 md:grid-cols-2`.

**Buttons:** All `<Button>` elements should have `min-h-[44px]`. For submit/save buttons that span a row, add `w-full md:w-auto` so they're full-width on mobile.

**Example settings section:**
```tsx
<div className="rounded-lg border bg-card p-4 md:p-6 flex flex-col gap-4">
  <h2 className="font-semibold">Section Title</h2>
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="field1">Field 1</Label>
      <Input id="field1" className="w-full min-h-[44px]" />
    </div>
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="field2">Field 2</Label>
      <Input id="field2" className="w-full min-h-[44px]" />
    </div>
  </div>
  <Button className="min-h-[44px] w-full md:w-auto">Save</Button>
</div>
```

Adapt to match the actual component structure.

### Step 5: Verification

```bash
npx tsc --noEmit
npm run build
```

Confirm both commands complete without errors. If TypeScript errors appear that are pre-existing (not introduced by this PR), note them but do not fix them — stay focused on the responsive layout changes.

### Step 6: Commit, push, open PR

```bash
git add -A
git commit -m "fix: repos and settings pages responsive layout for mobile viewports"
git push origin feat/repos-settings-responsive-layout
gh pr create \
  --title "fix: repos and settings pages responsive layout for mobile viewports" \
  --body "## Summary
Makes the repos and settings pages responsive for mobile viewports (390px+).

## Changes

### Repos page (\`app/(app)/repos/page.tsx\`)
- Repo cards grid: \`grid-cols-1 md:grid-cols-2 lg:grid-cols-3\` — single column on mobile
- Metadata (name, status, concurrency, last sync) remains visible without horizontal scrolling
- Action buttons have \`min-h-[44px]\` touch targets
- Page padding: \`px-4 md:px-6\`

### Settings page (\`app/(app)/settings/page.tsx\`)
- Form inputs are full-width with \`min-h-[44px]\`
- Multi-column rows collapse to single column on mobile
- Buttons have \`min-h-[44px]\` touch targets; save buttons full-width on mobile
- Page padding: \`px-4 md:px-6\`

## Acceptance Criteria Verified
- [ ] Repo cards stack in single column at 390px with no horizontal overflow
- [ ] Repo metadata readable on mobile without zooming
- [ ] Settings inputs full-width with 44px min height
- [ ] All buttons have 44px min touch targets
- [ ] No horizontal overflow on either page at 390px
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/repos-settings-responsive-layout
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., the pages use a component library pattern that conflicts with these responsive classes, or the files don't exist at the expected paths), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "repos-settings-responsive-layout",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["app/(app)/repos/page.tsx", "app/(app)/settings/page.tsx"]
    }
  }'
```