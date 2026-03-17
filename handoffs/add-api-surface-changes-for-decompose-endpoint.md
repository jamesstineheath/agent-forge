# Agent Forge -- Add API Surface Changes for Decompose Endpoint

## Metadata
- **Branch:** `feat/decompose-api-phase-surface`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** app/api/decompose/route.ts

## Context

The decomposer (`lib/decomposer.ts`) was recently updated to support recursive sub-phase decomposition (see merged PR: "feat: implement recursive sub-phase decomposition in decomposer"). The decomposer now returns phase metadata when a plan has 16-30 items that get split into sub-phases.

The `app/api/decompose/route.ts` POST handler needs to be updated to surface this phase information in its JSON response so callers (e.g., the dashboard, PA integration) can understand the structure of the decomposed work.

The changes are additive and backward-compatible:
- Responses for ≤15 items remain unchanged in structure (plus new `wasDecomposedIntoPhases: false` field)
- Responses for 16-30 items add `phases` array and `wasDecomposedIntoPhases: true`
- Error responses for 31+ items remain unchanged

## Requirements

1. The POST handler response must include `wasDecomposedIntoPhases: false` when the decomposer returns a flat list (≤15 items).
2. The POST handler response must include `wasDecomposedIntoPhases: true` and a `phases` array (each with `id`, `name`, `itemCount`) when the decomposer returns sub-phase information (16-30 items).
3. The `totalItems` field must always be present in successful responses.
4. Existing response fields (e.g., `items`) must be preserved for backward compatibility.
5. Error responses for 31+ item escalation remain unchanged.
6. TypeScript must compile without errors (`npx tsc --noEmit`).
7. No runtime errors in the route handler.

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decompose-api-phase-surface
```

### Step 1: Inspect current decompose route and decomposer types

Read the existing files to understand the current shape before modifying:

```bash
cat app/api/decompose/route.ts
cat lib/decomposer.ts
cat lib/types.ts
```

Pay attention to:
- What the decomposer's return type looks like (does it already include `phases`? Is there a `DecompositionResult` type?)
- What the current route handler returns in its JSON response
- Whether `phases` and `wasDecomposedIntoPhases` are already on the return type or need to be added to the type definitions

### Step 2: Update type definitions if needed

If `lib/types.ts` or `lib/decomposer.ts` doesn't already define the phase metadata on the decomposer's return type, add it.

Expected shape of the decomposer result (verify against actual code):

```typescript
// Phase info returned when sub-phases were used
interface DecompositionPhase {
  id: string;
  name: string;
  itemCount: number;
}

// Decomposer result shape (may already exist — verify first)
interface DecompositionResult {
  items: WorkItem[];           // flat list of all work items
  totalItems: number;
  wasDecomposedIntoPhases: boolean;
  phases?: DecompositionPhase[]; // only present when wasDecomposedIntoPhases === true
}
```

Only add types that are missing. Do not duplicate existing definitions.

### Step 3: Update `app/api/decompose/route.ts`

Modify the POST handler to pass through phase information from the decomposer result into the JSON response.

The updated handler should follow this pattern:

```typescript
// After calling the decomposer and receiving its result:
const result = await decompose(/* existing args */);

// Build the response, always including backward-compat fields
const responseBody: Record<string, unknown> = {
  // ... existing fields preserved ...
  items: result.items,
  totalItems: result.totalItems,
  wasDecomposedIntoPhases: result.wasDecomposedIntoPhases ?? false,
};

// Only include phases when sub-phases were used
if (result.wasDecomposedIntoPhases && result.phases) {
  responseBody.phases = result.phases;
}

return NextResponse.json(responseBody, { status: 200 });
```

**Important:** Preserve all existing response fields. Only add the new fields on top.

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding.

### Step 5: Manual smoke test (optional but recommended)

If the project has a way to run locally (`npm run dev`), quickly verify the route would respond correctly. Otherwise, read through the handler once more to confirm the logic is correct for all three cases:
- ≤15 items → `wasDecomposedIntoPhases: false`, no `phases` key
- 16-30 items → `wasDecomposedIntoPhases: true`, `phases` array present
- 31+ items → unchanged error response

### Step 6: Run build

```bash
npm run build
```

### Step 7: Run tests

```bash
npm test
```

If tests fail due to snapshot mismatches on the API response shape, update snapshots:

```bash
npm test -- --updateSnapshot
```

Only update snapshots if the new shape is correct and intentional.

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: surface phase metadata in decompose API response"
git push origin feat/decompose-api-phase-surface
gh pr create \
  --title "feat: surface phase metadata in decompose API response" \
  --body "## Summary

Updates the \`POST /api/decompose\` route handler to include sub-phase information in its response when the decomposer creates phases for 16-30 item plans.

## Changes

- \`app/api/decompose/route.ts\`: Updated response to include \`wasDecomposedIntoPhases\`, \`totalItems\`, and optional \`phases\` array
- Type definitions updated if needed to reflect decomposer return shape

## Response Shape

**Flat (≤15 items):**
\`\`\`json
{
  \"items\": [...],
  \"totalItems\": 10,
  \"wasDecomposedIntoPhases\": false
}
\`\`\`

**Phased (16-30 items):**
\`\`\`json
{
  \"items\": [...],
  \"totalItems\": 22,
  \"wasDecomposedIntoPhases\": true,
  \"phases\": [
    { \"id\": \"phase-1\", \"name\": \"Phase 1\", \"itemCount\": 11 },
    { \"id\": \"phase-2\", \"name\": \"Phase 2\", \"itemCount\": 11 }
  ]
}
\`\`\`

## Backward Compatibility

All existing response fields preserved. New fields are additive only.

## Risk

Low — additive API change, no existing callers broken."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decompose-api-phase-surface
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

If blocked by an ambiguous decomposer return type or missing phase metadata from the decomposer implementation, escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-api-surface-changes-for-decompose-endpoint",
    "reason": "Decomposer return type does not include phase metadata — unclear if phases are returned by decomposer or need to be computed in the route handler",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 2",
      "error": "DecompositionResult type missing wasDecomposedIntoPhases and phases fields; decomposer may not yet return this data",
      "filesChanged": []
    }
  }'
```