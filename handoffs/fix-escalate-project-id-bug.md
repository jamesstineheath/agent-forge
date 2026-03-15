# Handoff: Fix escalate() project-level bug (passes projectId as workItemId)

Max Budget: $3
**Dispatched:** 2026-03-15T14:05Z

## Context

In `lib/decomposer.ts`, the `decomposeProject()` function calls `escalate()` in 5 locations, always passing `project.projectId` as the first argument. But `escalate()` in `lib/escalation.ts` treats its first parameter as `workItemId`. This means:

1. The escalation record is created with `workItemId` set to a project ID (wrong entity type)
2. `escalate()` calls `getWorkItem(workItemId)` internally, which silently returns null (no work item with that ID exists)
3. The work item status update to "blocked" is silently skipped
4. The escalation email includes a bad workItemId reference

The decomposer correctly has no work item to reference (it escalates BEFORE any work items are created), so the fix is to make `escalate()` support project-level escalations.

## Pre-flight Self-check

- [ ] Read `lib/escalation.ts` -- confirm `escalate()` signature and the `getWorkItem()` call inside
- [ ] Read `lib/decomposer.ts` -- confirm all 5 `escalate()` call sites pass `project.projectId`
- [ ] Read `lib/types.ts` -- check the `Escalation` interface shape
- [ ] Read `app/api/escalations/route.ts` -- check if the POST handler also needs updating

## Step 0: Branch + Commit Setup

Branch: `fix/escalate-project-id-bug`
Base: latest `main`

```bash
git checkout main && git pull origin main
git checkout -b fix/escalate-project-id-bug
```

## Step 1: Add optional projectId to Escalation interface

In `lib/escalation.ts`, add an optional `projectId` field to the `Escalation` interface:

```typescript
export interface Escalation {
  id: string;
  workItemId: string;
  projectId?: string;  // <-- ADD THIS
  reason: string;
  // ... rest unchanged
}
```

## Step 2: Update escalate() to accept optional projectId

Change the `escalate()` function signature to accept an optional `projectId` parameter. When `projectId` is provided but no matching work item exists, skip the work item status update gracefully (instead of silently failing). Store the `projectId` on the escalation record.

Updated signature:

```typescript
export async function escalate(
  workItemId: string,
  reason: string,
  confidenceScore: number,
  contextSnapshot: Record<string, unknown>,
  projectId?: string
): Promise<Escalation> {
```

In the escalation object creation, add:
```typescript
  const escalation: Escalation = {
    id,
    workItemId,
    ...(projectId && { projectId }),
    reason,
    // ... rest unchanged
  };
```

The existing `getWorkItem(workItemId)` block already has an `if (workItem)` guard, so it will correctly skip the update when a project ID is passed. Add a log line for clarity:

```typescript
  const workItem = await getWorkItem(workItemId);
  if (workItem) {
    await updateWorkItem(workItemId, {
      status: "blocked",
      escalation: { id, reason, blockedAt: now },
    });
    // ... gmail code
  } else if (projectId) {
    console.log(`[escalation] Project-level escalation for project ${projectId} (no work item to block)`);
  }
```

## Step 3: Update decomposer.ts call sites

In `lib/decomposer.ts`, update all 5 `escalate()` calls to pass `project.projectId` as the new 5th argument (projectId) AND use a placeholder workItemId string to signal this is project-level:

```typescript
await escalate(
  `project:${project.projectId}`,  // workItemId -- prefixed to make it clear this isn't a real work item
  "Project has no plan URL",
  0.9,
  { projectId: project.projectId, title: project.title },
  project.projectId  // projectId
);
```

Apply the same pattern to all 5 call sites (lines with `await escalate(project.projectId,`). The `project:` prefix ensures no accidental collision with real work item IDs (which use `wi_` prefix).

## Step 4: Update API route (optional, if time allows)

In `app/api/escalations/route.ts`, the POST handler already accepts `workItemId` from the request body. Add optional `projectId` to the destructuring and pass it through:

```typescript
const { workItemId, reason, confidenceScore, contextSnapshot, projectId } = body;
// ...
const escalation = await escalate(workItemId, reason, confidenceScore ?? 0.7, contextSnapshot ?? {}, projectId);
```

## Step 5: Verification

- `npx tsc --noEmit` must pass
- `npm run build` must pass
- Grep for `escalate(project.projectId,` returns 0 results (all old call sites updated)
- Grep for `project:${project.projectId}` returns 5 results in decomposer.ts

## Abort Protocol

If the `projectId` field addition causes type errors downstream (e.g., in gmail.ts `sendEscalationEmail`), keep the Escalation interface change but make `projectId` usage purely additive (don't change any consuming code beyond decomposer.ts). Ship the minimal fix.

## Acceptance Criteria

1. `Escalation` interface has optional `projectId` field
2. `escalate()` accepts optional `projectId` parameter and logs appropriately for project-level escalations
3. All 5 decomposer.ts call sites pass a prefixed workItemId and the projectId
4. Build passes cleanly
