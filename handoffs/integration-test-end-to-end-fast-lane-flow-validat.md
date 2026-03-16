# Agent Forge -- Integration test: end-to-end fast lane flow validation

## Metadata
- **Branch:** `feat/fast-lane-integration-tests`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/__tests__/fast-lane.test.ts

## Context

Agent Forge is a dev orchestration platform built with Next.js App Router. Over recent work items, several interconnected components have been built:

1. **Fast Lane API** (`app/api/fast-lane/route.ts`): POST endpoint to create direct-source work items
2. **Daily Cap Enforcement** (`lib/daily-cap.ts`): Limits non-human producers (e.g. `qa-agent`) to N items/day; `james` is exempt
3. **MCP Tools** (`lib/mcp-tools.ts`): `create_fast_lane_item` tool that mirrors the fast-lane API
4. **Work Item Dispatch** (`lib/work-items.ts`): `getNextDispatchable()` returns items eligible for dispatch; direct-source items have no dependency requirements
5. **Escalation** (`lib/escalation.ts`): State machine for escalating/retrying work items
6. **Orchestrator** (`lib/orchestrator.ts`): Injects source metadata into generated handoffs

This task creates integration tests that validate the contracts between all these components. Look at existing test patterns before writing tests — check for any `__tests__` directories or `.test.ts` files already in the repo.

Key types from `lib/types.ts` to be aware of:
- `WorkItem` has fields: `id`, `title`, `description`, `status`, `source`, `triggeredBy`, `budget`, `complexity`, `dependencies`, etc.
- `source` is likely `'direct' | 'github' | 'notion' | 'project' | ...`
- Daily cap logic lives in `lib/daily-cap.ts`

Before implementing, read the actual source files to understand current interfaces:
- `app/api/fast-lane/route.ts`
- `lib/daily-cap.ts`
- `lib/work-items.ts`
- `lib/mcp-tools.ts`
- `lib/escalation.ts`
- `lib/types.ts`

## Requirements

1. Test creates a direct-source work item via `/api/fast-lane` (or equivalent) with minimal input and verifies it is stored with `source='direct'`, correct `triggeredBy`, and correct budget defaults
2. Test verifies direct-source items are returned by `getNextDispatchable()` without dependency checks blocking them
3. Test verifies that after escalation, a work item has `status='escalated'` and is excluded from `getNextDispatchable()` results
4. Test verifies retry flow: escalated item → retry → `status='filed'` with a new/reset budget
5. Test verifies daily cap: creating 3 items as `qa-agent` succeeds, the 4th is rejected with a 429-equivalent error
6. Test verifies daily cap bypass: `james` (human producer) can create items beyond the cap limit without rejection
7. Test verifies type validation: invalid `complexityHint` value is rejected; missing `description` is rejected
8. Test verifies MCP tool parity: `create_fast_lane_item` from `lib/mcp-tools.ts` produces the same result structure as the `/api/fast-lane` route
9. All tests pass in CI (`npm test`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/fast-lane-integration-tests
```

### Step 1: Understand the existing codebase

Read all relevant source files before writing any tests:

```bash
cat lib/types.ts
cat app/api/fast-lane/route.ts
cat lib/daily-cap.ts
cat lib/work-items.ts
cat lib/mcp-tools.ts
cat lib/escalation.ts
cat lib/storage.ts
```

Also check for existing test patterns:
```bash
find . -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" | grep -v node_modules
ls lib/__tests__/ 2>/dev/null || echo "No __tests__ dir yet"
cat package.json | grep -A 10 '"scripts"'
cat jest.config* 2>/dev/null || cat vitest.config* 2>/dev/null || echo "No test config found"
```

### Step 2: Understand test infrastructure

Check if Jest or Vitest is configured, and what test utilities exist:

```bash
cat tsconfig.json
ls -la __mocks__/ 2>/dev/null || echo "No __mocks__ dir"
# Look at any existing test files for patterns
find . -name "*.test.*" | grep -v node_modules | head -5 | xargs -I{} cat {}
```

Note whether the project uses:
- `jest` or `vitest`
- Any mock for Vercel Blob / storage
- Any test database setup

### Step 3: Create the test directory (if needed)

```bash
mkdir -p lib/__tests__
```

### Step 4: Write the integration tests

Create `lib/__tests__/fast-lane.test.ts`. The exact implementation depends on what you find in Step 1-2, but the structure should be:

```typescript
/**
 * Integration tests: End-to-end fast lane flow validation
 *
 * These tests validate the contracts between:
 * - /api/fast-lane route (or equivalent helper)
 * - lib/daily-cap.ts
 * - lib/work-items.ts (getNextDispatchable)
 * - lib/mcp-tools.ts (create_fast_lane_item)
 * - lib/escalation.ts
 */

// NOTE: After reading source files in Steps 1-2, adapt imports and mocks
// to match actual module signatures. The structure below is a guide.

// --- Imports (adapt to actual exports) ---
// import { createFastLaneItem } from '../../lib/mcp-tools'
// import { getNextDispatchable, getWorkItem, updateWorkItem } from '../../lib/work-items'
// import { checkDailyCap, incrementDailyCap } from '../../lib/daily-cap'
// import { escalateWorkItem, retryWorkItem } from '../../lib/escalation'
// import { WorkItem } from '../../lib/types'

// --- Mock storage (adapt to actual storage layer) ---
// jest.mock('../../lib/storage', () => ({ ... }))
// OR use a real in-memory store if one exists

describe('Fast Lane Integration Tests', () => {

  beforeEach(() => {
    // Reset any in-memory state, mocks, daily cap counters between tests
  })

  afterEach(() => {
    // Clean up any created work items
  })

  // -------------------------------------------------------------------
  // TEST 1: Create direct-source work item with minimal input
  // -------------------------------------------------------------------
  describe('POST /api/fast-lane - create work item', () => {
    it('stores item with source=direct, triggeredBy, and budget defaults', async () => {
      // Call the fast lane creation function (API handler or direct lib call)
      // Assert:
      //   result.source === 'direct'
      //   result.triggeredBy === <expected producer>
      //   result.budget is set to a default value (e.g. 5 or whatever the default is)
      //   result.status === 'filed' or 'ready'
    })
  })

  // -------------------------------------------------------------------
  // TEST 2: Direct-source items appear in getNextDispatchable()
  // -------------------------------------------------------------------
  describe('getNextDispatchable() with direct-source items', () => {
    it('returns direct-source item without dependency checks', async () => {
      // Create a direct-source work item
      // Call getNextDispatchable()
      // Assert the item appears in results (dependencies: [] or undefined does not block it)
    })
  })

  // -------------------------------------------------------------------
  // TEST 3: Escalation flow
  // -------------------------------------------------------------------
  describe('Escalation flow', () => {
    it('escalated item has status=escalated and is excluded from dispatch', async () => {
      // Create a work item
      // Escalate it
      // Assert item.status === 'escalated' (or 'blocked')
      // Call getNextDispatchable() → assert escalated item is NOT in results
    })

    it('escalation payload contains required fields', async () => {
      // Create a work item
      // Escalate with a reason
      // Assert escalation record has: workItemId, reason, confidenceScore, etc.
    })
  })

  // -------------------------------------------------------------------
  // TEST 4: Retry flow
  // -------------------------------------------------------------------
  describe('Retry flow', () => {
    it('retried item returns to filed status with reset budget', async () => {
      // Create a work item
      // Escalate it
      // Retry it
      // Assert item.status === 'filed' or 'ready'
      // Assert budget is reset/re-assigned
    })
  })

  // -------------------------------------------------------------------
  // TEST 5: Daily cap enforcement
  // -------------------------------------------------------------------
  describe('Daily cap enforcement', () => {
    it('rejects 4th item from non-human producer (qa-agent)', async () => {
      const producer = 'qa-agent'
      // Create items 1, 2, 3 → all succeed
      // Create item 4 → expect rejection (thrown error or returned error with 429-like code)
    })

    it('allows unlimited items from human producer (james)', async () => {
      const producer = 'james'
      // Create items 1 through N (e.g., 5) → all succeed
      // No rejection
    })
  })

  // -------------------------------------------------------------------
  // TEST 6: Type/input validation
  // -------------------------------------------------------------------
  describe('Input validation', () => {
    it('rejects invalid complexityHint value', async () => {
      // Attempt to create item with complexityHint: 'invalid-value'
      // Expect validation error
    })

    it('rejects missing description', async () => {
      // Attempt to create item without description field
      // Expect validation error
    })
  })

  // -------------------------------------------------------------------
  // TEST 7: MCP tool parity
  // -------------------------------------------------------------------
  describe('MCP tool parity', () => {
    it('create_fast_lane_item produces same result structure as /api/fast-lane', async () => {
      // Create item via MCP tool: create_fast_lane_item(...)
      // Create item via fast lane API/helper: createFastLaneItem(...) or POST handler
      // Compare result shapes:
      //   - both have source='direct'
      //   - both have same field set
      //   - both apply same defaults
    })
  })

})
```

**Important implementation notes:**
- Read the actual function signatures from the source files (Step 1) before coding
- If the fast-lane route uses `NextRequest`/`NextResponse`, you may need to test via the underlying lib functions directly rather than through the HTTP layer (or use `node-mocks-http` if available)
- If storage uses Vercel Blob, mock it at the `lib/storage.ts` level
- Match the exact field names from `lib/types.ts`
- The daily cap limit value — read it from `lib/daily-cap.ts` to use the real constant in tests

### Step 5: Ensure test infrastructure exists

If no Jest/Vitest config exists, check `package.json` for the test runner. If Jest is listed as a dependency but has no config file, create a minimal one:

```bash
# Only if needed — check first
cat package.json | grep jest
cat package.json | grep vitest
```

If Jest is the runner and needs a config, add to `package.json` (only if no `jest.config.*` exists):
```json
"jest": {
  "preset": "ts-jest",
  "testEnvironment": "node",
  "moduleNameMapper": {
    "^@/(.*)$": "<rootDir>/$1"
  }
}
```

Or if `ts-jest` is not available, check for `@swc/jest` or similar.

### Step 6: Verification

```bash
# Type check
npx tsc --noEmit

# Run just the new tests
npx jest lib/__tests__/fast-lane.test.ts --no-coverage 2>&1 | tail -50
# OR if vitest:
# npx vitest run lib/__tests__/fast-lane.test.ts

# Run full test suite
npm test
```

All tests must pass. If a test cannot be made to pass due to a missing feature or ambiguous interface, add a `it.skip(...)` with a comment explaining why, rather than leaving a failing test.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "test: add integration tests for end-to-end fast lane flow"
git push origin feat/fast-lane-integration-tests
gh pr create \
  --title "test: integration tests for end-to-end fast lane flow validation" \
  --body "## Summary

Adds \`lib/__tests__/fast-lane.test.ts\` with integration tests validating the complete fast-lane pipeline.

## Tests Added

- **Create direct-source item**: verifies \`source='direct'\`, \`triggeredBy\`, and budget defaults are stored correctly
- **Dispatch eligibility**: direct-source items appear in \`getNextDispatchable()\` without dependency blocks
- **Escalation flow**: escalated items have correct status and are excluded from dispatch
- **Retry flow**: retried items return to \`filed\` status with reset budget
- **Daily cap enforcement**: 4th item from \`qa-agent\` is rejected; \`james\` is exempt
- **Input validation**: invalid \`complexityHint\` and missing \`description\` are rejected
- **MCP tool parity**: \`create_fast_lane_item\` produces same result structure as \`/api/fast-lane\`

## Acceptance Criteria
- [x] All tests pass in CI (\`npm test\`)
- [x] Validates contracts between fast-lane API, daily-cap, work-items dispatch, escalation, and MCP tools"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles (even with `it.skip` for incomplete tests)
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/fast-lane-integration-tests
FILES CHANGED: [lib/__tests__/fast-lane.test.ts, ...]
SUMMARY: [what was done]
ISSUES: [what failed - e.g., "could not determine daily cap limit constant", "storage mock incompatible with Vercel Blob types"]
NEXT STEPS: [what remains - e.g., "implement TEST 5 once daily-cap.ts interface is clarified"]
```

## Escalation Protocol

If blocked by ambiguous interfaces, missing test infrastructure, or repeated failures after 3 attempts:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fast-lane-integration-tests",
    "reason": "<concise description of blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error message>",
      "filesChanged": ["lib/__tests__/fast-lane.test.ts"]
    }
  }'
```