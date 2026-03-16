# Agent Forge -- Add escalation status handling and email notification

## Metadata
- **Branch:** `feat/fast-lane-escalation-flow`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/escalation.ts, lib/work-items.ts, lib/types.ts

## Context

Agent Forge has a fast-lane pipeline for dispatching work items directly. When items encounter problems (spec review flags, budget overruns, complexity issues), they need to be escalated to James via email and excluded from further dispatch. This builds on existing infrastructure:

- `lib/gmail.ts` — Already has `sendEmail()` function for Gmail OAuth2 email delivery
- `lib/escalation.ts` — Already has escalation state machine logic for escalation records (pending/resolved/expired). We need to add `escalateFastLaneItem()` that updates the work item status AND sends email.
- `lib/work-items.ts` — Has `getNextDispatchable()` which selects the next work item for dispatch. It must skip `'escalated'` items.
- `lib/types.ts` — `WorkItem` type has a `status` field. We need to verify `'escalated'` is a valid status value.

The existing `sendEscalationEmail()` in `lib/gmail.ts` or `sendEmail()` should be reused. Check what email utilities are available before implementing.

Recent patterns from merged PRs show that new status handling goes in `lib/work-items.ts` and new flow logic goes in the relevant lib file (`lib/escalation.ts` here).

## Requirements

1. `escalateFastLaneItem(workItemId: string, reason: EscalationReason, details: string)` function added to `lib/escalation.ts`
2. The function transitions the work item's status to `'escalated'` in Vercel Blob storage via `lib/work-items.ts` or `lib/storage.ts`
3. The function sends an email via existing Gmail infrastructure with the specified subject/body format
4. Email subject: `[Agent Forge] Fast Lane Item Escalated: {first 60 chars of description}`
5. Email body includes: full description, target repo, escalation reason (human-readable), and a note about retry/promote options
6. Three escalation reasons supported: `'spec_review_flag'`, `'budget_exceeded'`, `'complexity_flag'`
7. `getNextDispatchable()` in `lib/work-items.ts` excludes items with `status === 'escalated'`
8. `'escalated'` is a valid `WorkItemStatus` type in `lib/types.ts` (add if missing)
9. All TypeScript compiles without errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/fast-lane-escalation-flow
```

### Step 1: Read existing code to understand current state

Read and understand the relevant files before making any changes:

```bash
cat lib/types.ts
cat lib/escalation.ts
cat lib/work-items.ts
cat lib/gmail.ts
```

Key things to check:
- What is the current `WorkItemStatus` type definition in `lib/types.ts`? Does it already include `'escalated'`?
- What email-sending utilities exist in `lib/gmail.ts`? (look for `sendEmail`, `sendEscalationEmail`, or similar)
- What does `getNextDispatchable()` currently filter on?
- What does the existing `lib/escalation.ts` export and how does it update work item state?
- How are work items updated in storage (look for `updateWorkItem` or similar in `lib/work-items.ts`)

### Step 2: Add 'escalated' to WorkItemStatus type in lib/types.ts

Find the `WorkItemStatus` type (likely a union type or enum). If `'escalated'` is not already present, add it:

```typescript
// Before (example):
export type WorkItemStatus = 'filed' | 'ready' | 'queued' | 'generating' | 'executing' | 'reviewing' | 'merged' | 'blocked' | 'parked';

// After:
export type WorkItemStatus = 'filed' | 'ready' | 'queued' | 'generating' | 'executing' | 'reviewing' | 'merged' | 'blocked' | 'parked' | 'escalated';
```

Only add it if it's not already there.

### Step 3: Update getNextDispatchable() in lib/work-items.ts

Find `getNextDispatchable()` and ensure it filters out `'escalated'` items. Look for where it filters by status (likely filtering for `'ready'` items). The existing filter may already handle this implicitly (if it only selects `'ready'` status), but make it explicit:

```typescript
// Ensure escalated items are never dispatched
// If the function already filters for status === 'ready', escalated items are already excluded.
// If there's a more permissive filter or an explicit exclusion list, add 'escalated' to it.

// Example — if there's an exclusion pattern like:
const TERMINAL_STATUSES: WorkItemStatus[] = ['merged', 'blocked', 'parked'];
// Update to:
const TERMINAL_STATUSES: WorkItemStatus[] = ['merged', 'blocked', 'parked', 'escalated'];
```

If the function only selects items with `status === 'ready'`, note in a comment that `'escalated'` items are implicitly excluded but verify the logic is correct.

### Step 4: Add escalateFastLaneItem() to lib/escalation.ts

Add the `EscalationReason` type and `escalateFastLaneItem()` function. Use the existing email utility found in Step 1.

```typescript
// Add near top of file with other types/constants:
export type EscalationReason = 'spec_review_flag' | 'budget_exceeded' | 'complexity_flag';

const ESCALATION_REASON_LABELS: Record<EscalationReason, string> = {
  spec_review_flag: 'Spec Review Flag — handoff was flagged during TLM spec review',
  budget_exceeded: 'Budget Exceeded — estimated cost exceeds fast-lane budget threshold',
  complexity_flag: 'Complexity Flag — item is too complex for fast-lane execution',
};

export async function escalateFastLaneItem(
  workItemId: string,
  reason: EscalationReason,
  details: string
): Promise<void> {
  // 1. Load the work item
  const workItem = await getWorkItem(workItemId); // use whatever the existing lookup function is
  if (!workItem) {
    throw new Error(`Work item ${workItemId} not found`);
  }

  // 2. Transition status to 'escalated'
  await updateWorkItem(workItemId, { status: 'escalated' }); // use existing update pattern

  // 3. Send escalation email
  const truncatedDescription = workItem.description.slice(0, 60);
  const subject = `[Agent Forge] Fast Lane Item Escalated: ${truncatedDescription}`;

  const reasonLabel = ESCALATION_REASON_LABELS[reason];

  const body = `
A fast-lane work item has been escalated and requires your attention.

Work Item ID: ${workItemId}
Target Repo: ${workItem.repoFullName ?? workItem.repo ?? 'unknown'}
Description: ${workItem.description}

Escalation Reason: ${reasonLabel}

Details:
${details}

---
Options:
- Retry as fast-lane: Update the item status back to 'ready' in the Agent Forge dashboard.
- Promote to full project: Create a new project in Notion and file a full work item with expanded scope.
- Dismiss: Mark as 'parked' if this item is no longer relevant.

View item: https://agent-forge.vercel.app/work-items/${workItemId}
`.trim();

  // Use the email utility found in Step 1 (sendEmail, sendEscalationEmail, etc.)
  await sendEmail({ subject, body }); // adjust call signature to match existing utility
}
```

**Important:** Adjust the function signatures, import paths, and field names (`workItem.repoFullName`, `workItem.repo`, etc.) to match what actually exists in the codebase. Do not guess — read the actual types from `lib/types.ts` and actual exports from `lib/gmail.ts`.

### Step 5: Wire up imports

Ensure `lib/escalation.ts` imports:
- The work item lookup and update functions from `lib/work-items.ts`
- The email utility from `lib/gmail.ts`

Check for circular import issues: `lib/escalation.ts` importing from `lib/work-items.ts` while `lib/work-items.ts` may import from `lib/escalation.ts`. If circular imports exist:
- Extract the `updateWorkItem` call to use `lib/storage.ts` directly
- Or restructure to avoid the cycle

### Step 6: Verification

```bash
npx tsc --noEmit
```

Fix any TypeScript errors before proceeding. Common issues:
- Missing imports
- Field names that don't match `WorkItem` type
- Email utility call signature mismatch
- `EscalationReason` not exported

```bash
npm run build
```

Verify the build succeeds.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add escalateFastLaneItem() and escalated status handling"
git push origin feat/fast-lane-escalation-flow
gh pr create \
  --title "feat: add escalation status handling and email notification for fast-lane items" \
  --body "## Summary

Implements the escalation flow for fast-lane work items.

## Changes

### \`lib/types.ts\`
- Added \`'escalated'\` to \`WorkItemStatus\` union type (if not already present)

### \`lib/escalation.ts\`
- Added \`EscalationReason\` type: \`'spec_review_flag' | 'budget_exceeded' | 'complexity_flag'\`
- Added \`escalateFastLaneItem(workItemId, reason, details)\` function that:
  - Transitions work item status to \`'escalated'\` in storage
  - Sends email via Gmail with item description, target repo, escalation reason, and retry/promote options
  - Email subject: \`[Agent Forge] Fast Lane Item Escalated: {truncated description}\`

### \`lib/work-items.ts\`
- Verified/updated \`getNextDispatchable()\` to exclude items with \`status === 'escalated'\`

## Acceptance Criteria
- [x] \`escalateFastLaneItem()\` transitions work item status to \`'escalated'\`
- [x] Email sent via Gmail with description, reason, target repo, and options
- [x] Email subject includes truncated description
- [x] \`getNextDispatchable()\` excludes escalated items
- [x] Three escalation reasons supported
- [x] TypeScript compiles without errors"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/fast-lane-escalation-flow
FILES CHANGED: [list files actually modified]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "circular import between escalation.ts and work-items.ts needs resolution"]
```

## Escalation Protocol

If blocked by ambiguous requirements, missing email utility signatures, circular import issues requiring architectural decisions, or repeated TypeScript failures after 3 attempts:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-escalation-status-handling-and-email-notification",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/escalation.ts", "lib/work-items.ts"]
    }
  }'
```