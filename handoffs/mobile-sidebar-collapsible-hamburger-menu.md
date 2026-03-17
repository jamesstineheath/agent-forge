# Agent Forge -- Mobile sidebar: collapsible hamburger menu

## Metadata
- **Branch:** `feat/mobile-sidebar-hamburger`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** components/sidebar.tsx, app/(app)/layout.tsx

## Context

Agent Forge is a Next.js 16 App Router application with a protected `(app)` route group. Currently the sidebar (`components/sidebar.tsx`) renders as a fixed desktop sidebar in the layout (`app/(app)/layout.tsx`). On mobile viewports the sidebar either overflows or is not usable.

The task is to make the navigation responsive:
- **Mobile (< 768px / `md` breakpoint):** Hide the desktop sidebar, show a sticky top bar with a hamburger icon that opens a Sheet (slide-over drawer) containing all nav links.
- **Desktop (≥ 768px):** Existing sidebar renders exactly as before.

Key dependencies already in the project:
- `shadcn/ui` — Sheet component available (`components/ui/sheet.tsx` or similar)
- `lucide-react` — `Menu` icon available
- Tailwind CSS v4 with `md:` breakpoint at 768px

Pattern to follow: use `hidden md:flex` / `flex md:hidden` Tailwind classes for visibility toggling. The mobile drawer must close when a nav link is clicked.

## Requirements

1. On viewports < 768px, the desktop sidebar is completely hidden (not just visually offscreen).
2. On viewports < 768px, a sticky top bar (h-14, flex, items-center, px-4, border-b, bg-background) is visible containing a hamburger (`Menu`) icon button.
3. Tapping the hamburger button opens a shadcn/ui `Sheet` drawer containing all navigation links from the sidebar.
4. Each nav link in the mobile drawer has `min-h-[44px]` for touch target compliance.
5. Clicking any nav link in the drawer closes the drawer and navigates to the correct page.
6. On viewports ≥ 768px, the existing desktop sidebar renders unchanged and no hamburger button or top bar is visible.
7. No TypeScript errors introduced.
8. The layout grid in `app/(app)/layout.tsx` removes the sidebar column on mobile so content fills full width.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/mobile-sidebar-hamburger
```

### Step 1: Inspect current sidebar and layout

Read the existing files to understand current structure before modifying:

```bash
cat components/sidebar.tsx
cat app/\(app\)/layout.tsx
# Check what shadcn/ui Sheet looks like
ls components/ui/ | grep -i sheet
cat components/ui/sheet.tsx 2>/dev/null || echo "Sheet not found, check components/ui/"
```

If `Sheet` is not yet installed, add it:
```bash
npx shadcn@latest add sheet
```

### Step 2: Rewrite `components/sidebar.tsx`

The goal is to export a single component that:
- Renders the full desktop sidebar on `md+` screens
- Renders a sticky mobile top bar + Sheet drawer on `< md` screens

Use the existing nav links from the current sidebar. Here is the target implementation pattern — adapt the actual nav links, icons, and hrefs to match whatever is currently in the file:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

// --- Nav link definitions (preserve whatever exists in current sidebar) ---
// Example shape — replace with actual links from the existing file:
const navLinks = [
  { href: "/", label: "Dashboard" },
  { href: "/work-items", label: "Work Items" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/repos", label: "Repos" },
  { href: "/settings", label: "Settings" },
];

// Shared nav link component used in both desktop and mobile
function NavLinks({
  onNavigate,
  mobile = false,
}: {
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav className={mobile ? "flex flex-col gap-1 p-4" : "flex flex-col gap-1 p-4"}>
      {navLinks.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={[
              "flex items-center rounded-md px-3 text-sm font-medium transition-colors",
              mobile ? "min-h-[44px]" : "h-9",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            ].join(" ")}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

// Desktop sidebar — hidden on mobile
function DesktopSidebar() {
  return (
    <aside className="hidden md:flex flex-col w-56 border-r bg-background h-full shrink-0">
      {/* Preserve existing sidebar header/logo if present */}
      <div className="flex h-14 items-center border-b px-4 font-semibold">
        Agent Forge
      </div>
      <NavLinks />
    </aside>
  );
}

// Mobile top bar + Sheet drawer — hidden on md+
function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex md:hidden sticky top-0 z-40 h-14 items-center border-b bg-background px-4">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open navigation menu">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SheetHeader className="flex h-14 items-center border-b px-4">
            <SheetTitle className="font-semibold">Agent Forge</SheetTitle>
          </SheetHeader>
          <NavLinks mobile onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="ml-3 font-semibold">Agent Forge</span>
    </div>
  );
}

export function Sidebar() {
  return (
    <>
      <DesktopSidebar />
      <MobileNav />
    </>
  );
}

// Support default export if current file uses it
export default Sidebar;
```

**Important:** When implementing, preserve all existing nav links, icons, active-state logic, and any branding from the current `sidebar.tsx`. Only add the responsive wrapper — do not remove functionality.

### Step 3: Update `app/(app)/layout.tsx`

The layout needs to:
1. Keep the desktop sidebar in the flex row for `md+`
2. On mobile, the `MobileNav` (rendered inside `<Sidebar />`) sits above the main content — so the outer layout should be `flex-col` on mobile and `flex-row` on desktop.

Typical pattern:

```tsx
// app/(app)/layout.tsx
import { Sidebar } from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
```

Read the existing layout first and make the minimal change to adjust the outer container from a fixed `flex flex-row` (which breaks on mobile) to `flex flex-col md:flex-row`. Preserve any existing auth wrappers, providers, or other layout elements exactly.

### Step 4: Verify TypeScript and imports

```bash
# Ensure all imports resolve
npx tsc --noEmit
```

If Sheet subcomponents (`SheetHeader`, `SheetTitle`) are not exported from `components/ui/sheet.tsx`, either:
- Add them manually following shadcn/ui conventions, or
- Adjust the import to use only what's available (`SheetContent`, `Sheet`, `SheetTrigger`)

For `SheetTitle` requirement (accessibility), if not in the component file, add a visually hidden title:
```tsx
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
// or use sr-only class:
<span className="sr-only">Navigation</span>
```

### Step 5: Manual smoke check (optional but recommended)

```bash
npm run dev
# Open browser at localhost:3000
# Resize to < 768px width — should see top bar + hamburger
# Resize to >= 768px width — should see desktop sidebar
```

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Both must exit 0 with no errors.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: mobile sidebar with hamburger menu and Sheet drawer"
git push origin feat/mobile-sidebar-hamburger
gh pr create \
  --title "feat: mobile sidebar — collapsible hamburger menu" \
  --body "## Summary

Adds responsive navigation for mobile viewports (< 768px).

### Changes
- \`components/sidebar.tsx\`: Wrapped existing nav in responsive container. Added \`MobileNav\` component (sticky top bar + hamburger button + Sheet drawer). Added \`DesktopSidebar\` component hidden on mobile.
- \`app/(app)/layout.tsx\`: Changed outer container to \`flex-col md:flex-row\` so mobile layout stacks vertically.

### Behavior
- **Mobile (< 768px):** Sticky top bar visible, hamburger opens Sheet drawer with all nav links. Each link has \`min-h-[44px]\` touch target. Clicking a link closes the drawer.
- **Desktop (≥ 768px):** Existing sidebar unchanged, no hamburger visible.

### Testing
- \`npx tsc --noEmit\` ✅
- \`npm run build\` ✅

Closes: mobile sidebar work item"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/mobile-sidebar-hamburger
FILES CHANGED: [components/sidebar.tsx, app/(app)/layout.tsx]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation

If you hit an unresolvable blocker (e.g., Sheet component missing and cannot be added, layout structure is significantly different from expected, TypeScript errors you cannot resolve after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "mobile-sidebar-hamburger-menu",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["components/sidebar.tsx", "app/(app)/layout.tsx"]
    }
  }'
```