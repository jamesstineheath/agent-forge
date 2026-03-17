# Agent Forge -- Viewport Meta Tag and Global Responsive Foundation

## Metadata
- **Branch:** `feat/viewport-responsive-foundation`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/layout.tsx, app/globals.css

## Context

Agent Forge is a Next.js 16 App Router project on Vercel. A responsive UI pass is underway across all pages (recent PRs show mobile sidebar, responsive layouts for dashboard and work items). This safety-net item ensures the foundational viewport meta tag and global CSS rules are correct so all responsive work renders properly on mobile devices.

Next.js App Router exposes viewport configuration via the `metadata` or `viewport` export in `app/layout.tsx`. The root layout may already have a `metadata` export but might be missing the explicit viewport configuration. `app/globals.css` uses Tailwind CSS v4 — Tailwind's preflight sets `box-sizing: border-box` globally, but `overflow-x: hidden` and iOS scroll smoothness need to be added explicitly.

## Requirements

1. `app/layout.tsx` must export a `viewport` object (Next.js 14+ `Viewport` type from `next`) with `width: 'device-width'` and `initialScale: 1`
2. `app/globals.css` must set `overflow-x: hidden` on both `html` and `body`
3. `app/globals.css` must set `scroll-behavior: smooth` on `html`
4. `app/globals.css` must set `-webkit-overflow-scrolling: touch` on `body`
5. The root layout must not have any fixed-pixel width on the top-level container — it must use `w-full` or `max-w-full`
6. Build completes with no TypeScript errors (`npx tsc --noEmit` passes)
7. `npm run build` succeeds

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/viewport-responsive-foundation
```

### Step 1: Inspect current root layout and globals

Read the current files to understand what already exists before making changes:

```bash
cat app/layout.tsx
cat app/globals.css
```

### Step 2: Update `app/layout.tsx`

Next.js 14+ App Router supports a dedicated `viewport` export separate from `metadata`. Add or update it.

Open `app/layout.tsx` and make the following changes:

**a) Import `Viewport` type** (add to existing next imports):
```typescript
import type { Metadata, Viewport } from 'next'
```

**b) Add/replace the viewport export** (place it near the `metadata` export, before the layout component):
```typescript
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}
```

**c) Ensure no fixed-width container** — inspect the JSX returned by the root layout. If there is a `<div>` with a class like `w-[1200px]`, `max-w-screen-xl` without `w-full`, or any fixed pixel width, replace it with `w-full`. The layout should look something like:
```tsx
<html lang="en">
  <body className={`${someFont.variable} antialiased`}>
    {children}
  </body>
</html>
```
If there's an inner wrapper div, ensure it uses `w-full` not a fixed pixel width.

> **Note:** If the file already has `export const viewport: Viewport = { ... }` with the correct values, no change is needed for that export. If there is a `<meta name="viewport">` inside a `<head>` tag in the JSX, remove it — the `viewport` export is the correct Next.js App Router approach and the two can conflict.

### Step 3: Update `app/globals.css`

Open `app/globals.css`. After the Tailwind directives (e.g., `@import "tailwindcss"` or `@tailwind base; @tailwind components; @tailwind utilities;`), add or merge the following rules.

**Check if `html` and `body` blocks already exist** in globals.css. If they do, add the missing properties to the existing blocks. If they don't exist, add these blocks:

```css
html {
  overflow-x: hidden;
  scroll-behavior: smooth;
}

body {
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}
```

> **Important:** Tailwind v4 uses `@import "tailwindcss"` instead of `@tailwind` directives. Place these rules after the import line. Do not duplicate rules that already exist — read the file first and merge carefully.

### Step 4: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Full build
npm run build
```

If `tsc` reports an error about `Viewport` not being found in `next`, check the installed Next.js version:
```bash
cat node_modules/next/package.json | grep '"version"'
```
If Next.js < 14.0.0 (unlikely given CLAUDE.md says v16), the `Viewport` type may be under a different path — but for Next.js 14+, `import type { Viewport } from 'next'` is correct.

If there are any other TypeScript errors unrelated to this change, note them but do not fix them — keep the scope minimal.

### Step 5: Commit, push, open PR

```bash
git add app/layout.tsx app/globals.css
git commit -m "fix: add viewport meta export and global responsive CSS foundation

- Export viewport config from root layout (device-width, initialScale=1)
- Add overflow-x hidden to html and body to prevent horizontal scroll
- Add scroll-behavior smooth and -webkit-overflow-scrolling touch
- Safety net for responsive UI pass across all pages"

git push origin feat/viewport-responsive-foundation

gh pr create \
  --title "fix: viewport meta tag and global responsive foundation" \
  --body "## Summary
Foundational responsive CSS safety-net for the ongoing mobile UI pass.

## Changes
- \`app/layout.tsx\`: Added/verified \`viewport\` export using Next.js \`Viewport\` type (\`width: 'device-width', initialScale: 1\`)
- \`app/globals.css\`: Added \`overflow-x: hidden\` on \`html\` and \`body\`, \`scroll-behavior: smooth\` on \`html\`, \`-webkit-overflow-scrolling: touch\` on \`body\`

## Acceptance Criteria
- [x] Root layout exports viewport metadata with width=device-width and initialScale=1
- [x] html and body have overflow-x hidden to prevent horizontal scrolling
- [x] No fixed-width container in root layout
- [x] Build completes successfully with no errors

## Risk
Low — CSS-only changes plus a metadata export. No logic changes."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/viewport-responsive-foundation
FILES CHANGED: [list what was actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains]
```

## Escalation

If you hit a blocker you cannot resolve (e.g., `Viewport` type missing from the Next.js version in use, conflicting viewport configurations causing build errors, or unexpected breaking changes):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "viewport-responsive-foundation",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["app/layout.tsx", "app/globals.css"]
    }
  }'
```