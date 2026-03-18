# Agent Forge -- Dashboard QA Results Section — UI Component

## Metadata
- **Branch:** `feat/dashboard-qa-results-section`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** components/qa-dashboard.tsx, app/(app)/page.tsx

## Context

Agent Forge has a TLM QA Agent (`.github/actions/tlm-qa-agent/`) that runs post-deploy verification and logs results to a structured action ledger. There's a `/api/qa-results` endpoint that exposes this data. However, the main dashboard (`app/(app)/page.tsx`) currently has no visibility into QA Agent metrics.

The goal is to add a `<QADashboard />` component that surfaces QA health data — pass rates, failure categories, per-repo breakdown, recent runs, and graduation progress — integrated into the existing dashboard.

The codebase uses:
- **shadcn/ui** components (Card, Badge, Table, Progress) from `components/ui/`
- **SWR** via the `lib/hooks.ts` pattern for data fetching
- **Tailwind CSS v4** for styling
- **Next.js App Router** with auth-protected `(app)` route group

Reference `lib/hooks.ts` for the existing `useSWR` pattern. Reference `components/debate-stats-card.tsx` and recent dashboard additions for component style conventions.

## Requirements

1. Create `components/qa-dashboard.tsx` that fetches from `/api/qa-results` using SWR
2. Display pass rate as a percentage with color coding: green ≥90%, yellow 70–89%, red <70%
3. Display total runs count
4. Display failure categories as a table or list with counts
5. Display average verification time (formatted nicely, e.g. "2.3s")
6. Display per-repo breakdown table (repo name, runs, pass rate)
7. Display recent runs list (last 10) with status badges (pass/fail) and timestamps
8. Display graduation progress bar showing current run count vs. 20-run threshold and current false-negative rate
9. Show a helpful empty state when no QA data exists: "No QA runs recorded. Deploy the QA Agent to get started."
10. Import and render `<QADashboard />` in `app/(app)/page.tsx` as a new section
11. Component must compile without TypeScript errors
12. No regressions to existing dashboard sections

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/dashboard-qa-results-section
```

### Step 1: Inspect existing patterns

Read these files to understand conventions before writing any code:

```bash
cat lib/hooks.ts
cat app/(app)/page.tsx
cat components/debate-stats-card.tsx
```

Also check what shadcn/ui components are available:
```bash
ls components/ui/
```

And inspect the QA results API to understand the response shape:
```bash
cat app/api/qa-results/route.ts 2>/dev/null || echo "File not found"
# Also check for type definitions
grep -r "qa-results\|QaResult\|QAResult" lib/ app/api/ --include="*.ts" -l 2>/dev/null
```

### Step 2: Understand the `/api/qa-results` response shape

Based on the action ledger implementation (`.github/actions/tlm-qa-agent/src/action-ledger.ts`), the API likely returns a structure with run records. Look at:

```bash
cat .github/actions/tlm-qa-agent/src/action-ledger.ts 2>/dev/null
cat .github/actions/tlm-qa-agent/run-qa.ts 2>/dev/null | head -80
```

Design the TypeScript types for the component based on what you find. If the API doesn't exist or returns a different shape, adapt accordingly. A reasonable assumed shape to code against (adjust based on findings):

```typescript
interface QARunRecord {
  id: string;
  repo: string;
  timestamp: string;       // ISO string
  passed: boolean;
  durationMs: number;
  failureCategories?: string[];
  isFalseNegative?: boolean;
}

interface QAResultsResponse {
  runs: QARunRecord[];
  summary: {
    totalRuns: number;
    passRate: number;          // 0-100
    avgDurationMs: number;
    failureCategories: Record<string, number>;
    byRepo: Array<{
      repo: string;
      runs: number;
      passRate: number;
    }>;
    graduation: {
      runsCompleted: number;
      runsRequired: number;    // 20
      falseNegativeRate: number; // 0-100
    };
  };
}
```

Adjust the component's internal types to match the actual API response shape discovered in Step 1.

### Step 3: Add SWR hook to `lib/hooks.ts`

Open `lib/hooks.ts` and add a `useQAResults` hook following the existing pattern. Example (adapt to match existing hook style in the file):

```typescript
export function useQAResults() {
  const { data, error, isLoading } = useSWR<QAResultsResponse>('/api/qa-results', fetcher)
  return {
    data,
    isLoading,
    error,
  }
}
```

Place the `QAResultsResponse` and related type definitions either at the top of `hooks.ts` or in `lib/types.ts` — follow whichever convention exists.

### Step 4: Create `components/qa-dashboard.tsx`

Create the file with the full component. Use shadcn/ui Card, Badge, Table, and Progress components. Below is the full implementation — **adapt based on actual API shape and available shadcn components discovered in Step 1**:

```tsx
'use client'

import { useQAResults } from '@/lib/hooks'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Progress } from '@/components/ui/progress'

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

function passRateColor(rate: number): string {
  if (rate >= 90) return 'text-green-600'
  if (rate >= 70) return 'text-yellow-600'
  return 'text-red-600'
}

function passRateBadgeVariant(rate: number): 'default' | 'secondary' | 'destructive' {
  if (rate >= 90) return 'default'
  if (rate >= 70) return 'secondary'
  return 'destructive'
}

export function QADashboard() {
  const { data, isLoading, error } = useQAResults()

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>QA Agent</CardTitle>
          <CardDescription>Loading QA metrics…</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
            Loading…
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>QA Agent</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Failed to load QA data.</p>
        </CardContent>
      </Card>
    )
  }

  const isEmpty = !data || !data.summary || data.summary.totalRuns === 0

  if (isEmpty) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>QA Agent</CardTitle>
          <CardDescription>Post-deploy verification metrics</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center">
            <p className="text-sm text-muted-foreground">
              No QA runs recorded. Deploy the QA Agent to get started.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { summary, runs } = data
  const recentRuns = (runs ?? []).slice(0, 10)
  const grad = summary.graduation

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pass Rate</CardDescription>
          </CardHeader>
          <CardContent>
            <span className={`text-3xl font-bold ${passRateColor(summary.passRate)}`}>
              {summary.passRate.toFixed(1)}%
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Runs</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-3xl font-bold">{summary.totalRuns}</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg Duration</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-3xl font-bold">
              {formatDuration(summary.avgDurationMs)}
            </span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Graduation</CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-3xl font-bold">
              {grad.runsCompleted}/{grad.runsRequired}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Graduation progress */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Graduation Progress</CardTitle>
          <CardDescription>
            {grad.runsCompleted} of {grad.runsRequired} runs completed ·{' '}
            {grad.falseNegativeRate.toFixed(1)}% false-negative rate
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Progress
            value={(grad.runsCompleted / grad.runsRequired) * 100}
            className="h-3"
          />
        </CardContent>
      </Card>

      {/* Failure categories */}
      {summary.failureCategories &&
        Object.keys(summary.failureCategories).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Failure Categories</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Count</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(summary.failureCategories)
                    .sort(([, a], [, b]) => b - a)
                    .map(([category, count]) => (
                      <TableRow key={category}>
                        <TableCell className="font-medium">{category}</TableCell>
                        <TableCell className="text-right">{count}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

      {/* Per-repo breakdown */}
      {summary.byRepo && summary.byRepo.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-Repo Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Pass Rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.byRepo.map((row) => (
                  <TableRow key={row.repo}>
                    <TableCell className="font-mono text-sm">{row.repo}</TableCell>
                    <TableCell className="text-right">{row.runs}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={passRateBadgeVariant(row.passRate)}>
                        {row.passRate.toFixed(1)}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recent runs */}
      {recentRuns.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repo</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="font-mono text-sm">{run.repo}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatTimestamp(run.timestamp)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDuration(run.durationMs)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={run.passed ? 'default' : 'destructive'}>
                        {run.passed ? 'Pass' : 'Fail'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

### Step 5: Wire into `app/(app)/page.tsx`

Open `app/(app)/page.tsx` and add the QA dashboard section. Find a natural placement — after existing sections like debate stats or pipeline health. Add:

```tsx
import { QADashboard } from '@/components/qa-dashboard'
```

And in the JSX body, add a new section:

```tsx
{/* QA Agent */}
<section>
  <h2 className="text-lg font-semibold mb-3">QA Agent</h2>
  <QADashboard />
</section>
```

Match the exact section/heading style used by other dashboard sections in the file.

### Step 6: Handle missing shadcn components

If `Progress` is not yet installed:
```bash
npx shadcn@latest add progress
```

If `Table` is not yet installed:
```bash
npx shadcn@latest add table
```

Verify after adding:
```bash
ls components/ui/ | grep -E "progress|table"
```

### Step 7: Handle the case where `/api/qa-results` doesn't exist

Check if the route exists:
```bash
ls app/api/qa-results/ 2>/dev/null || echo "Route missing"
```

If it doesn't exist, create a stub that returns an empty response so the component renders gracefully:

```bash
mkdir -p app/api/qa-results
```

Create `app/api/qa-results/route.ts`:

```typescript
import { NextResponse } from 'next/server'

export async function GET() {
  // Stub endpoint — replace with real data source when QA Agent ledger is wired up
  return NextResponse.json({
    runs: [],
    summary: {
      totalRuns: 0,
      passRate: 0,
      avgDurationMs: 0,
      failureCategories: {},
      byRepo: [],
      graduation: {
        runsCompleted: 0,
        runsRequired: 20,
        falseNegativeRate: 0,
      },
    },
  })
}
```

If the route already exists with a real implementation, do NOT replace it — just ensure the component types match what it returns.

### Step 8: Verification

```bash
# TypeScript check
npx tsc --noEmit

# Build check
npm run build

# Run tests if present
npm test -- --passWithNoTests 2>/dev/null || true
```

Fix any TypeScript errors before proceeding. Common issues:
- Missing shadcn/ui component imports → run `npx shadcn@latest add <component>`
- Type mismatch between hook return and component usage → adjust types to match actual API shape
- `'use client'` directive required on the component (already included)

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add QA results dashboard section with pass rate, graduation progress, and recent runs"
git push origin feat/dashboard-qa-results-section
gh pr create \
  --title "feat: Dashboard QA Results Section — UI Component" \
  --body "## Summary

Adds a \`<QADashboard />\` component to the main dashboard that surfaces QA Agent metrics.

## Changes
- \`components/qa-dashboard.tsx\` — New component fetching from \`/api/qa-results\` via SWR
- \`lib/hooks.ts\` — Added \`useQAResults\` hook
- \`app/(app)/page.tsx\` — Renders \`<QADashboard />\` as a new section
- \`app/api/qa-results/route.ts\` — Stub endpoint (if not already present)

## Features
- Pass rate gauge with color coding (green ≥90%, yellow 70–89%, red <70%)
- Total runs count and average duration
- Failure categories table
- Per-repo breakdown with pass rate badges
- Recent runs list (last 10) with pass/fail badges
- Graduation progress bar (X/20 runs) with false-negative rate
- Empty state when no QA data exists

## Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` succeeds
- Empty state renders correctly when API returns zero runs"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/dashboard-qa-results-section
FILES CHANGED: [list of files actually modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g. "API shape mismatch: /api/qa-results returns X but component expects Y"]
```