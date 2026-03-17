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

1. `components/ui/button.tsx` — all size variants must render at minimum 44px height on viewports < 768px
2. `components/ui/button.tsx` — `icon` variant must be minimum 44×44px on mobile
3. `app/globals.css` — add scoped mobile CSS safety net for touch targets on interactive block-level elements
4. `app/globals.css` — ensure `input`, `select`, `textarea` elements have `font-size: 16px` on mobile to prevent iOS auto-zoom
5. `app/globals.css` — ensure body text is minimum 16px on mobile
6. Build must pass: `npm run build` exits 0

## Execution Steps

### Step 0: Branch setup