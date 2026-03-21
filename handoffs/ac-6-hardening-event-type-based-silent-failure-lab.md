<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- AC-6 Hardening: Event-Type-Based Silent Failure Labels

## Metadata
- **Branch:** `feat/ac6-silent-failure-type-field`
- **Priority:** low
- **Model:** sonnet
- **Type:** refactor
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** `lib/types.ts`, `lib/escalation.ts`, `components/escalation-card.tsx`, `app/api/escalations/route.ts`

## Context

PR #416 implemented AC-6 silent failure indicators for escalation cards. The current implementation in `components/escalation-card.tsx` uses a `getSilentFailureLabel` function that string-matches on escalation `reason` text to determine what kind of silent failure occurred. This is fragile — any change to reason text wording will silently break the labels.

The event bus already emits typed events (`decomposer_empty_output`, `spec_review_stall`, `empty_context_guard`, `escalation_dedup`) per PR #385. The `activity-feed.tsx` component already does this correctly by reading `event.type` directly from the event payload.

The fix is to add a `silentFailureType` field to the `Escalation` type, populate it when an escalation is created from a silent failure detection event, and update `escalation-card.tsx` to branch on `silentFailureType` instead of regex-matching `reason`.

## Requirements

1. Add an optional `silentFailureType` field to the `Escalation` type in `lib/types.ts` — typed as a string union matching the known event types (`'decomposer_empty_output' | 'spec_review_stall' | 'empty_context_guard' | 'escalation_dedup'`) or left as `string` for forward-compatibility.
2. Update `lib/escalation.ts` (the escalation creation logic) to accept and persist `silentFailureType` when provided.
3. Update `components/escalation-card.tsx` to read `escalation.silentFailureType` instead of calling `getSilentFailureLabel(reason)`. Keep `getSilentFailureLabel` as a fallback if `silentFailureType` is absent (for existing escalations stored without the field).
4. Update any escalation-creation call sites in the codebase that create escalations from silent failure events to pass the appropriate `silentFailureType` value.
5. Ensure the `POST /api/escalations` route (or wherever escalations are persisted) forwards `silentFailureType` through to storage.
6. TypeScript must compile without errors (`npx tsc --noEmit`).
7. No existing tests should break.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/ac6-silent-failure-type-field
```

### Step 1: Audit the current codebase

Before making changes, read the relevant files to understand the current shape:

```bash
# Read the Escalation type definition
cat lib/types.ts | grep -A 30 "Escalation"

# Read the escalation creation logic
cat lib/escalation.ts

# Read the current fragile implementation
cat components/escalation-card.tsx

# Read the correct reference implementation
cat components/activity-feed.tsx

# Find all places escalations are created
grep -rn "createEscalation\|/api/escalations\|escalation_dedup\|spec_review_stall\|decomposer_empty_output\|empty_context_guard" --include="*.ts" --include="*.tsx" .
```

### Step 2: Update `lib/types.ts` — add `silentFailureType` to `Escalation`

Locate the `Escalation` type/interface. Add the optional field:

```typescript
// Known silent failure event types (mirrors event bus event types from PR #385)
export type SilentFailureEventType =
  | 'decomposer_empty_output'
  | 'spec_review_stall'
  | 'empty_context_guard'
  | 'escalation_dedup';

export interface Escalation {
  // ... existing fields ...
  silentFailureType?: SilentFailureEventType | string; // string for forward-compat
}
```

If `Escalation` is defined elsewhere (e.g. inline in `lib/escalation.ts`), add the field there. Export `SilentFailureEventType` so it can be used in other files.

### Step 3: Update `lib/escalation.ts` — accept and persist `silentFailureType`

Find the escalation creation function (likely `createEscalation` or similar). Add `silentFailureType` to its input and ensure it's written to the stored record:

```typescript
// Example shape — adapt to match actual function signature
export async function createEscalation(params: {
  workItemId: string;
  reason: string;
  silentFailureType?: SilentFailureEventType | string; // ADD THIS
  // ... other existing params ...
}): Promise<Escalation> {
  const escalation: Escalation = {
    // ... existing field mapping ...
    silentFailureType: params.silentFailureType, // ADD THIS
  };
  // persist and return
}
```

If escalation persistence goes through Vercel Blob, make sure the serialized JSON includes `silentFailureType`.

### Step 4: Update `app/api/escalations/route.ts` (if it exists)

If there's a POST handler for `/api/escalations`, ensure it reads `silentFailureType` from the request body and forwards it to `createEscalation`:

```typescript
const { workItemId, reason, silentFailureType, ...rest } = await req.json();
await createEscalation({ workItemId, reason, silentFailureType, ...rest });
```

### Step 5: Find and update silent-failure escalation call sites

Search for the places that create escalations in response to silent failure events (likely in `lib/atc/health-monitor.ts`, `lib/atc/dispatcher.ts`, `lib/pm-agent.ts`, or similar). Pass the structured type:

```typescript
// Example — adapt to real call sites
await createEscalation({
  workItemId: item.id,
  reason: 'Decomposer produced empty output for this work item',
  silentFailureType: 'decomposer_empty_output', // ADD THIS
});

await createEscalation({
  workItemId: item.id,
  reason: 'Spec review stalled without producing output',
  silentFailureType: 'spec_review_stall', // ADD THIS
});
```

If the call sites are in the escalation API route (i.e., an upstream agent POSTs to `/api/escalations` with a body), update those upstream callers to include `silentFailureType` in the POST body.

### Step 6: Update `components/escalation-card.tsx` — use `silentFailureType`

Replace the fragile string-match approach with a structured lookup, keeping the old `getSilentFailureLabel` as a fallback:

```typescript
// Keep for backward compatibility with old stored escalations
function getSilentFailureLabel(reason: string): { label: string; description: string } | null {
  // ... existing implementation unchanged ...
}

// New: derive label from structured type field
function getLabelFromType(type: string): { label: string; description: string } | null {
  switch (type) {
    case 'decomposer_empty_output':
      return { label: 'Empty Output', description: 'Decomposer produced no work items' };
    case 'spec_review_stall':
      return { label: 'Spec Review Stall', description: 'Spec review did not complete' };
    case 'empty_context_guard':
      return { label: 'Empty Context', description: 'Context was empty when execution started' };
    case 'escalation_dedup':
      return { label: 'Duplicate Escalation', description: 'This escalation was deduplicated' };
    default:
      return null;
  }
}

// In the component, replace:
//   const silentFailure = getSilentFailureLabel(escalation.reason);
// With:
const silentFailure = escalation.silentFailureType
  ? (getLabelFromType(escalation.silentFailureType) ?? getSilentFailureLabel(escalation.reason))
  : getSilentFailureLabel(escalation.reason);
```

Make sure the label strings in `getLabelFromType` match whatever was displayed by `getSilentFailureLabel` for the same scenarios, so the UI is visually identical for new escalations.

### Step 7: Type-check and build

```bash
npx tsc --noEmit
npm run build
```

Fix any type errors. Common issues:
- If `Escalation` is used as a Zod schema elsewhere, add `.optional()` for `silentFailureType`
- If there are JSON serialization roundtrips, ensure `silentFailureType` survives them (it should, being a plain string)

### Step 8: Verify no regressions

```bash
# If tests exist
npm test

# Manual grep-check: make sure getSilentFailureLabel is still called as fallback
grep -n "getSilentFailureLabel\|silentFailureType\|getLabelFromType" components/escalation-card.tsx

# Confirm types export cleanly
grep -n "SilentFailureEventType\|silentFailureType" lib/types.ts lib/escalation.ts
```

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "refactor: use silentFailureType field on Escalation instead of reason string-matching

AC-6 hardening: adds structured silentFailureType to the Escalation type,
populated at creation time from the originating event type. escalation-card.tsx
now branches on silentFailureType (with getSilentFailureLabel fallback for legacy
records). Mirrors pattern already used correctly in activity-feed.tsx.

Closes AC-6 hardening."

git push origin feat/ac6-silent-failure-type-field

gh pr create \
  --title "refactor: AC-6 hardening — event-type-based silent failure labels" \
  --body "## Summary

Hardens the AC-6 silent failure indicator implementation from PR #416.

### Problem
\`getSilentFailureLabel\` in \`escalation-card.tsx\` used regex/string-matching on
escalation \`reason\` text to determine the failure label. Any wording change to
reason strings silently breaks the labels.

### Solution
- Added \`silentFailureType?: SilentFailureEventType | string\` to the \`Escalation\` type
- \`createEscalation\` now accepts and persists \`silentFailureType\`
- Escalation-creation call sites from silent failure events now pass the structured type
- \`escalation-card.tsx\` reads \`silentFailureType\` first, falls back to \`getSilentFailureLabel(reason)\` for legacy records without the field
- Mirrors the pattern already used correctly in \`activity-feed.tsx\` (event.type)

### Backward Compatibility
Old escalations stored without \`silentFailureType\` still display correctly via the
\`getSilentFailureLabel\` fallback. No data migration needed.

### Testing
- \`npx tsc --noEmit\` passes
- \`npm run build\` passes
- Visual output unchanged for all escalation card scenarios"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/ac6-silent-failure-type-field
FILES CHANGED: [list modified files]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g. "call sites not updated", "API route not patched"]
```

## Escalation Protocol

If you encounter an unresolvable blocker (e.g. `Escalation` type is auto-generated from a schema and cannot be hand-edited, or the escalation persistence layer is not Blob/JSON but something opaque):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "ac6-silent-failure-type-field",
    "reason": "Cannot locate escalation creation call sites or Escalation type is generated/opaque",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error or blocker description>",
      "filesChanged": ["lib/types.ts", "lib/escalation.ts", "components/escalation-card.tsx"]
    }
  }'
```