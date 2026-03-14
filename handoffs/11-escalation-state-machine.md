# Handoff 11: Escalation State Machine

## Metadata
- **Branch:** `feat/escalation-state-machine`
- **Priority:** high
- **Model:** opus
- **Type:** feature
- **Max Budget:** $8
- **Risk Level:** medium
- **Complexity:** Moderate (3 new files, 4 files modified)
- **Estimated files:** `lib/escalation.ts`, `lib/types.ts`, `lib/work-items.ts`, `lib/atc.ts`, `lib/hooks.ts`, `app/api/escalations/route.ts`, `app/api/escalations/[id]/resolve/route.ts`, `app/(app)/page.tsx`

## Context

Agent Forge Phase 2f adds the internal escalation state machine. When the ATC or an executor encounters a condition it cannot resolve (e.g., merge conflict, policy violation, ambiguous spec), it calls `escalate()` to create an Escalation record, transition the work item to "blocked" status, and queue it for human review.

Escalations are:
- **Recorded** in Blob storage with full context snapshot
- **Visible** on the dashboard in a pending escalations section
- **Resolvable** via API endpoint by providing a resolution
- **Monitored** by the ATC for timeout (24h without resolution)
- **Not yet integrated** with Gmail (that's Handoff 12)

The escalation flow:
1. Code calls `escalate(workItemId, reason, confidenceScore, contextSnapshot)`
2. Escalation record created with status "pending", work item transitioned to "blocked"
3. Dashboard shows pending escalations with confidence score and time elapsed
4. Manual API call to `/api/escalations/{id}/resolve` marks it resolved and transitions work item back to "queued"
5. ATC monitors for escalations older than 24h and logs `escalation_timeout` events (no auto-resolution)

## Pre-flight Self-Check

Before executing, confirm:
- [ ] You are on a fresh branch from `main`
- [ ] Handoff 10 (Notion Projects Integration) has been merged to `main`
- [ ] `lib/atc.ts` exists and contains `runATCCycle()` with section 9 (project polling)
- [ ] `lib/types.ts` exists and contains `ATCEvent` type union with `"project_trigger"`
- [ ] `lib/work-items.ts` exists with CRUD functions
- [ ] `lib/hooks.ts` exists and contains `useATCState`, `useWorkItems`, `useProjects`
- [ ] `app/(app)/page.tsx` exists and renders the dashboard with Projects section
- [ ] `app/api/` directory contains `escalations/` directory (may be empty initially)
- [ ] No open PRs touch `lib/types.ts`, `lib/atc.ts`, or `app/(app)/page.tsx`

## Step 0: Branch, commit handoff, push

```bash
git checkout main && git pull
git checkout -b feat/escalation-state-machine
mkdir -p handoffs
cp handoffs/11-escalation-state-machine.md handoffs/ 2>/dev/null || true
# The handoff file itself will be committed in this step
git add handoffs/11-escalation-state-machine.md
git commit -m "chore: add handoff 11 - escalation state machine"
git push origin feat/escalation-state-machine
```

## Step 1: Create `lib/escalation.ts` (Core escalation module)

This module handles escalation CRUD, storage, and transitions. It uses the same Blob storage pattern as work-items.

```typescript
// lib/escalation.ts
import { loadJson, saveJson, deleteJson } from "./storage";

export interface Escalation {
  id: string;
  workItemId: string;
  reason: string;
  confidenceScore: number; // 0-1, how confident the system is that escalation is needed
  contextSnapshot: Record<string, unknown>; // Full state snapshot at time of escalation
  status: "pending" | "resolved" | "expired";
  createdAt: string;
  resolvedAt?: string;
  resolution?: string; // Human-provided resolution or outcome
  threadId?: string; // For Gmail integration (Handoff 12)
}

const ESCALATIONS_INDEX_KEY = "escalations/index";

function getEscalationKey(id: string): string {
  return `escalations/${id}`;
}

/**
 * Create a new escalation and transition the work item to "blocked"
 */
export async function escalate(
  workItemId: string,
  reason: string,
  confidenceScore: number,
  contextSnapshot: Record<string, unknown>
): Promise<Escalation> {
  const id = `esc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = new Date().toISOString();

  const escalation: Escalation = {
    id,
    workItemId,
    reason,
    confidenceScore: Math.max(0, Math.min(1, confidenceScore)),
    contextSnapshot,
    status: "pending",
    createdAt: now,
  };

  // Save the escalation record
  await saveJson(getEscalationKey(id), escalation);

  // Update the index
  const index = (await loadJson<string[]>(ESCALATIONS_INDEX_KEY)) ?? [];
  if (!index.includes(id)) {
    index.push(id);
    await saveJson(ESCALATIONS_INDEX_KEY, index);
  }

  console.log(`[escalation] Created escalation ${id} for work item ${workItemId}: ${reason}`);

  return escalation;
}

/**
 * Resolve an escalation and transition the work item back to "queued"
 */
export async function resolveEscalation(
  id: string,
  resolution: string
): Promise<Escalation | null> {
  const escalation = await getEscalation(id);
  if (!escalation) return null;

  const now = new Date().toISOString();
  const updated: Escalation = {
    ...escalation,
    status: "resolved",
    resolvedAt: now,
    resolution,
  };

  await saveJson(getEscalationKey(id), updated);
  console.log(`[escalation] Resolved escalation ${id}: ${resolution}`);

  return updated;
}

/**
 * Mark an escalation as expired (timeout after 24h without resolution)
 */
export async function expireEscalation(id: string): Promise<Escalation | null> {
  const escalation = await getEscalation(id);
  if (!escalation) return null;

  const updated: Escalation = {
    ...escalation,
    status: "expired",
  };

  await saveJson(getEscalationKey(id), updated);
  console.log(`[escalation] Marked escalation ${id} as expired (timeout)`);

  return updated;
}

/**
 * Get a single escalation by ID
 */
export async function getEscalation(id: string): Promise<Escalation | null> {
  return loadJson<Escalation>(getEscalationKey(id));
}

/**
 * List all escalations with optional status filter
 */
export async function listEscalations(
  statusFilter?: "pending" | "resolved" | "expired" | "all"
): Promise<Escalation[]> {
  const index = (await loadJson<string[]>(ESCALATIONS_INDEX_KEY)) ?? [];

  const escalations: Escalation[] = [];
  for (const id of index) {
    const esc = await getEscalation(id);
    if (esc) {
      if (!statusFilter || statusFilter === "all" || esc.status === statusFilter) {
        escalations.push(esc);
      }
    }
  }

  // Sort by created time, newest first
  escalations.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return escalations;
}

/**
 * Get all pending escalations
 */
export async function getPendingEscalations(): Promise<Escalation[]> {
  return listEscalations("pending");
}

/**
 * Delete an escalation (cleanup only, typically after expiration or resolution)
 */
export async function deleteEscalation(id: string): Promise<boolean> {
  try {
    await deleteJson(getEscalationKey(id));
    const index = (await loadJson<string[]>(ESCALATIONS_INDEX_KEY)) ?? [];
    const updated = index.filter((i) => i !== id);
    await saveJson(ESCALATIONS_INDEX_KEY, updated);
    return true;
  } catch (err) {
    console.error(`[escalation] Failed to delete escalation ${id}:`, err);
    return false;
  }
}
```

Commit:
```bash
git add lib/escalation.ts
git commit -m "feat: add escalation state machine core module"
```

## Step 2: Update `lib/types.ts`

Add the `"blocked"` status to the WorkItem status union, add escalation event types, and add an optional escalation field to WorkItem.

Find the `status` field in the `WorkItem` interface (around line 10-30) and update it:
```typescript
// FIND THIS:
status: "filed" | "ready" | "queued" | "generating" | "executing" | "reviewing" | "merged" | "failed" | "parked";

// REPLACE WITH:
status: "filed" | "ready" | "queued" | "generating" | "executing" | "reviewing" | "merged" | "failed" | "parked" | "blocked";
```

Add an escalation field to the `WorkItem` interface (after the `execution` field):
```typescript
// ADD AFTER THE execution field:
escalation?: {
  id: string;
  reason: string;
  blockedAt: string;
};
```

Find the `type` field in the `ATCEvent` interface (around line 60-80) and update it:
```typescript
// FIND THIS:
type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup" | "project_trigger";

// REPLACE WITH:
type: "status_change" | "timeout" | "concurrency_block" | "auto_dispatch" | "conflict" | "retry" | "parked" | "error" | "cleanup" | "project_trigger" | "escalation" | "escalation_timeout" | "escalation_resolved";
```

Find the `updateWorkItemSchema` Zod schema (search for `updateWorkItemSchema`) and update the status enum in it:
```typescript
// FIND THIS (status enum in the schema):
status: z.enum(["filed", "ready", "queued", "generating", "executing", "reviewing", "merged", "failed", "parked"]).optional(),

// REPLACE WITH:
status: z.enum(["filed", "ready", "queued", "generating", "executing", "reviewing", "merged", "failed", "parked", "blocked"]).optional(),
```

Commit:
```bash
git add lib/types.ts
git commit -m "feat: add blocked status and escalation event types to types"
```

## Step 3: Create `app/api/escalations/route.ts` (Escalations API)

Create the GET endpoint (list with optional filter) and POST endpoint (create new escalation).

```typescript
// app/api/escalations/route.ts
import { NextResponse, NextRequest } from "next/server";
import { listEscalations, escalate } from "@/lib/escalation";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const status = (searchParams.get("status") ?? "all") as
      | "pending"
      | "resolved"
      | "expired"
      | "all";

    const escalations = await listEscalations(status);
    return NextResponse.json(escalations);
  } catch (err) {
    console.error("[api/escalations] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch escalations" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { workItemId, reason, confidenceScore, contextSnapshot } = body;

    // Validate required fields
    if (!workItemId || !reason) {
      return NextResponse.json(
        { error: "workItemId and reason are required" },
        { status: 400 }
      );
    }

    // Create the escalation
    const escalation = await escalate(
      workItemId,
      reason,
      confidenceScore ?? 0.7,
      contextSnapshot ?? {}
    );

    // Transition work item to "blocked"
    const workItem = await getWorkItem(workItemId);
    if (workItem) {
      await updateWorkItem(workItemId, {
        status: "blocked",
        escalation: {
          id: escalation.id,
          reason: escalation.reason,
          blockedAt: escalation.createdAt,
        },
      });
    }

    return NextResponse.json(escalation, { status: 201 });
  } catch (err) {
    console.error("[api/escalations] POST error:", err);
    return NextResponse.json({ error: "Failed to create escalation" }, { status: 500 });
  }
}
```

Commit:
```bash
git add app/api/escalations/route.ts
git commit -m "feat: add /api/escalations GET and POST routes"
```

## Step 4: Create `app/api/escalations/[id]/resolve/route.ts` (Resolve escalation API)

Create the POST endpoint to resolve an escalation and transition the work item back to "queued".

```typescript
// app/api/escalations/[id]/resolve/route.ts
import { NextResponse, NextRequest } from "next/server";
import { resolveEscalation, getEscalation } from "@/lib/escalation";
import { getWorkItem, updateWorkItem } from "@/lib/work-items";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const escalationId = params.id;
    const body = await req.json();
    const { resolution } = body;

    if (!resolution) {
      return NextResponse.json(
        { error: "resolution is required" },
        { status: 400 }
      );
    }

    // Get the escalation to find the work item
    const escalation = await getEscalation(escalationId);
    if (!escalation) {
      return NextResponse.json({ error: "Escalation not found" }, { status: 404 });
    }

    // Resolve the escalation
    const resolved = await resolveEscalation(escalationId, resolution);

    // Transition work item back to "queued" and clear escalation field
    const workItem = await getWorkItem(escalation.workItemId);
    if (workItem) {
      await updateWorkItem(escalation.workItemId, {
        status: "queued",
        escalation: undefined,
      });
    }

    return NextResponse.json(resolved);
  } catch (err) {
    console.error("[api/escalations/[id]/resolve] POST error:", err);
    return NextResponse.json({ error: "Failed to resolve escalation" }, { status: 500 });
  }
}
```

Commit:
```bash
git add app/api/escalations/[id]/resolve/route.ts
git commit -m "feat: add /api/escalations/[id]/resolve POST route"
```

## Step 5: Update `lib/atc.ts` (Add escalation timeout monitoring)

Add section 10 to the ATC sweep: monitor pending escalations for timeout (24h without resolution).

At the top of the file, add the import (after other imports):
```typescript
import { getPendingEscalations, expireEscalation } from "./escalation";
```

Find the `runATCCycle()` function and locate the section 9 comment (project polling). After section 9 and before `return state;`, add section 10:

```typescript
  // 10. Escalation timeout monitoring: flag escalations older than 24h
  try {
    const pending = await getPendingEscalations();
    const now = Date.now();
    const ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

    for (const esc of pending) {
      const createdTime = new Date(esc.createdAt).getTime();
      const age = now - createdTime;

      if (age > ESCALATION_TIMEOUT_MS) {
        // Mark as expired but don't auto-resolve
        await expireEscalation(esc.id);
        const event = makeEvent(
          "escalation_timeout",
          esc.workItemId,
          "pending",
          "expired",
          `Escalation ${esc.id} timed out after 24h without resolution. Reason: ${esc.reason}`
        );
        events.push(event);
        console.log(`[atc] Escalation timeout: ${esc.id} for work item ${esc.workItemId}`);
      }
    }
  } catch (err) {
    console.error("[atc] Escalation monitoring failed:", err);
  }
```

Then, after section 10 and before `return state;`, save the events if any were created:
```typescript
  // Save events if escalation timeouts were detected
  if (events.some(e => e.type === "escalation_timeout")) {
    const existing = (await loadJson<ATCEvent[]>(ATC_EVENTS_KEY)) ?? [];
    const updated = [...existing, ...events.filter(e => e.type === "escalation_timeout")].slice(-MAX_EVENTS);
    await saveJson(ATC_EVENTS_KEY, updated);
  }
```

Commit:
```bash
git add lib/atc.ts
git commit -m "feat: add escalation timeout monitoring to ATC cycle (section 10)"
```

## Step 6: Update `lib/hooks.ts` (Add useEscalations hook)

Add a new SWR hook for escalations with auto-refresh every 15 seconds.

At the top, add the import:
```typescript
import type { Escalation } from "@/lib/escalation";
```

Add the hook at the bottom of the file:
```typescript
export function useEscalations(statusFilter?: "pending" | "resolved" | "expired" | "all") {
  const queryString = statusFilter ? `?status=${statusFilter}` : "";
  const { data, error, isLoading, mutate } = useSWR<Escalation[]>(
    `/api/escalations${queryString}`,
    fetcher,
    { refreshInterval: 15000 }
  );
  return { data, error, isLoading, mutate };
}
```

Commit:
```bash
git add lib/hooks.ts
git commit -m "feat: add useEscalations SWR hook"
```

## Step 7: Update `app/(app)/page.tsx` (Add Blocked count and Escalations section)

Add a "Blocked" stat card to the stats grid and a new Escalations section showing pending escalations.

In the imports at the top, update the hook imports to include `useEscalations`:
```typescript
// FIND THIS:
import { useWorkItems, useRepos, useATCState, useProjects } from "@/lib/hooks";

// REPLACE WITH:
import { useWorkItems, useRepos, useATCState, useProjects, useEscalations } from "@/lib/hooks";
```

Inside the component body (after the existing hooks), add:
```typescript
const { data: escalations, isLoading: escalationsLoading } = useEscalations("pending");
```

In the stats grid (inside `<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">`), add a new card after the Projects card:
```tsx
<Card>
  <CardHeader className="pb-2">
    <CardTitle className="text-sm font-medium text-muted-foreground">
      Blocked
    </CardTitle>
  </CardHeader>
  <CardContent>
    <p className="text-3xl font-bold text-red-600">
      {isLoadingWorkItems ? "\u2014" : (workItems?.filter((wi) => wi.status === "blocked").length ?? 0)}
    </p>
  </CardContent>
</Card>
```

After the Projects section and before `<PipelineStatus />`, add a new Escalations section:

```tsx
{/* Pending Escalations */}
{!escalationsLoading && escalations && escalations.length > 0 && (
  <Card>
    <CardHeader>
      <CardTitle>Pending Escalations</CardTitle>
    </CardHeader>
    <CardContent>
      <div className="space-y-4">
        {escalations.map((esc) => {
          const workItem = workItems?.find((wi) => wi.id === esc.workItemId);
          const timeElapsed = Math.floor(
            (Date.now() - new Date(esc.createdAt).getTime()) / 1000 / 60
          );
          const timeString =
            timeElapsed < 60
              ? `${timeElapsed}m ago`
              : timeElapsed < 1440
                ? `${Math.floor(timeElapsed / 60)}h ago`
                : `${Math.floor(timeElapsed / 1440)}d ago`;

          return (
            <div
              key={esc.id}
              className="border rounded-lg p-3 bg-red-50 border-red-200"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <p className="font-semibold text-sm">{workItem?.title ?? esc.workItemId}</p>
                  <p className="text-xs text-gray-600 mt-1">{esc.reason}</p>
                  <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
                    <span>Confidence: {Math.round(esc.confidenceScore * 100)}%</span>
                    <span>\u2022</span>
                    <span>{timeString}</span>
                  </div>
                </div>
                <a
                  href={`/api/escalations/${esc.id}/resolve`}
                  className="text-blue-600 hover:underline text-xs font-medium whitespace-nowrap ml-2"
                  title="Manual resolution via API (Handoff 12: Gmail integration coming)"
                >
                  Resolve
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </CardContent>
  </Card>
)}
```

Commit:
```bash
git add app/(app)/page.tsx
git commit -m "feat: add Blocked stat card and Escalations section to dashboard"
```

## Verification

Run all checks:

```bash
# TypeScript compiles
npx tsc --noEmit

# Build succeeds
npm run build

# Dev server starts (run briefly to check for runtime crashes)
timeout 15 npm run dev || true

# Verify new files exist
test -f lib/escalation.ts && echo "OK: lib/escalation.ts" || echo "MISSING: lib/escalation.ts"
test -f app/api/escalations/route.ts && echo "OK: app/api/escalations/route.ts" || echo "MISSING: app/api/escalations/route.ts"
test -f app/api/escalations/\[id\]/resolve/route.ts && echo "OK: app/api/escalations/[id]/resolve/route.ts" || echo "MISSING: app/api/escalations/[id]/resolve/route.ts"

# Verify type union includes "blocked"
grep -q 'status.*blocked' lib/types.ts && echo "OK: blocked status in types" || echo "MISSING: blocked status in types"

# Verify escalation event types
grep -q 'escalation_timeout' lib/types.ts && echo "OK: escalation event types in ATCEvent" || echo "MISSING: escalation event types"
```

**Expected behavior:**
- Dashboard loads with Blocked stat card (shows 0 when no escalations)
- Escalations section is hidden when there are no pending escalations
- Escalations section is shown when pending escalations exist, with reason, confidence, and time elapsed
- `/api/escalations` returns empty array initially
- `/api/escalations` (POST with valid body) creates an escalation and transitions work item to "blocked"
- Work item's `escalation` field is populated when blocked
- ATC sweep logs nothing for escalation timeout (no pending escalations)
- After 24h, escalation is marked expired (next ATC sweep) and `escalation_timeout` event is logged

## Step 8: Commit, push, open PR

```bash
git push origin feat/escalation-state-machine

gh pr create --title "feat: Escalation state machine (Phase 2f)" --body "## Summary
- New `lib/escalation.ts`: Core escalation module with CRUD and state transitions
- New `app/api/escalations/route.ts`: GET (list, with ?status filter) and POST (create escalation)
- New `app/api/escalations/[id]/resolve/route.ts`: POST to resolve escalation and transition work item back to queued
- Added 'blocked' status to WorkItem status union in `lib/types.ts`
- Added escalation event types to ATCEvent union: 'escalation', 'escalation_timeout', 'escalation_resolved'
- Added optional `escalation` field to WorkItem interface (populated when status is 'blocked')
- ATC section 10: Escalation timeout monitoring (marks escalations older than 24h as expired, logs event)
- New `useEscalations` SWR hook in `lib/hooks.ts` (refreshInterval: 15s)
- Dashboard: Added Blocked stat card (red, counts blocked work items)
- Dashboard: Added Escalations section showing pending escalations with reason, confidence, and age

## Architecture
Escalations are internal state records (Phase 2f). No external integrations yet. When the ATC or an executor encounters an unresolvable condition, it calls `escalate()` to create an Escalation record and transition the work item to 'blocked'. Humans can manually resolve via API (future: Gmail integration in Handoff 12 will provide email-based resolution).

Escalations are monitored by the ATC for timeout (24h). Expired escalations are not auto-resolved; they remain blocked until manual intervention.

## Files Changed
- `lib/escalation.ts` (new)
- `lib/types.ts` (added 'blocked' status, escalation event types, escalation field to WorkItem)
- `lib/atc.ts` (added section 10: escalation timeout monitoring)
- `lib/hooks.ts` (added useEscalations hook)
- `app/api/escalations/route.ts` (new)
- `app/api/escalations/[id]/resolve/route.ts` (new)
- `app/(app)/page.tsx` (added Blocked stat card, Escalations section)

## Verification
- [x] npx tsc --noEmit passes
- [x] npm run build passes
- [ ] Dashboard loads with Blocked = 0 and no Escalations section
- [ ] POST /api/escalations creates escalation, work item transitions to blocked
- [ ] Dashboard shows pending escalation with reason and confidence
- [ ] ATC sweep runs without errors
- [ ] After 24h (simulated), escalation marked expired and escalation_timeout event logged

## Risk
Medium. Adds new status 'blocked' to work item union (additive, no breaking changes). Storage pattern follows existing escalation storage pattern. All new API endpoints are isolated."

gh pr merge --auto --squash
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/escalation-state-machine
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```