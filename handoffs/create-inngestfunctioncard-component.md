# Agent Forge -- Create InngestFunctionCard Component

## Metadata
- **Branch:** `feat/inngest-function-card`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** components/inngest-function-card.tsx

## Context

Agent Forge has a dashboard for monitoring autonomous agents. The Agents dashboard page needs a reusable card component to display Inngest function status (idle, running, success, error) with a "Run Now" trigger button. This is a purely presentational component — no data fetching occurs inside it; the parent page handles all data and trigger logic.

The codebase uses:
- Next.js 16 App Router
- Tailwind CSS for styling
- shadcn/ui components (Button, Card, Badge, etc.) likely available in `components/ui/`
- TypeScript throughout

Existing dashboard patterns to follow:
- Client components use `"use client"` directive at the top
- Tailwind utility classes for layout and color
- Props are typed with TypeScript interfaces
- Relative timestamps (e.g., "3 min ago") are common in the dashboard

The `InngestFunctionStatus` type likely lives in `lib/types.ts` or a similar shared types file. If not present, a local interface definition is acceptable.

## Requirements

1. Create `components/inngest-function-card.tsx` as a `"use client"` component
2. Accept props: `functionId: string`, `functionName: string`, `status: 'idle' | 'running' | 'success' | 'error'`, `lastRunAt: string | null`, `onTrigger: (functionId: string) => void`, `isTriggering: boolean`
3. Render `functionName` prominently (e.g., text-lg font-semibold)
4. Show a colored status indicator dot + label:
   - `idle` → gray
   - `running` → blue with animation (pulse)
   - `success` → green
   - `error` → red
5. Display `lastRunAt` as a relative time string (e.g., "3 min ago") using a utility or inline date math; show "No runs yet" when `lastRunAt` is null
6. Render a "Run Now" button that:
   - Calls `onTrigger(functionId)` on click
   - Is disabled when `isTriggering === true`
   - Shows "Triggering…" text (or a spinner) when `isTriggering === true`
7. Card has a fixed `min-h-[140px]` (or similar) to prevent layout shift
8. Export the component as the default export and export the props type as a named export

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/inngest-function-card
```

### Step 1: Inspect existing UI components and types

Before writing any code, check what's available:

```bash
# Check for shadcn/ui components
ls components/ui/ 2>/dev/null || echo "No ui directory found"

# Check shared types for InngestFunctionStatus
grep -r "InngestFunctionStatus" lib/ --include="*.ts" --include="*.tsx" -l 2>/dev/null
grep -r "InngestFunctionStatus" app/ --include="*.ts" --include="*.tsx" -l 2>/dev/null

# Look at an existing dashboard card/component for pattern reference
ls components/ | head -20
cat components/ui/card.tsx 2>/dev/null | head -40 || echo "No card component"
cat components/ui/button.tsx 2>/dev/null | head -20 || echo "No button component"
cat components/ui/badge.tsx 2>/dev/null | head -20 || echo "No badge component"

# Check an existing component for style patterns
ls components/*.tsx 2>/dev/null | head -5
```

### Step 2: Create the InngestFunctionCard component

Create `components/inngest-function-card.tsx` with the following implementation. Adapt imports based on what you found in Step 1 (use shadcn/ui primitives if available; fall back to plain Tailwind divs if not).

```tsx
"use client";

import { cn } from "@/lib/utils";

// Adapt these imports based on available shadcn/ui components:
// If components/ui/button.tsx exists:
import { Button } from "@/components/ui/button";
// If components/ui/card.tsx exists:
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export type InngestFunctionStatus = "idle" | "running" | "success" | "error";

export interface InngestFunctionCardProps {
  functionId: string;
  functionName: string;
  status: InngestFunctionStatus;
  lastRunAt: string | null;
  onTrigger: (functionId: string) => void;
  isTriggering: boolean;
}

const STATUS_CONFIG: Record<
  InngestFunctionStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  idle: {
    label: "Idle",
    dotClass: "bg-gray-400",
    textClass: "text-gray-500",
  },
  running: {
    label: "Running",
    dotClass: "bg-blue-500 animate-pulse",
    textClass: "text-blue-600",
  },
  success: {
    label: "Success",
    dotClass: "bg-green-500",
    textClass: "text-green-600",
  },
  error: {
    label: "Error",
    dotClass: "bg-red-500",
    textClass: "text-red-600",
  },
};

function formatRelativeTime(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return "just now";

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export default function InngestFunctionCard({
  functionId,
  functionName,
  status,
  lastRunAt,
  onTrigger,
  isTriggering,
}: InngestFunctionCardProps) {
  const config = STATUS_CONFIG[status];

  const handleTrigger = () => {
    if (!isTriggering) {
      onTrigger(functionId);
    }
  };

  // --- Render with shadcn/ui Card if available ---
  // If Card is not available, replace with a plain <div> wrapper:
  //   <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4 min-h-[140px] flex flex-col justify-between">
  return (
    <Card className="min-h-[140px] flex flex-col justify-between">
      <CardHeader className="pb-2">
        <h3 className="text-base font-semibold leading-tight">{functionName}</h3>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            className={cn("inline-block h-2.5 w-2.5 rounded-full flex-shrink-0", config.dotClass)}
            aria-hidden="true"
          />
          <span className={cn("text-xs font-medium", config.textClass)}>
            {config.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="pt-0 flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          {lastRunAt ? formatRelativeTime(lastRunAt) : "No runs yet"}
        </p>
        {/* If Button is not available, use a plain <button> with appropriate Tailwind classes */}
        <Button
          size="sm"
          variant="outline"
          onClick={handleTrigger}
          disabled={isTriggering}
          className="w-full mt-auto"
        >
          {isTriggering ? (
            <>
              <span
                className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden="true"
              />
              Triggering…
            </>
          ) : (
            "Run Now"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
```

**Important adaptation rules:**
- If `components/ui/card.tsx` does **not** exist, replace `<Card>`, `<CardHeader>`, `<CardContent>` with plain `<div>` elements using `className="rounded-lg border bg-white shadow-sm p-4 min-h-[140px] flex flex-col justify-between"`.
- If `components/ui/button.tsx` does **not** exist, replace `<Button>` with a `<button>` element using `className="w-full mt-auto rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"`.
- If `lib/utils.ts` with `cn` does **not** exist, replace `cn(...)` calls with template literal string concatenation or `[...].join(' ')`.
- If `InngestFunctionStatus` is already defined in `lib/types.ts`, import from there and do **not** redefine it locally (remove the local type alias, keep the interface).

### Step 3: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- Missing `cn` utility → check `lib/utils.ts`, add it if absent or inline the class merging
- Import path aliases (`@/`) not configured → use relative paths (`../lib/utils`)

### Step 4: Run any existing tests and linter

```bash
# Run tests if present
npm test 2>/dev/null || echo "No test script"

# Lint
npm run lint 2>/dev/null || echo "No lint script"

# Build verification
npm run build
```

If the build fails due to this new file, investigate and fix before opening a PR.

### Step 5: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add InngestFunctionCard component for Agents dashboard"
git push origin feat/inngest-function-card
gh pr create \
  --title "feat: add InngestFunctionCard component" \
  --body "## Summary
Adds a reusable \`InngestFunctionCard\` component for displaying Inngest function status on the Agents dashboard.

## Changes
- \`components/inngest-function-card.tsx\` — new client component

## Features
- Status indicator (idle/gray, running/blue+pulse, success/green, error/red)
- Relative timestamp display (e.g., '3 min ago') or 'No runs yet' when \`lastRunAt\` is null
- 'Run Now' button with disabled + loading state while \`isTriggering\` is true
- Fixed \`min-h-[140px]\` to prevent layout shift
- Purely presentational — no internal data fetching

## Acceptance Criteria
- [x] Renders function name, status indicator with correct color per status, and last-run timestamp
- [x] Shows 'No runs yet' when \`lastRunAt\` is null
- [x] Run Now button calls \`onTrigger\` with \`functionId\` on click
- [x] Run Now button is disabled and shows loading state when \`isTriggering\` is true
- [x] Card has fixed min-height to prevent layout shift
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
BRANCH: feat/inngest-function-card
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If you encounter a blocker you cannot resolve (e.g., missing environment variables, ambiguous imports, repeated TypeScript failures after 3 attempts):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "inngest-function-card",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["components/inngest-function-card.tsx"]
    }
  }'
```