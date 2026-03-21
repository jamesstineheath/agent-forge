<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Dashboard: Settings Page with Kill Switch, Concurrency, FORCE_OPUS

## Metadata
- **Branch:** `feat/settings-page-kill-switch-concurrency-force-opus`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `app/(app)/settings/page.tsx`, `components/settings-kill-switch.tsx`, `components/settings-concurrency.tsx`, `components/settings-force-opus.tsx`, `lib/hooks.ts`

## Context

Agent Forge has a Settings page at `app/(app)/settings/page.tsx` that is currently a placeholder. PRD-53 AC-4 requires this page to be fully built out with three existing backend capabilities that already have API endpoints:

1. **Kill switch toggle** — currently lives in the Pipeline page header. It should be mirrored/moved to the Settings page for discoverability.
2. **Per-repo concurrency limits** — readable from the repos API (`/api/repos`), each repo has a `concurrencyLimit` field that should be editable.
3. **FORCE_OPUS toggle** — currently on the dashboard home. Should be moved to Settings.

All backend APIs already exist. This is a pure UI task connecting existing endpoints to a new Settings page.

### Existing patterns to follow

From recent PRs, the codebase uses:
- Next.js App Router pages in `app/(app)/`
- SWR for data fetching via `lib/hooks.ts`
- Tailwind CSS for styling
- Component-based architecture (`components/`)
- Fetch calls to `/api/*` routes with Bearer token auth for mutations

### Relevant existing API endpoints (already built):
- `GET /api/repos` — returns array of repo configs including `concurrencyLimit`
- `PATCH /api/repos/[id]` or similar — updates repo config including concurrency
- `GET /api/settings` or environment-driven kill switch/force opus toggles — check the existing pipeline page and dashboard home for how these are currently wired

### Key files to read first:
- `app/(app)/settings/page.tsx` — current placeholder
- `app/(app)/page.tsx` — dashboard home (has FORCE_OPUS toggle)
- `app/(app)/pipeline/page.tsx` — has kill switch toggle
- `lib/hooks.ts` — SWR hooks
- `app/api/repos/route.ts` — repos API
- Any `app/api/settings*` or `app/api/kill-switch*` routes

## Requirements

1. The Settings page at `/settings` must render three functional sections: Kill Switch, Per-Repo Concurrency, and FORCE_OPUS.
2. The kill switch toggle must be functionally equivalent to the one on the Pipeline page — same API call, same visual state (enabled/disabled with clear labeling).
3. The FORCE_OPUS toggle must be functionally equivalent to the one on the dashboard home — same API call, same visual state.
4. Per-repo concurrency must display each registered repo with its current `concurrencyLimit`, allow editing the value (numeric input), and save via the existing API.
5. All three sections must show loading states while data is being fetched.
6. All mutations must show optimistic UI or success/error feedback.
7. The kill switch and FORCE_OPUS controls on the Pipeline page and dashboard home respectively should remain in place (mirror, not move) — do not break existing UI.
8. TypeScript must compile with no errors (`npx tsc --noEmit`).
9. The page must be consistent with the existing app design system (Tailwind, same card/section patterns as other pages).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/settings-page-kill-switch-concurrency-force-opus
```

### Step 1: Audit existing implementations

Read the following files carefully before writing any code:

```bash
cat app/(app)/settings/page.tsx
cat "app/(app)/page.tsx"
cat "app/(app)/pipeline/page.tsx"
cat lib/hooks.ts
cat app/api/repos/route.ts
```

Also search for kill switch and FORCE_OPUS API routes:
```bash
find app/api -name "*.ts" | xargs grep -l -i "kill\|force_opus\|forceOpus\|settings" 2>/dev/null
grep -r "FORCE_OPUS\|forceOpus\|killSwitch\|kill_switch" app/ lib/ --include="*.ts" --include="*.tsx" -l
```

Document:
- Exact API endpoint URLs for kill switch toggle
- Exact API endpoint URL for FORCE_OPUS toggle
- Exact API endpoint URL for updating repo concurrency
- The shape of the response objects
- Any auth headers required

### Step 2: Create the Settings page layout

Replace the placeholder `app/(app)/settings/page.tsx` with a full settings page. Structure it as three distinct sections using the existing card/section patterns from other pages.

```tsx
// app/(app)/settings/page.tsx
// Three sections: Kill Switch, Force Opus, Per-Repo Concurrency
// Each section is a card with a title, description, and interactive control
```

The page should:
- Use `"use client"` since it has interactive controls
- Import and compose three child components (one per section)
- Have a clear page title "Settings" with a subtitle explaining this is where system-wide controls live

### Step 3: Implement SettingsKillSwitch component

Create `components/settings-kill-switch.tsx`:

```tsx
"use client";
// Props: none (fetches its own state)
// Behavior:
//   - Fetches current kill switch state from the same API the Pipeline page uses
//   - Renders a toggle with label "Pipeline Kill Switch"
//   - Description: "When enabled, no new work items will be dispatched. In-flight executions continue."
//   - Shows current state: green "Active" when OFF (pipeline running), red "HALTED" when ON (kill switch engaged)
//   - Toggle mutation calls the same endpoint the Pipeline page uses
//   - Loading skeleton while fetching
//   - Error state if fetch fails
```

Copy the exact fetch logic from `app/(app)/pipeline/page.tsx` — do not invent new API calls.

### Step 4: Implement SettingsForceOpus component

Create `components/settings-force-opus.tsx`:

```tsx
"use client";
// Props: none (fetches its own state)
// Behavior:
//   - Fetches current FORCE_OPUS state from the same API the dashboard home uses
//   - Renders a toggle with label "Force Opus Model"
//   - Description: "When enabled, all agent executions use Claude Opus regardless of per-handoff model selection. Higher quality, higher cost."
//   - Toggle mutation calls the same endpoint the dashboard home uses
//   - Loading skeleton while fetching
//   - Error state if fetch fails
```

Copy the exact fetch logic from `app/(app)/page.tsx` — do not invent new API calls.

### Step 5: Implement SettingsConcurrency component

Create `components/settings-concurrency.tsx`:

```tsx
"use client";
// Props: none (fetches its own state via /api/repos)
// Behavior:
//   - Fetches repo list from /api/repos
//   - For each repo, renders: repo name/owner, current concurrencyLimit as a numeric input (min 1, max 10)
//   - "Save" button per row (or a global "Save All" — match the style of the rest of the page)
//   - On save: PATCH to the repo update endpoint with new concurrencyLimit
//   - Shows success/error feedback per row after save attempt
//   - Loading skeleton while fetching
//   - Empty state if no repos registered
```

### Step 6: Wire up the Settings page

Update `app/(app)/settings/page.tsx` to import and render all three components:

```tsx
import { SettingsKillSwitch } from "@/components/settings-kill-switch";
import { SettingsForceOpus } from "@/components/settings-force-opus";
import { SettingsConcurrency } from "@/components/settings-concurrency";

export default function SettingsPage() {
  return (
    <div className="...">  {/* match padding/layout of other app pages */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">
          System-wide controls for the Agent Forge pipeline.
        </p>
      </div>
      <div className="space-y-6">
        <SettingsKillSwitch />
        <SettingsForceOpus />
        <SettingsConcurrency />
      </div>
    </div>
  );
}
```

### Step 7: Add SWR hooks if needed

If the existing `lib/hooks.ts` doesn't already have hooks for kill switch state, FORCE_OPUS state, or repos, add them following the existing pattern in that file. Only add what's missing — reuse existing hooks if they exist.

### Step 8: Verify existing controls are untouched

Confirm the Pipeline page kill switch and dashboard home FORCE_OPUS toggle still work:

```bash
grep -n "killSwitch\|kill_switch\|KillSwitch" "app/(app)/pipeline/page.tsx"
grep -n "FORCE_OPUS\|forceOpus\|ForceOpus" "app/(app)/page.tsx"
```

Both should still be present and unchanged.

### Step 9: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors before proceeding. Common issues:
- Missing type imports
- Incorrect API response shapes (check the actual API route return types)
- Hook return type mismatches

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "feat: Settings page with kill switch, concurrency, and FORCE_OPUS toggles (PRD-53 AC-4)"
git push origin feat/settings-page-kill-switch-concurrency-force-opus
gh pr create \
  --title "feat: Settings page with kill switch, concurrency, FORCE_OPUS (PRD-53 AC-4)" \
  --body "## Summary

Implements PRD-53 AC-4: builds out the Settings page (previously a placeholder) with three functional control sections.

## Changes

- \`app/(app)/settings/page.tsx\` — replaces placeholder with full settings layout
- \`components/settings-kill-switch.tsx\` — mirrors kill switch from Pipeline page
- \`components/settings-force-opus.tsx\` — mirrors FORCE_OPUS toggle from dashboard home
- \`components/settings-concurrency.tsx\` — per-repo concurrency limit editor (reads /api/repos, saves via PATCH)

## Behavior

- Kill switch and FORCE_OPUS controls on their original pages are **unchanged** (mirrored, not moved)
- All three sections show loading skeletons while fetching
- Mutations show success/error feedback
- TypeScript clean, build passes

## AC Checklist (PRD-53 AC-4)

- [x] Kill switch toggle present and functional on Settings page
- [x] Per-repo concurrency limits readable and editable
- [x] FORCE_OPUS toggle present and functional on Settings page
- [x] Existing controls on Pipeline + Dashboard home untouched
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
BRANCH: feat/settings-page-kill-switch-concurrency-force-opus
FILES CHANGED: [list what was created/modified]
SUMMARY: [what was implemented]
ISSUES: [what failed or was skipped]
NEXT STEPS: [e.g. "SettingsConcurrency save handler needs PATCH endpoint URL confirmed — check app/api/repos/[id]/route.ts"]
```

## Escalation Protocol

If you cannot find the kill switch API endpoint, FORCE_OPUS API endpoint, or repo PATCH endpoint after searching the codebase, escalate rather than inventing new API routes:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "settings-page-kill-switch-concurrency-force-opus",
    "reason": "Cannot locate API endpoint for [kill switch | FORCE_OPUS | repo PATCH] after full codebase search. Need endpoint URL and request shape before implementing Settings page controls.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 1 - Audit",
      "error": "Endpoint not found in app/api/ after grep search",
      "filesChanged": []
    }
  }'
```