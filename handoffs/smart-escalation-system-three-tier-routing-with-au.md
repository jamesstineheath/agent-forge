<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 5 -->

# Agent Forge -- Smart Escalation System: Three-Tier Routing with Auto-Resolution

## Metadata
- **Branch:** `feat/smart-escalation-three-tier-routing`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/escalation.ts, app/api/escalations/[id]/dismiss/route.ts

## Context

Currently 55% of escalations (11/20) are dismissed without action because they represent operational/engineering issues that don't require product owner judgment. The escalation system blindly emails the product owner for everything including CI failures, oversized decompositions, and circular dependencies.

The goal is a three-tier routing system:
- **Tier 1 (auto_resolve):** System handles silently — park+refile CI failures, proceed on oversized decompositions, auto-fail on empty plans/validation errors
- **Tier 2 (engineer):** File a bugfix work item and resolve — circular dependencies
- **Tier 3 (product_owner):** Email the human — scope/priority/direction questions and unrecognized cases

There's also a bug: `resolveEscalation()` updates the escalation record but never transitions the work item from `blocked` → `ready`, causing items to be stuck forever.

The 7 call sites in `lib/decomposer.ts`, `lib/atc/health-monitor.ts`, and `lib/atc/project-manager.ts` do NOT need changes — the classification layer handles routing transparently inside `escalate()`.

## Requirements

1. Add `EscalationTier` and `AutoResolutionAction` types to `lib/escalation.ts`
2. Add `classifyEscalation(reason, context)` function with pattern-matching decision tree
3. Refactor `escalate()` to call `classifyEscalation()` and route to the appropriate handler
4. Implement `handleAutoResolve()`, `handleEngineerEscalation()`, `handleProductOwnerEscalation()`
5. Implement `unblockWorkItem(workItemId)` helper — transitions `blocked` → `ready`
6. Fix `resolveEscalation()` to call `unblockWorkItem()` so resolved items don't stay blocked forever
7. In `handleAutoResolve()` for `park_and_refile`: update work item to `parked`, create new work item titled `"Retry (different approach): {original title}"` with error context
8. Auto-resolution failures must fall back to `product_owner` tier and send email
9. All escalations create audit records regardless of tier
10. Update `app/api/escalations/[id]/dismiss/route.ts` to set recovery status to `ready` (not `queued`)
11. No changes to `lib/decomposer.ts`, `lib/atc/health-monitor.ts`, `lib/atc/project-manager.ts`, or `lib/gmail.ts`'s `sendEscalationEmail()` signature

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/smart-escalation-three-tier-routing
```

### Step 1: Read existing escalation code

Read the current implementation thoroughly before touching anything:

```bash
cat lib/escalation.ts
cat lib/gmail.ts
cat app/api/escalations/[id]/dismiss/route.ts
cat lib/work-items.ts
cat lib/types.ts
```

Understand:
- The current `escalate()` signature and parameters
- The `Escalation` type shape
- How `createWorkItem()` works (for filing engineer-tier work items and park_and_refile)
- How `updateWorkItem()` works
- The `WorkItem` status field values
- What `sendEscalationEmail()` expects

### Step 2: Add types and `classifyEscalation()` to `lib/escalation.ts`

Add the following types near the top of the file (after existing imports/types):

```typescript
type EscalationTier = 'auto_resolve' | 'engineer' | 'product_owner';

type AutoResolutionAction =
  | { type: 'park_and_refile'; errorContext: string }
  | { type: 'skip_and_defer'; deferTo: 'pm_sweep' }
  | { type: 'auto_fail_project' }
  | { type: 'proceed_anyway'; reason: string };

type EscalationClassification =
  | { tier: 'auto_resolve'; action: AutoResolutionAction }
  | { tier: 'engineer' }
  | { tier: 'product_owner' };
```

Add the `classifyEscalation()` function:

```typescript
function classifyEscalation(reason: string, context?: Record<string, unknown>): EscalationClassification {
  const r = reason.toLowerCase();

  // CI failure after retry → park and refile
  if (r.includes('ci failed') || r.includes('ci failure') || r.includes('failed with code error')) {
    return {
      tier: 'auto_resolve',
      action: { type: 'park_and_refile', errorContext: reason }
    };
  }

  // Decomposition oversized / sub-phase → proceed anyway
  if (r.includes('decomposition produced') && r.includes('items') && r.includes('max')) {
    return {
      tier: 'auto_resolve',
      action: { type: 'proceed_anyway', reason: 'Oversized decomposition — proceeding with all items' }
    };
  }
  // Also catch sub-phase oversized pattern
  if (r.includes('sub-phase') && (r.includes('oversized') || r.includes('too large') || r.includes('exceed'))) {
    return {
      tier: 'auto_resolve',
      action: { type: 'proceed_anyway', reason: 'Oversized sub-phase — proceeding anyway' }
    };
  }

  // Empty plan → auto-fail project
  if (r.includes('plan page is empty') || r.includes('empty plan') || r.includes('no target repo')) {
    return {
      tier: 'auto_resolve',
      action: { type: 'auto_fail_project' }
    };
  }

  // Plan validation errors → auto-fail; warnings → defer to PM sweep
  if (r.includes('plan validation found') || r.includes('plan validation')) {
    const hasErrors = r.includes('error') || r.includes('invalid') || r.includes('failed');
    const onlyWarnings = r.includes('warning') && !hasErrors;
    if (onlyWarnings) {
      return {
        tier: 'auto_resolve',
        action: { type: 'skip_and_defer', deferTo: 'pm_sweep' }
      };
    }
    return {
      tier: 'auto_resolve',
      action: { type: 'auto_fail_project' }
    };
  }

  // Circular dependency → engineer tier
  if (r.includes('circular dependency') || r.includes('circular dep')) {
    return { tier: 'engineer' };
  }

  // Default: product owner
  return { tier: 'product_owner' };
}
```

### Step 3: Add `unblockWorkItem()` helper

Add this function to `lib/escalation.ts`:

```typescript
async function unblockWorkItem(workItemId: string): Promise<void> {
  try {
    const workItem = await getWorkItem(workItemId);
    if (workItem && workItem.status === 'blocked') {
      await updateWorkItem(workItemId, { status: 'ready' });
    }
  } catch (err) {
    console.error(`[escalation] Failed to unblock work item ${workItemId}:`, err);
    // Non-fatal: escalation record is already updated
  }
}
```

Note: Check what imports/functions are available from `lib/work-items.ts`. If `getWorkItem` and `updateWorkItem` aren't already imported, add them.

### Step 4: Fix `resolveEscalation()` — unblock on resolution

Find the existing `resolveEscalation()` function. After it successfully updates the escalation record to resolved status, add a call to unblock the work item:

```typescript
// Inside resolveEscalation(), after updating the escalation blob:
if (escalation.workItemId) {
  await unblockWorkItem(escalation.workItemId);
}
```

Place this after the successful save of the escalation record, before returning.

### Step 5: Add tier handler functions

Add these three handler functions to `lib/escalation.ts`:

```typescript
async function handleAutoResolve(
  escalation: Escalation,
  action: AutoResolutionAction
): Promise<void> {
  console.log(`[escalation] Auto-resolving ${escalation.id} via action: ${action.type}`);

  switch (action.type) {
    case 'park_and_refile': {
      // Park the original work item
      if (escalation.workItemId) {
        await updateWorkItem(escalation.workItemId, { status: 'parked' });
        // Get original work item to build new title
        const original = await getWorkItem(escalation.workItemId);
        if (original) {
          // File a new work item for a different approach
          await createWorkItem({
            title: `Retry (different approach): ${original.title}`,
            description: `Original work item ${escalation.workItemId} was parked due to CI failure.\n\nError context:\n${action.errorContext}\n\nPlease attempt a different implementation approach to resolve this.`,
            status: 'ready',
            priority: original.priority ?? 'medium',
            repoId: original.repoId,
            projectId: original.projectId,
          });
        }
      }
      break;
    }
    case 'proceed_anyway': {
      // Just unblock — work proceeds normally
      if (escalation.workItemId) {
        await unblockWorkItem(escalation.workItemId);
      }
      break;
    }
    case 'auto_fail_project': {
      // Resolve escalation; project failure handled by existing project lifecycle
      // Work item remains blocked (it can't proceed with no valid plan)
      break;
    }
    case 'skip_and_defer': {
      // Unblock — PM sweep will catch this on next cycle
      if (escalation.workItemId) {
        await unblockWorkItem(escalation.workItemId);
      }
      break;
    }
  }
}

async function handleEngineerEscalation(escalation: Escalation): Promise<void> {
  console.log(`[escalation] Filing engineer bugfix work item for escalation ${escalation.id}`);

  // File a bugfix work item with the escalation context
  await createWorkItem({
    title: `Bug: ${escalation.reason.slice(0, 100)}`,
    description: `Auto-filed by escalation system (Tier 2 — Engineer).\n\nEscalation ID: ${escalation.id}\nOriginal work item: ${escalation.workItemId ?? 'N/A'}\n\nReason:\n${escalation.reason}\n\nContext:\n${JSON.stringify(escalation.context ?? {}, null, 2)}`,
    status: 'ready',
    priority: 'high',
    // Use same repoId/projectId if available on escalation, otherwise leave undefined
    ...(escalation.repoId ? { repoId: escalation.repoId } : {}),
    ...(escalation.projectId ? { projectId: escalation.projectId } : {}),
  });

  // Unblock the original item — it was blocked waiting for human, now engineer handles it
  if (escalation.workItemId) {
    await unblockWorkItem(escalation.workItemId);
  }
}

async function handleProductOwnerEscalation(escalation: Escalation): Promise<void> {
  console.log(`[escalation] Sending product owner email for escalation ${escalation.id}`);
  await sendEscalationEmail(escalation);
}
```

**Important:** Check the actual `Escalation` type shape for fields like `repoId`, `projectId`, `context`. Adjust field access to match what actually exists on the type. If `Escalation` doesn't have `repoId`/`projectId`, remove those lines from the engineer handler.

Also check the actual `createWorkItem()` signature — match the parameter shape exactly. Look for what fields are required vs optional.

### Step 6: Refactor `escalate()` to use the classification system

Find the existing `escalate()` function. Refactor it to:

1. Always create the escalation record first (audit trail)
2. Call `classifyEscalation()`
3. Route to the appropriate handler
4. Wrap auto-resolve and engineer handlers in try/catch that falls back to product_owner

The refactored logic should look like:

```typescript
// After creating and saving the escalation record (keep existing save logic):

const classification = classifyEscalation(reason, context);
console.log(`[escalation] Classified as tier: ${classification.tier} for reason: "${reason.slice(0, 80)}"`);

// Mark the escalation with its tier (if the Escalation type supports it, otherwise skip)
// escalation.tier = classification.tier;  // only if field exists

try {
  if (classification.tier === 'auto_resolve') {
    await handleAutoResolve(escalation, classification.action);
    // Auto-resolve: mark escalation as resolved immediately
    await resolveEscalation(escalation.id, `Auto-resolved: ${classification.action.type}`);
    return escalation;
  }

  if (classification.tier === 'engineer') {
    await handleEngineerEscalation(escalation);
    await resolveEscalation(escalation.id, 'Auto-resolved: engineer work item filed');
    return escalation;
  }

  // product_owner tier
  await handleProductOwnerEscalation(escalation);

} catch (err) {
  console.error(`[escalation] Auto-resolution failed for ${escalation.id}, promoting to product_owner:`, err);
  // Fallback: email the product owner
  try {
    await handleProductOwnerEscalation(escalation);
  } catch (emailErr) {
    console.error(`[escalation] Failed to send fallback product owner email:`, emailErr);
  }
}

return escalation;
```

**Be careful:** `resolveEscalation()` itself now calls `unblockWorkItem()` (from Step 4). For `park_and_refile`, the work item was set to `parked` not `blocked`, so `unblockWorkItem()` will be a no-op (it only transitions `blocked` → `ready`). This is correct behavior.

**Also be careful:** Calling `resolveEscalation(escalation.id, ...)` from inside `escalate()` could cause infinite loops if `resolveEscalation` in turn calls `escalate`. Verify the existing `resolveEscalation` function only updates blob storage — it should not call `escalate`. If there's a risk of re-entrancy, inline the resolution logic instead.

### Step 7: Update dismiss route

Edit `app/api/escalations/[id]/dismiss/route.ts`:

Find where it sets the recovery/work item status after dismissal. Change any `'queued'` status assignment to `'ready'`:

```typescript
// Before:
await updateWorkItem(workItemId, { status: 'queued' });
// After:
await updateWorkItem(workItemId, { status: 'ready' });
```

If the route uses `resolveEscalation()` internally, the `unblockWorkItem()` fix from Step 4 will handle it automatically. Verify the route still makes sense — it should call `resolveEscalation()` which now auto-unblocks.

### Step 8: Verify no regressions in call sites

Check that existing callers are unaffected:

```bash
grep -n "escalate(" lib/decomposer.ts lib/atc/health-monitor.ts lib/atc/project-manager.ts
```

The `escalate()` function signature should be unchanged — only internal routing changes. Verify the function still exports the same signature.

Also check that `sendEscalationEmail` is no longer called directly from `escalate()` — it should only be called from `handleProductOwnerEscalation()`:

```bash
grep -n "sendEscalationEmail" lib/escalation.ts
```

Should only appear inside `handleProductOwnerEscalation`.

### Step 9: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors. Common issues to watch for:
- `Escalation` type missing fields referenced in new code (e.g., `repoId`, `projectId`, `context`) — remove or guard with optional chaining
- `createWorkItem()` parameter shape mismatch — check actual signature
- `resolveEscalation()` signature — check if it accepts a resolution message or just an ID
- Import additions needed for `getWorkItem`, `updateWorkItem`, `createWorkItem`

### Step 10: Commit, push, open PR

```bash
git add -A
git commit -m "feat: smart escalation three-tier routing with auto-resolution

- Add classifyEscalation() with pattern-matching decision tree
- Tier 1 (auto_resolve): CI failures park+refile, oversized decompositions proceed, empty plans auto-fail
- Tier 2 (engineer): circular deps file a bugfix work item
- Tier 3 (product_owner): unrecognized/scope questions email human
- Fix resolveEscalation() to unblock work items (blocked-forever bug)
- All escalations still create audit records regardless of tier
- Auto-resolution failures fall back to product_owner tier
- Update dismiss route to use 'ready' status instead of 'queued'"
git push origin feat/smart-escalation-three-tier-routing
gh pr create \
  --title "feat: smart escalation three-tier routing with auto-resolution" \
  --body "## Summary
Redesigns the escalation system to stop emailing the product owner for operational issues (was 55% dismiss rate).

## Changes
- **\`lib/escalation.ts\`**: Added \`classifyEscalation()\` decision tree, three tier handlers, \`unblockWorkItem()\` helper. Refactored \`escalate()\` to route by tier. Fixed \`resolveEscalation()\` to unblock work items.
- **\`app/api/escalations/[id]/dismiss/route.ts\`**: Recovery status now \`ready\` (was \`queued\`).

## Behavior by tier
| Escalation type | Before | After |
|---|---|---|
| CI failure after retry | Email product owner | Park item, refile with error context, no email |
| Oversized decomposition | Email product owner | Auto-resolve, proceed, no email |
| Empty plan / validation error | Email product owner | Auto-fail project, no email |
| Circular dependency | Email product owner | File bugfix work item, no email |
| Scope/priority/unrecognized | Email product owner | Email product owner ✓ |

## Bug fix
\`resolveEscalation()\` now calls \`unblockWorkItem()\` — previously resolved escalations left work items stuck in \`blocked\` forever.

## No changes to
Call sites in \`lib/decomposer.ts\`, \`lib/atc/health-monitor.ts\`, \`lib/atc/project-manager.ts\`, or \`lib/gmail.ts\` signature."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/smart-escalation-three-tier-routing
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you hit a blocker you cannot resolve autonomously (e.g., `Escalation` type is missing required fields, `createWorkItem` signature is incompatible, or `resolveEscalation` has re-entrancy risks that can't be safely resolved):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "<this-work-item-id>",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/escalation.ts", "app/api/escalations/[id]/dismiss/route.ts"]
    }
  }'
```