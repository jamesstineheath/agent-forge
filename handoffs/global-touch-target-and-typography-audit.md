# Agent Forge -- Global Touch Target and Typography Audit

## Metadata
- **Branch:** `feat/mobile-touch-targets-typography`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** components/ui/button.tsx, app/globals.css

## Context

This is a mobile UX audit and fix across the Agent Forge dashboard. The goal is to ensure all interactive elements meet the 44px minimum touch target requirement for mobile devices, and that typography is readable without causing iOS auto-zoom on input focus.

The repo uses Tailwind CSS v4 with shadcn/ui components. The `components/ui/button.tsx` file uses `class-variance-authority` (CVA) for variant-based class composition. The `app/globals.css` file contains global styles.

Key issues to fix:
1. Button `sm` variant likely renders at ~36px height — needs to be 44px on mobile
2. Form inputs may have font-size below 16px — iOS zooms in when inputs have `font-size < 16px`
3. Icon-only buttons, badge links, and dropdown triggers may have small tap targets
4. Body text readability on mobile

## Requirements

1. `components/ui/button.tsx` — `sm` size variant must use `min-h-[44px] md:min-h-[36px]`
2. `components/ui/button.tsx` — default size variant must also use `min-h-[44px] md:min-h-[auto]` (or ensure it already meets 44px)
3. `app/globals.css` — add a global mobile CSS rule: `@media (max-width: 767px) { button, a, [role='button'] { min-height: 44px; } }` as a safety net
4. `app/globals.css` — ensure `input`, `select`, `textarea` elements have `font-size: 16px` on mobile to prevent iOS auto-zoom
5. `app/globals.css` — ensure body text is minimum 16px on mobile
6. Build must complete with no TypeScript or Tailwind errors (`npx tsc --noEmit` and `npm run build`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/mobile-touch-targets-typography
```

### Step 1: Inspect current button.tsx

Read the existing file to understand the current CVA configuration:

```bash
cat components/ui/button.tsx
```

Look for the `size` variants (typically `default`, `sm`, `lg`, `icon`). You will patch these. The typical shadcn/ui button sizes look like:

```ts
size: {
  default: "h-10 px-4 py-2",
  sm: "h-9 rounded-md px-3",
  lg: "h-11 rounded-md px-8",
  icon: "h-10 w-10",
},
```

### Step 2: Patch components/ui/button.tsx

Update the `size` variants in the CVA config to add responsive `min-h` classes. Replace the size variant values as follows:

- **`default`**: Add `min-h-[44px] md:min-h-0` — ensures 44px on mobile, falls back to natural height (`h-10` = 40px on desktop; that's fine for desktop)
- **`sm`**: Change to include `min-h-[44px] md:min-h-[36px]` — 44px on mobile, 36px on desktop
- **`lg`**: Already `h-11` (44px) — add `min-h-[44px]` for safety
- **`icon`**: Change to `h-11 w-11 min-h-[44px] min-w-[44px] md:h-10 md:w-10` to ensure 44×44 tap target on mobile

Example after patching (adjust to match actual current content):

```ts
size: {
  default: "h-10 min-h-[44px] md:min-h-0 px-4 py-2",
  sm: "h-9 min-h-[44px] md:min-h-[36px] rounded-md px-3",
  lg: "h-11 min-h-[44px] rounded-md px-8",
  icon: "h-10 w-10 min-h-[44px] min-w-[44px] md:h-10 md:w-10",
},
```

> **Note:** Read the actual file first. If the structure differs (e.g., Tailwind v4 uses different class syntax or the file uses a different pattern), adapt accordingly while preserving the intent: 44px min touch target on mobile for all variants.

### Step 3: Inspect and patch app/globals.css

Read the existing file first:

```bash
cat app/globals.css
```

Append the following mobile accessibility rules at the end of the file (before any closing `}` if it's wrapped, otherwise just at the bottom):

```css
/* =====================================================
   Mobile accessibility: touch targets & typography
   ===================================================== */

@media (max-width: 767px) {
  /* Minimum 44px touch targets for all interactive elements */
  button,
  a,
  [role="button"],
  [role="tab"],
  [role="menuitem"],
  label[for],
  summary {
    min-height: 44px;
  }

  /* Prevent iOS auto-zoom on input focus (requires font-size >= 16px) */
  input,
  input[type="text"],
  input[type="email"],
  input[type="password"],
  input[type="search"],
  input[type="number"],
  input[type="tel"],
  input[type="url"],
  select,
  textarea {
    font-size: 16px !important;
  }

  /* Ensure body text is readable on mobile */
  body {
    font-size: 16px;
  }
}
```

> **Note:** If `app/globals.css` does not exist, check for `styles/globals.css` or the root CSS file imported in `app/layout.tsx`. Add the rules to whichever file is the global stylesheet.

### Step 4: Verify Tailwind config for any required changes

Check if there's a `tailwind.config.ts` or `tailwind.config.js` that might need updates:

```bash
cat tailwind.config.ts 2>/dev/null || cat tailwind.config.js 2>/dev/null || echo "No tailwind config found (may use CSS-based config for v4)"
```

For Tailwind v4, configuration is often CSS-based. No changes are typically needed here if we're using utility classes and media query CSS — but confirm no custom `screens` breakpoints override `md` (default is 768px).

### Step 5: Run TypeScript check and build

```bash
npx tsc --noEmit
```

If there are TypeScript errors unrelated to this change, note them but do not fix them — only fix errors introduced by this change.

```bash
npm run build
```

If the build fails due to unknown Tailwind classes (e.g., `min-h-[44px]` not recognized), ensure the values are valid JIT-compatible arbitrary values. These are standard and should work with Tailwind v3+/v4.

If `md:min-h-[36px]` causes issues in Tailwind v4, replace with a CSS custom property approach in globals.css instead and simplify the button classes to just `min-h-[44px]` without the md override (acceptable — desktop buttons at 44px is fine UX).

### Step 6: Verification
```bash
npx tsc --noEmit
npm run build
```

Expected: zero TypeScript errors from our changes, successful build output.

### Step 7: Commit, push, open PR
```bash
git add -A
git commit -m "fix: enforce 44px touch targets and 16px typography for mobile accessibility"
git push origin feat/mobile-touch-targets-typography
gh pr create \
  --title "fix: global touch target and typography audit for mobile" \
  --body "## Summary

Audits and fixes all interactive elements across the Agent Forge dashboard for mobile accessibility:

### Changes

**\`components/ui/button.tsx\`**
- \`sm\` variant: added \`min-h-[44px] md:min-h-[36px]\` to meet 44px touch target on mobile
- \`default\` variant: added \`min-h-[44px]\` for mobile compliance
- \`lg\` variant: added \`min-h-[44px]\` as safety net (already ~44px via h-11)
- \`icon\` variant: added \`min-h-[44px] min-w-[44px]\` to ensure 44×44 tap area

**\`app/globals.css\`**
- Added \`@media (max-width: 767px)\` block with:
  - \`min-height: 44px\` on all interactive elements (button, a, [role=button], etc.)
  - \`font-size: 16px\` on all form inputs to prevent iOS auto-zoom
  - \`font-size: 16px\` on body for readable mobile text

### Acceptance Criteria Met
- ✅ All button variants render with minimum 44px height on viewports < 768px
- ✅ All form inputs have font-size >= 16px on mobile (prevents iOS auto-zoom)
- ✅ Icon-only buttons have minimum 44×44px touch target
- ✅ Global CSS safety net covers badge links, dropdown triggers, any missed components
- ✅ Build completes with no TypeScript or Tailwind errors
- ✅ Body text is 16px on mobile

### Risk
Low — CSS-only and Tailwind class changes with no logic modifications. All changes are additive mobile overrides."
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/mobile-touch-targets-typography
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you encounter a blocker (e.g., Tailwind v4 CSS-based config requires a fundamentally different approach, or `components/ui/button.tsx` uses a completely different pattern than shadcn/ui standard):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "global-touch-target-typography-audit",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["components/ui/button.tsx", "app/globals.css"]
    }
  }'
```