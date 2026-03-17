# Agent Forge -- Integration Tests for Recursive Sub-Phase Decomposition

## Metadata
- **Branch:** `feat/decomposer-subphase-integration-tests`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/__tests__/decomposer-subphase.test.ts

## Context

The decomposer recently gained recursive sub-phase decomposition capability (see `lib/decomposer.ts`). This feature automatically groups large decompositions (>15 items) into phases, handles cross-phase dependencies, supports configurable limits via `DECOMPOSER_SOFT_LIMIT`, escalates when the hard ceiling (31+ items) is hit, and attempts one level of recursive re-decomposition when a sub-phase itself exceeds the soft limit.

A test file `lib/__tests__/decomposer-subphase.test.ts` may already exist from the implementation PR. Before creating new tests, read the existing file to understand what's already covered and what needs to be added or improved. The goal is comprehensive coverage of the complete sub-phase decomposition flow including edge cases.

Key files to read before implementing:
- `lib/decomposer.ts` — understand the actual function signatures, exported functions, constants (`SOFT_LIMIT`, `HARD_CEILING`), and how the LLM call and email are invoked
- `lib/__tests__/decomposer-subphase.test.ts` — check what already exists
- `lib/__tests__/` — understand test conventions (jest, mocking patterns)
- `lib/gmail.ts` — understand email function signatures
- `lib/types.ts` — understand `WorkItem`, `Project`, phase metadata types
- `package.json` — confirm test runner and scripts

## Requirements

1. All 9 test cases must pass: passthrough (≤15 items), auto-split (2 phases, 16–22 items), auto-split (3 phases, 23–30 items), hard ceiling (31+ items triggers escalation), recursive sub-phase (one recursive re-decomposition attempt), recursive escalation (sub-phase still >15 after recursion), circular dependency detection (phases merged), configurable limits via env var, email format verification
2. Tests mock all external dependencies: LLM/Anthropic API calls, email sending, file I/O, Vercel Blob storage
3. ≤15 item decomposition produces output identical to pre-sub-phase-feature behavior (no phase metadata, no grouping)
4. Cross-phase dependency correctness is verified (no circular dependencies in output)
5. Tests run without network access (all HTTP mocked)
6. All existing tests continue to pass (`npm test` exits 0)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/decomposer-subphase-integration-tests
```

### Step 1: Read existing code to understand interfaces

Read these files carefully before writing any tests:

```bash
cat lib/decomposer.ts
cat lib/types.ts
cat lib/gmail.ts
cat lib/__tests__/decomposer-subphase.test.ts 2>/dev/null || echo "File does not exist yet"
ls lib/__tests__/
cat package.json | grep -A5 '"jest"'
cat jest.config* 2>/dev/null || cat jest.config.js 2>/dev/null || echo "No jest config found"
```

Note the following from `lib/decomposer.ts`:
- The exact exported function name(s) for decomposition (likely `decomposeProject` or similar)
- How the LLM is called (which module/function — likely `@ai-sdk/anthropic` or `anthropic` SDK)
- The constant names for soft limit and hard ceiling (e.g., `SOFT_LIMIT`, `HARD_CEILING`, or env var `DECOMPOSER_SOFT_LIMIT`)
- How `sendDecompositionSummaryEmail` (or equivalent) is called from `lib/gmail.ts`
- The shape of the return value including any phase metadata fields
- How escalation is triggered (likely `lib/escalation.ts`)

### Step 2: Implement the test file

Create or replace `lib/__tests__/decomposer-subphase.test.ts` with comprehensive tests. Use the actual function signatures and module paths discovered in Step 1. The skeleton below uses placeholder names — **replace them with actual names from the codebase**.

```typescript
/**
 * Integration tests for recursive sub-phase decomposition.
 * 
 * Tests the complete flow from raw item count → phase grouping → 
 * cross-phase dep resolution → email output → escalation.
 */

// NOTE: Adjust all import paths and mock targets based on what you read in Step 1.
// The names below are illustrative — use the real ones.

import { decomposeProject } from '../decomposer'; // adjust to real export name
// Import any types needed from lib/types.ts

// ─── Mock external dependencies ────────────────────────────────────────────

// Mock the LLM client — adjust path to match how decomposer.ts imports it
jest.mock('@ai-sdk/anthropic', () => ({
  anthropic: jest.fn(),
}));

// Or if using the raw Anthropic SDK:
// jest.mock('@anthropic-ai/sdk', () => ({
//   Anthropic: jest.fn().mockImplementation(() => ({
//     messages: { create: jest.fn() },
//   })),
// }));

// Mock the AI SDK's generateObject/generateText if used
jest.mock('ai', () => ({
  generateObject: jest.fn(),
  generateText: jest.fn(),
}));

// Mock email sending
jest.mock('../gmail', () => ({
  sendDecompositionSummaryEmail: jest.fn().mockResolvedValue(undefined),
  // add other exports from gmail.ts that decomposer.ts uses
}));

// Mock escalation
jest.mock('../escalation', () => ({
  createEscalation: jest.fn().mockResolvedValue({ id: 'esc-test-123' }),
  // add other exports used
}));

// Mock storage (Vercel Blob / local)
jest.mock('../storage', () => ({
  putWorkItems: jest.fn().mockResolvedValue(undefined),
  getWorkItems: jest.fn().mockResolvedValue([]),
  // add other storage functions used by decomposer
}));

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build N fake work items with optional dependency overrides */
function buildItems(count: number, overrides: Partial<any>[] = []): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i + 1}`,
    title: `Task ${i + 1}`,
    description: `Description for task ${i + 1}`,
    dependsOn: [],
    estimatedComplexity: 'medium',
    priority: 'medium',
    ...overrides[i],
  }));
}

/** Get the mock for sendDecompositionSummaryEmail */
function getEmailMock() {
  const gmail = require('../gmail');
  return gmail.sendDecompositionSummaryEmail as jest.Mock;
}

/** Get the mock for createEscalation */
function getEscalationMock() {
  const escalation = require('../escalation');
  return escalation.createEscalation as jest.Mock;
}

/** Get the LLM generate mock — adjust based on which AI SDK function decomposer uses */
function getLLMMock() {
  const ai = require('ai');
  return (ai.generateObject || ai.generateText) as jest.Mock;
}

/** Build a mock project object matching the Project type */
function buildProject(overrides: Partial<any> = {}): any {
  return {
    id: 'proj-test-001',
    title: 'Test Project',
    notionPageId: 'notion-page-123',
    status: 'Execute',
    repo: 'jamesstineheath/agent-forge',
    ...overrides,
  };
}

// ─── Test Suite ────────────────────────────────────────────────────────────

describe('Recursive sub-phase decomposition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DECOMPOSER_SOFT_LIMIT;
  });

  afterEach(() => {
    delete process.env.DECOMPOSER_SOFT_LIMIT;
  });

  // ── Test 1: Passthrough (≤15 items) ──────────────────────────────────────

  describe('Test 1: Passthrough — ≤15 items', () => {
    it('produces no phase metadata when LLM returns 12 items', async () => {
      const items = buildItems(12);
      
      // Mock LLM to return 12 items
      // IMPORTANT: adjust the mock return shape to match what decomposer.ts actually expects
      // e.g., if using generateObject: mock the `object` property
      getLLMMock().mockResolvedValueOnce({
        object: { workItems: items },
        // or: text: JSON.stringify({ workItems: items })
      });

      const result = await decomposeProject(buildProject(), 'Plan text here');

      // No phases
      expect(result.phases).toBeUndefined();
      expect(result.phaseCount).toBeUndefined();
      // All 12 items present
      expect(result.workItems).toHaveLength(12);
      // Email called without phases
      const emailCall = getEmailMock().mock.calls[0];
      if (emailCall) {
        // phases argument should be absent or empty
        expect(emailCall[0]?.phases).toBeFalsy();
      }
      // No escalation
      expect(getEscalationMock()).not.toHaveBeenCalled();
    });
  });

  // ── Test 2: Auto-split — 2 phases (16–22 items) ──────────────────────────

  describe('Test 2: Auto-split — 2 phases (16–22 items)', () => {
    it('creates 2 phases for 18 items with respected dependency structure', async () => {
      // Items 10-18 depend on items 1-9 (clear phase boundary)
      const items = buildItems(18, [
        ...Array(9).fill({}), // items 1-9: no deps
        ...Array(9).fill({}).map((_, i) => ({ dependsOn: [`item-${i + 1}`] })), // items 10-18 depend on 1-9
      ]);

      getLLMMock().mockResolvedValueOnce({
        object: { workItems: items },
      });

      const result = await decomposeProject(buildProject(), 'Plan text');

      expect(result.workItems).toHaveLength(18);
      expect(result.phases).toBeDefined();
      expect(result.phases).toHaveLength(2);

      // Phase 1 has items with no cross-phase deps
      const phase1Items = result.phases![0].workItems;
      const phase2Items = result.phases![1].workItems;
      expect(phase1Items.length).toBeGreaterThan(0);
      expect(phase2Items.length).toBeGreaterThan(0);

      // No item in phase 1 depends on an item in phase 2 (no backward deps)
      const phase2Ids = new Set(phase2Items.map((w: any) => w.id));
      for (const item of phase1Items) {
        for (const dep of (item.dependsOn || [])) {
          expect(phase2Ids.has(dep)).toBe(false);
        }
      }

      // Email includes phases
      const emailCall = getEmailMock().mock.calls[0];
      expect(emailCall).toBeDefined();
      // Check that phases info is included in email args
      const emailArg = emailCall[0];
      expect(emailArg?.phases?.length || emailArg?.phaseCount).toBeTruthy();

      // No escalation
      expect(getEscalationMock()).not.toHaveBeenCalled();
    });

    it('splits budget proportionally across 2 phases', async () => {
      const items = buildItems(18);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      const result = await decomposeProject(
        buildProject({ budget: 100 }),
        'Plan text',
      );

      if (result.phases) {
        const totalBudget = result.phases.reduce(
          (sum: number, p: any) => sum + (p.budget || 0),
          0,
        );
        expect(totalBudget).toBeCloseTo(100, 0);
      }
    });
  });

  // ── Test 3: Auto-split — 3 phases (23–30 items) ──────────────────────────

  describe('Test 3: Auto-split — 3 phases (23–30 items)', () => {
    it('creates 3 phases for 25 items', async () => {
      const items = buildItems(25);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      const result = await decomposeProject(buildProject(), 'Plan text');

      expect(result.workItems).toHaveLength(25);
      expect(result.phases).toHaveLength(3);
      expect(getEscalationMock()).not.toHaveBeenCalled();
    });
  });

  // ── Test 4: Hard ceiling (31+ items) ─────────────────────────────────────

  describe('Test 4: Hard ceiling — 31+ items triggers escalation', () => {
    it('escalates and does not create sub-phases for 35 items', async () => {
      const items = buildItems(35);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      const result = await decomposeProject(buildProject(), 'Plan text');

      // Escalation must be triggered
      expect(getEscalationMock()).toHaveBeenCalledTimes(1);
      const escalationArg = getEscalationMock().mock.calls[0][0];
      expect(escalationArg).toMatchObject(
        expect.objectContaining({
          reason: expect.stringContaining('35'), // mentions the count
        }),
      );

      // No phases created
      expect(result.phases).toBeUndefined();
      // Work items not persisted / returned as empty or the raw list depending on implementation
      // Adjust assertion based on actual behavior: either no workItems or workItems present but no dispatch
    });
  });

  // ── Test 5: Recursive sub-phase ──────────────────────────────────────────

  describe('Test 5: Recursive sub-phase — sub-phase exceeds 15', () => {
    it('attempts one recursive re-decomposition when a sub-phase has 18 items', async () => {
      // First call returns 18 items — triggers 2-phase split
      // One of the phases has 18 items, triggering recursion
      // The recursive call returns ≤15 items for that phase
      const firstCallItems = buildItems(18);
      const recursiveCallItems = buildItems(9); // sub-phase broken down

      getLLMMock()
        .mockResolvedValueOnce({ object: { workItems: firstCallItems } })
        .mockResolvedValueOnce({ object: { workItems: recursiveCallItems } });

      const result = await decomposeProject(buildProject(), 'Plan text');

      // LLM called twice (original + one recursive)
      expect(getLLMMock()).toHaveBeenCalledTimes(2);

      // Result should be valid (no escalation from the recursive case)
      expect(getEscalationMock()).not.toHaveBeenCalled();
    });

    it('respects max recursion depth of 1 — does not recurse more than once', async () => {
      const firstCallItems = buildItems(18);
      const recursiveCallItems = buildItems(10); // still manageable on second call

      getLLMMock()
        .mockResolvedValueOnce({ object: { workItems: firstCallItems } })
        .mockResolvedValueOnce({ object: { workItems: recursiveCallItems } });

      await decomposeProject(buildProject(), 'Plan text');

      // Never called a third time
      expect(getLLMMock()).toHaveBeenCalledTimes(2);
    });
  });

  // ── Test 6: Recursive escalation ─────────────────────────────────────────

  describe('Test 6: Recursive escalation — sub-phase still >15 after recursion', () => {
    it('escalates with descriptive context when recursive sub-phase still exceeds limit', async () => {
      const firstCallItems = buildItems(18);
      const recursiveCallItems = buildItems(18); // still too large after recursion

      getLLMMock()
        .mockResolvedValueOnce({ object: { workItems: firstCallItems } })
        .mockResolvedValueOnce({ object: { workItems: recursiveCallItems } });

      await decomposeProject(buildProject(), 'Plan text');

      expect(getEscalationMock()).toHaveBeenCalledTimes(1);
      const escalationArg = getEscalationMock().mock.calls[0][0];
      // Escalation reason should mention the sub-phase context
      expect(escalationArg.reason).toMatch(/sub-?phase|recursive|phase/i);
    });
  });

  // ── Test 7: Circular dependency detection ────────────────────────────────

  describe('Test 7: Circular dependency detection', () => {
    it('merges phases that would create circular cross-phase dependencies', async () => {
      // Create items where grouping would create a cycle:
      // Group A: item-1 depends on item-4 (in group B)
      // Group B: item-4 depends on item-1 (in group A)
      // → circular cross-phase dep → phases should be merged
      const items = [
        ...buildItems(16).map((item, i) => {
          if (item.id === 'item-1') return { ...item, dependsOn: ['item-12'] };
          if (item.id === 'item-12') return { ...item, dependsOn: ['item-1'] };
          return item;
        }),
      ];

      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      const result = await decomposeProject(buildProject(), 'Plan text');

      if (result.phases) {
        // If phases exist, verify no circular deps between them
        for (let i = 0; i < result.phases.length; i++) {
          const phaseIds = new Set(result.phases[i].workItems.map((w: any) => w.id));
          for (let j = i + 1; j < result.phases.length; j++) {
            const laterPhaseIds = new Set(
              result.phases[j].workItems.map((w: any) => w.id),
            );
            // No item in phase i should depend on an item in a later phase
            // that also depends back on phase i (circular)
            for (const item of result.phases[i].workItems) {
              for (const dep of item.dependsOn || []) {
                if (laterPhaseIds.has(dep)) {
                  // Check reverse
                  for (const laterItem of result.phases[j].workItems) {
                    if (laterItem.id === dep) {
                      for (const laterDep of laterItem.dependsOn || []) {
                        expect(phaseIds.has(laterDep)).toBe(false);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
      // Primary assertion: no crash, valid result returned
      expect(result).toBeDefined();
    });
  });

  // ── Test 8: Configurable limits ──────────────────────────────────────────

  describe('Test 8: Configurable limits via DECOMPOSER_SOFT_LIMIT', () => {
    it('triggers split at 11 items when DECOMPOSER_SOFT_LIMIT=10', async () => {
      process.env.DECOMPOSER_SOFT_LIMIT = '10';

      const items = buildItems(11);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      const result = await decomposeProject(buildProject(), 'Plan text');

      // With soft limit = 10, 11 items should trigger phase splitting
      expect(result.phases).toBeDefined();
      expect(result.phases!.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT split at 11 items with default soft limit of 15', async () => {
      // No env override — default limit is 15
      const items = buildItems(11);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      const result = await decomposeProject(buildProject(), 'Plan text');

      expect(result.phases).toBeUndefined();
    });
  });

  // ── Test 9: Email format ──────────────────────────────────────────────────

  describe('Test 9: Email format for multi-phase decomposition', () => {
    it('includes phase-structured content in email for 18-item decomposition', async () => {
      const items = buildItems(18);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      await decomposeProject(buildProject(), 'Plan text');

      expect(getEmailMock()).toHaveBeenCalledTimes(1);
      const emailCallArgs = getEmailMock().mock.calls[0];
      
      // Email should receive phase information — check the actual argument structure
      // from what you observed in lib/gmail.ts sendDecompositionSummaryEmail signature
      const emailPayload = emailCallArgs[0] || emailCallArgs;
      
      // At minimum, phases should be present in the email data
      const hasPhaseInfo =
        emailPayload?.phases?.length > 0 ||
        emailPayload?.phaseCount > 1 ||
        JSON.stringify(emailCallArgs).includes('phase');
      
      expect(hasPhaseInfo).toBe(true);
    });

    it('does NOT include phase info in email for 12-item passthrough', async () => {
      const items = buildItems(12);
      getLLMMock().mockResolvedValueOnce({ object: { workItems: items } });

      await decomposeProject(buildProject(), 'Plan text');

      if (getEmailMock().mock.calls.length > 0) {
        const emailCallArgs = getEmailMock().mock.calls[0];
        const emailPayload = emailCallArgs[0] || emailCallArgs;
        
        expect(emailPayload?.phases).toBeFalsy();
        expect(emailPayload?.phaseCount).toBeFalsy();
      }
    });
  });
});
```

**Important**: After reading the actual `lib/decomposer.ts` in Step 1, you MUST adjust:
1. The import path and exported function name (`decomposeProject` may be named differently)
2. The LLM mock target (could be `ai`, `@ai-sdk/anthropic`, `@anthropic-ai/sdk`, etc.)
3. The mock return shape (must match what decomposer actually parses)
4. The email mock target and argument shape
5. The escalation mock target
6. The result shape assertions (what `decomposeProject` actually returns)
7. The `buildProject` helper to match the actual `Project` type fields

### Step 3: Run the tests and fix failures

```bash
npm test -- --testPathPattern="decomposer-subphase" --no-coverage 2>&1 | head -100
```

For each failing test:
1. Read the error carefully
2. Check if the mock return shape needs adjustment (most common issue)
3. Check if the function signature differs from assumed
4. Fix and re-run

If a test case cannot be implemented because the underlying decomposer feature doesn't exist yet (e.g., the recursion logic wasn't implemented), note it in a `describe.skip` block with a comment explaining why.

### Step 4: Run full test suite to verify no regressions

```bash
npm test -- --no-coverage 2>&1 | tail -30
```

All pre-existing tests must still pass.

### Step 5: TypeScript validation

```bash
npx tsc --noEmit
```

Fix any type errors. If the decomposer return type doesn't include `phases`, check `lib/types.ts` for the actual type and adjust assertions accordingly.

### Step 6: Commit, push, open PR

```bash
git add lib/__tests__/decomposer-subphase.test.ts
git commit -m "test: integration tests for recursive sub-phase decomposition

- Test 1: passthrough ≤15 items produces no phase metadata
- Test 2: auto-split 16-22 items creates 2 phases with correct deps
- Test 3: auto-split 23-30 items creates 3 phases
- Test 4: hard ceiling 31+ items triggers escalation
- Test 5: recursive sub-phase triggers one re-decomposition attempt
- Test 6: recursive escalation when sub-phase still exceeds limit
- Test 7: circular dependency detection merges conflicting phases
- Test 8: DECOMPOSER_SOFT_LIMIT env var overrides default threshold
- Test 9: email format includes phase structure for multi-phase output

All external deps (LLM, email, storage, escalation) are mocked."
git push origin feat/decomposer-subphase-integration-tests
gh pr create \
  --title "test: integration tests for recursive sub-phase decomposition" \
  --body "## Summary

Adds comprehensive integration tests for the recursive sub-phase decomposition feature in \`lib/decomposer.ts\`.

## Test Coverage

| # | Test Case | Description |
|---|-----------|-------------|
| 1 | Passthrough (≤15 items) | 12-item decomposition produces no phase metadata |
| 2 | Auto-split 2 phases | 18 items → 2 phases with dependency-correct ordering |
| 3 | Auto-split 3 phases | 25 items → 3 phases |
| 4 | Hard ceiling | 35 items → escalation triggered, no phases created |
| 5 | Recursive sub-phase | Sub-phase with 18 items triggers one recursive re-decomposition |
| 6 | Recursive escalation | Sub-phase still >15 after recursion → escalation with context |
| 7 | Circular dep detection | Circular cross-phase deps → phases merged |
| 8 | Configurable limits | \`DECOMPOSER_SOFT_LIMIT=10\` triggers split at 11 items |
| 9 | Email format | Multi-phase decomposition includes phase structure in email |

## Implementation Notes

- All external dependencies mocked (LLM, email, storage, escalation)
- Tests run without network access
- Verifies pre-change behavior is preserved for ≤15 items

## Acceptance Criteria
- [x] All 9 test cases pass
- [x] Mocks cover LLM, email, file I/O
- [x] ≤15 item decomposition identical to pre-change behavior
- [x] Cross-phase dependency correctness verified
- [x] CI passes, no existing test regressions"
```

## Session Abort Protocol
If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/decomposer-subphase-integration-tests
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If you encounter a blocker (e.g., decomposer does not export a testable function, the LLM integration is too deeply coupled to mock, or the recursion feature is not yet implemented), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "integration-tests-recursive-sub-phase",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/__tests__/decomposer-subphase.test.ts"]
    }
  }'
```