# Agent Forge -- Integration test: end-to-end spike lifecycle validation

## Metadata
- **Branch:** `feat/spike-lifecycle-integration-test`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/__tests__/spike-lifecycle.test.ts

## Context

Agent Forge has a spike work item system for research/investigation tasks. The system involves several modules working together:

1. **Spike types** — `SpikeMetadata`, `SpikeRecommendation` enum, spike-typed work items
2. **Spike template generation** — `generateSpikeTemplate()` produces a markdown template for researchers
3. **Spike findings parsing** — `parseSpikeFindings()` extracts structured data from completed spike documents
4. **Spike handoff generation** — `generateSpikeHandoff()` produces handoff instructions for spike-type work items
5. **Work item filing** — `fileSpikeWorkItem()` creates spike-typed work items in the store
6. **Orchestrator routing** — Routes spike work items to the spike handoff generator
7. **PM agent** — Detects uncertainty and suggests spikes

This test file needs to validate each module's exports and the integration points between them. Since the agent executing this may need to discover the actual module paths and exported symbols by reading the codebase, the steps below include a discovery phase before writing tests.

The test should be pure TypeScript unit/integration tests with no external dependencies (no real DB calls, no GitHub API calls). Mock any I/O boundaries.

## Requirements

1. Test file at `lib/__tests__/spike-lifecycle.test.ts` using Jest (already configured in this repo)
2. `SpikeMetadata` and `SpikeRecommendation` types/enums are correctly defined and usable — validate all three recommendation values exist
3. `generateSpikeTemplate()` and `parseSpikeFindings()` roundtrip correctly for all 3 recommendation values (`proceed`, `abandon`, `pivot` or equivalent)
4. `generateSpikeHandoff()` produces content referencing a `spikes/` directory and contains language prohibiting production code changes
5. `fileSpikeWorkItem()` creates work items with the correct `type: 'spike'` field (mock the DB/storage layer)
6. Orchestrator correctly routes spike-type work items to the spike handoff path (validate the routing logic, not the full orchestration)
7. PM agent uncertainty detection prompt is well-formed (non-empty string, contains relevant keywords)
8. Spike completion handler maps each recommendation value to the correct PRD/work item status transition
9. All tests pass and TypeScript compiles without errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/spike-lifecycle-integration-test
```

### Step 1: Discover spike-related modules

Before writing any tests, read the codebase to find all spike-related code:

```bash
# Find all spike-related files
grep -r "spike" lib/ --include="*.ts" -l
grep -r "SpikeMetadata\|SpikeRecommendation\|generateSpikeTemplate\|parseSpikeFindings\|generateSpikeHandoff\|fileSpikeWorkItem" lib/ --include="*.ts" -l

# Check types
grep -r "SpikeMetadata\|SpikeRecommendation" lib/types.ts lib/ --include="*.ts" -n | head -40

# Check orchestrator routing
grep -r "spike" lib/orchestrator.ts -n 2>/dev/null || echo "not in orchestrator.ts"

# Check PM agent prompts
grep -r "spike\|uncertainty" lib/pm-prompts.ts -n 2>/dev/null | head -20

# Check for spike-specific modules
ls lib/spike* 2>/dev/null || echo "no top-level spike files"
ls lib/spikes/ 2>/dev/null || echo "no lib/spikes/ directory"

# Check work item types
grep -r "type.*spike\|spike.*type\|WorkItemType\|fileSpikeWorkItem" lib/ --include="*.ts" -n | head -30

# Check existing test setup
ls lib/__tests__/ 2>/dev/null
cat jest.config.* 2>/dev/null || cat package.json | grep -A 20 '"jest"'
```

**IMPORTANT:** Read each discovered file completely before writing any tests. The test must import from the actual module paths.

### Step 2: Map all exported symbols

After discovery, create a mental map of:
- Exact file paths for each spike module
- Exact export names (types, functions, enums)
- The shape of `SpikeMetadata` and `SpikeRecommendation`
- What arguments `generateSpikeTemplate()`, `parseSpikeFindings()`, `generateSpikeHandoff()`, `fileSpikeWorkItem()` accept
- How the orchestrator routes spike items (look for a conditional or switch on `workItem.type === 'spike'`)
- Where the PM agent uncertainty prompt lives
- Where spike completion/recommendation handling lives

```bash
# Read each discovered file in full
cat lib/types.ts | grep -A 20 -B 2 "spike\|Spike"
# ... read other discovered files
```

### Step 3: Create the test directory if needed

```bash
mkdir -p lib/__tests__
```

### Step 4: Write the test file

Create `lib/__tests__/spike-lifecycle.test.ts`. The structure should be:

```typescript
/**
 * Integration test: end-to-end spike lifecycle validation
 *
 * Validates that all spike-related modules are correctly defined and
 * integrate properly with each other.
 */

// ---- Imports (fill in actual paths after Step 1 discovery) ----
// import { SpikeMetadata, SpikeRecommendation } from '../types';
// import { generateSpikeTemplate, parseSpikeFindings } from '../spike-template'; // actual path TBD
// import { generateSpikeHandoff } from '../spike-handoff'; // actual path TBD
// import { fileSpikeWorkItem } from '../work-items'; // or wherever it lives
// etc.

describe('Spike Lifecycle: Type Definitions', () => {
  it('SpikeRecommendation has all three expected values', () => {
    // Validate that all three recommendation enum values exist
    // e.g. expect(SpikeRecommendation.PROCEED).toBeDefined()
    // The actual enum values depend on what Step 1 discovers
  });

  it('SpikeMetadata type is usable and has required fields', () => {
    // Create a valid SpikeMetadata object and verify shape
    // e.g. const meta: SpikeMetadata = { recommendation: ..., findings: ..., ... }
    // If it's a type (not runtime), just verify a valid object can be constructed
  });
});

describe('Spike Lifecycle: Template Generation and Parsing (Roundtrip)', () => {
  const allRecommendations = [/* all three values */];

  for (const recommendation of allRecommendations) {
    it(`roundtrips correctly for recommendation: ${recommendation}`, () => {
      // Generate a template, fill in the recommendation field,
      // parse it back, and verify the parsed recommendation matches
      const template = generateSpikeTemplate(/* args */);
      expect(template).toBeTruthy();
      
      // Simulate a completed spike document with this recommendation
      // The exact format depends on what parseSpikeFindings expects
      const filledDoc = /* modify template to include recommendation */;
      const parsed = parseSpikeFindings(filledDoc);
      
      expect(parsed.recommendation).toBe(recommendation);
      // Validate other required fields are present
    });
  }
});

describe('Spike Lifecycle: Handoff Generation', () => {
  it('generates handoff content referencing spikes/ directory', () => {
    const handoff = generateSpikeHandoff(/* spike work item */);
    expect(handoff).toContain('spikes/');
  });

  it('prohibits production code changes in handoff', () => {
    const handoff = generateSpikeHandoff(/* spike work item */);
    // Should contain language like "do not", "no production", "research only", etc.
    const lower = handoff.toLowerCase();
    expect(
      lower.includes('do not') ||
      lower.includes('no production') ||
      lower.includes('prohibit') ||
      lower.includes('research only') ||
      lower.includes('no code changes')
    ).toBe(true);
  });
});

describe('Spike Lifecycle: Work Item Filing', () => {
  it('fileSpikeWorkItem creates work item with type spike', async () => {
    // Mock any DB/storage calls
    // jest.mock('../work-items', ...) or mock the storage dependency
    // Verify the created work item has type: 'spike'
  });
});

describe('Spike Lifecycle: Orchestrator Routing', () => {
  it('routes spike work items to spike handoff path', () => {
    // This might be testing a function, a switch statement, or a router
    // The exact approach depends on what Step 1 discovers
    // Validate that a work item with type: 'spike' goes through the spike path
  });
});

describe('Spike Lifecycle: PM Agent Uncertainty Detection', () => {
  it('uncertainty detection prompt is a non-empty string', () => {
    // Import the prompt or the function that generates it
    // Verify it's a non-empty string
  });

  it('uncertainty detection prompt contains relevant spike keywords', () => {
    // Verify the prompt contains words like 'spike', 'uncertainty', 'research', 'investigate'
    const lower = prompt.toLowerCase();
    expect(
      lower.includes('spike') ||
      lower.includes('uncertain') ||
      lower.includes('research') ||
      lower.includes('investigat')
    ).toBe(true);
  });
});

describe('Spike Lifecycle: Completion Handler Recommendation Mapping', () => {
  it('maps PROCEED recommendation to correct status transition', () => {
    // The exact status values depend on the codebase
    // e.g. expect(handleSpikeCompletion({ recommendation: 'proceed' })).toEqual({ nextStatus: 'ready' })
  });

  it('maps ABANDON recommendation to correct status transition', () => { /* ... */ });
  it('maps PIVOT recommendation to correct status transition', () => { /* ... */ });
});
```

**The above is a scaffold. Replace all placeholder comments and TBD paths with the actual discovered values from Step 1. Every import must be real.**

### Step 5: Handle cases where spike modules may not fully exist yet

If discovery reveals that some spike modules are partially implemented or missing exports, do the following for each gap:

**Option A — The export exists but is named differently:** Import with the actual name found.

**Option B — The module exists but the specific function is missing:** Write the test with a `it.todo()` and a comment explaining what was found:
```typescript
it.todo('generateSpikeHandoff — function not yet exported from lib/spike-handoff.ts (found: generateHandoff)');
```

**Option C — The entire module doesn't exist:** Write the test as `it.todo()` with a clear explanation, then open a note in the PR description listing gaps found.

Do NOT write tests that import from non-existent paths — the TypeScript compiler will fail. Use `it.todo()` for unimplemented items.

### Step 6: Handle mocking for fileSpikeWorkItem

`fileSpikeWorkItem` likely calls the database or Vercel Blob. Mock at the module level:

```typescript
// At top of file, before imports
jest.mock('../db/index', () => ({
  db: {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue([{ id: 'test-id' }]) }),
    // add other db methods as needed
  },
}));

// Or if it uses lib/work-items.ts which calls storage:
jest.mock('../storage', () => ({
  put: jest.fn().mockResolvedValue({ url: 'blob://test' }),
  get: jest.fn().mockResolvedValue(null),
  list: jest.fn().mockResolvedValue({ blobs: [] }),
}));
```

Discover the actual storage pattern by reading `lib/work-items.ts` in Step 1.

### Step 7: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- Wrong import paths → fix to actual paths
- Missing type assertions → add `as SpikeRecommendation` etc.
- Async tests without `await` → add `await`

### Step 8: Run the tests

```bash
npm test -- lib/__tests__/spike-lifecycle.test.ts --verbose
```

If tests fail:
1. Read the error carefully
2. Re-read the source module to understand the actual API
3. Fix the test to match reality (don't change source modules unless there's a clear bug)
4. If a module genuinely doesn't export something required, use `it.todo()` and document in PR

### Step 9: Run full test suite to check for regressions

```bash
npm test
```

### Step 10: Final TypeScript check

```bash
npx tsc --noEmit
npm run build 2>/dev/null || echo "Build check done"
```

### Step 11: Commit, push, open PR

```bash
git add -A
git commit -m "test: end-to-end spike lifecycle validation"
git push origin feat/spike-lifecycle-integration-test
gh pr create \
  --title "test: end-to-end spike lifecycle validation" \
  --body "## Summary

Adds comprehensive integration test validating the spike work item lifecycle end-to-end.

## Tests Added

\`lib/__tests__/spike-lifecycle.test.ts\`

### Coverage
- **Type Definitions**: \`SpikeRecommendation\` enum values, \`SpikeMetadata\` shape
- **Template Roundtrip**: \`generateSpikeTemplate()\` + \`parseSpikeFindings()\` for all 3 recommendation values
- **Handoff Generation**: \`generateSpikeHandoff()\` references \`spikes/\` directory, prohibits production code
- **Work Item Filing**: \`fileSpikeWorkItem()\` creates \`type: 'spike'\` items (mocked storage)
- **Orchestrator Routing**: Spike items routed to spike handoff path
- **PM Agent Prompt**: Uncertainty detection prompt well-formed and contains spike keywords
- **Completion Handler**: Each recommendation maps to correct status transition

## Gaps Found (if any)
<!-- List any it.todo() items and what was missing -->

## Acceptance Criteria
- [x] SpikeMetadata and SpikeRecommendation types validated
- [x] generateSpikeTemplate/parseSpikeFindings roundtrip for all 3 values
- [x] generateSpikeHandoff references spikes/ and prohibits production code
- [x] fileSpikeWorkItem creates type:spike work items
- [x] TypeScript compiles without errors
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
```bash
git add -A
git commit -m "test: partial spike lifecycle tests (see PR for gaps)"
git push origin feat/spike-lifecycle-integration-test
```

2. Open the PR:
```bash
gh pr create --title "test: spike lifecycle validation (partial)" --body "Partial implementation — see ISSUES below."
```

3. Output structured report:
```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/spike-lifecycle-integration-test
FILES CHANGED: lib/__tests__/spike-lifecycle.test.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g. "parseSpikeFindings not found in any module", "TypeScript error on line 42"]
NEXT STEPS: [e.g. "Implement parseSpikeFindings export in lib/spike-template.ts before this test can pass"]
```

## Escalation

If you cannot locate spike modules after exhaustive grep (the feature may not be implemented yet), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "spike-lifecycle-integration-test",
    "reason": "Spike modules not found in codebase — spike feature may not be implemented yet. Cannot write integration tests for non-existent exports.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "1",
      "error": "grep for SpikeMetadata, SpikeRecommendation, generateSpikeTemplate, parseSpikeFindings returned no results",
      "filesChanged": []
    }
  }'
```