# Agent Forge -- Integration test — full dashboard Inngest observability E2E

## Metadata
- **Branch:** `feat/inngest-dashboard-integration-test`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** __tests__/inngest-dashboard-integration.test.ts

## Context

Agent Forge uses Inngest for its 7 autonomous agent cron functions (migrated from Vercel serverless cron per ADR-010 and PR #415). The dashboard exposes an observability layer for these functions via:

- An execution log (read/write via Vercel Blob or similar storage) — functions `writeExecutionLog` / `readExecutionLog` / `readAllExecutionLogs`
- A status API at `app/api/agents/inngest-status/route.ts` (or similar path)
- A trigger API at `app/api/agents/inngest-trigger/route.ts` (recently merged: `feat: create inngest-trigger API route`)
- A dashboard page at `app/(app)/agents/page.tsx` that renders 7 Inngest function cards (recently merged: `feat: refactor agents page to render 7 Inngest function cards`)
- A function registry `INNGEST_FUNCTION_REGISTRY` exported from somewhere in `lib/`
- A shared type `InngestFunctionStatus` in `lib/types.ts`

The 7 registered Inngest functions (from SYSTEM_MAP.md) are:
1. `plan-pipeline` (*/10 cron)
2. `pipeline-oversight` (*/30 cron)
3. `pm-sweep` (daily 08:00 UTC)
4. `housekeeping` (*/6h cron)
5. `dispatcher-cycle` (*/15 cron)
6. `pm-cycle` (*/30 cron)
7. `health-monitor-cycle` (*/15 cron)

This task adds a comprehensive integration test file that exercises the full observability stack end-to-end. No concurrent work conflicts — the only concurrent branch (`feat/implement-core-wave-scheduler-algorithm`) touches `lib/wave-scheduler.ts` which is unrelated.

## Requirements

1. Execution log round-trip test: `writeExecutionLog` → `readExecutionLog` verifies all fields match, for both success and error states
2. `readAllExecutionLogs` test: Write logs for 3 of 7 functions, verify 3 present and 4 null
3. `INNGEST_FUNCTION_REGISTRY` completeness: Exactly 7 entries, each with non-empty `id`, `displayName`, `eventName`; all IDs unique
4. Status API response shape: Mock Blob reads, call handler, verify 7 `InngestFunctionStatus` objects with correct field types
5. Trigger API validation: 400 for unknown `functionId`, 200 for valid `functionId` (mocking Inngest send)
6. Type consistency: `InngestFunctionStatus` from `lib/types.ts` is compatible with status API response and card component expectations
7. All tests pass in CI (`npm test` or `vitest run`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/inngest-dashboard-integration-test
```

### Step 1: Discover the actual project layout

Before writing any test code, inspect the relevant source files to understand exact import paths, function signatures, and the test framework in use.

```bash
# Identify test framework
cat package.json | grep -E '"(test|vitest|jest|@jest)"'
cat vitest.config.ts 2>/dev/null || cat jest.config.ts 2>/dev/null || cat jest.config.js 2>/dev/null || echo "no config found"

# Find existing tests for pattern reference
find . -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" | head -20

# Locate the Inngest function registry
grep -r "INNGEST_FUNCTION_REGISTRY" --include="*.ts" -l
grep -r "INNGEST_FUNCTION_REGISTRY" --include="*.ts" | head -20

# Locate writeExecutionLog / readExecutionLog
grep -r "writeExecutionLog\|readExecutionLog\|readAllExecutionLogs" --include="*.ts" -l
grep -r "writeExecutionLog\|readExecutionLog\|readAllExecutionLogs" --include="*.ts" | head -30

# Locate InngestFunctionStatus type
grep -r "InngestFunctionStatus" --include="*.ts" -l
grep -r "InngestFunctionStatus" lib/types.ts | head -20

# Find the status API route
find . -path "*/inngest-status*" -name "*.ts"
cat app/api/agents/inngest-status/route.ts 2>/dev/null

# Find the trigger API route
cat app/api/agents/inngest-trigger/route.ts 2>/dev/null

# Find the agents page component
cat app/\(app\)/agents/page.tsx 2>/dev/null | head -80

# Check Inngest function definitions
ls lib/inngest/
cat lib/inngest/client.ts | head -40
```

### Step 2: Understand exact signatures and types

```bash
# Get the full InngestFunctionStatus type definition
grep -A 20 "InngestFunctionStatus" lib/types.ts

# Get writeExecutionLog/readExecutionLog signatures
grep -B 2 -A 15 "export.*writeExecutionLog\|export.*readExecutionLog\|export.*readAllExecutionLogs" $(grep -r "writeExecutionLog" --include="*.ts" -l | grep -v test | head -3)

# Get INNGEST_FUNCTION_REGISTRY shape
grep -B 2 -A 40 "INNGEST_FUNCTION_REGISTRY" $(grep -r "INNGEST_FUNCTION_REGISTRY" --include="*.ts" -l | grep -v test | head -1)

# Check how Vercel Blob is mocked in existing tests (if any)
grep -r "blob\|@vercel/blob\|vi.mock\|jest.mock" --include="*.test.ts" . 2>/dev/null | head -20
```

### Step 3: Create the test file

Based on what you discover in Steps 1–2, create `__tests__/inngest-dashboard-integration.test.ts`.

The exact imports and mock paths depend on what you find, but the structure should follow this template, adapting import paths and mock targets to match the actual codebase:

```typescript
/**
 * Integration test: Full Inngest dashboard observability E2E
 *
 * Covers:
 * 1. Execution log round-trip (writeExecutionLog → readExecutionLog)
 * 2. readAllExecutionLogs multi-function coverage
 * 3. INNGEST_FUNCTION_REGISTRY completeness
 * 4. Status API response shape
 * 5. Trigger API validation (400 unknown, 200 valid)
 * 6. InngestFunctionStatus type consistency
 */

// ---- Adapt these imports to actual file locations ----
// e.g. import { writeExecutionLog, readExecutionLog, readAllExecutionLogs } from '../lib/inngest-execution-log'
// e.g. import { INNGEST_FUNCTION_REGISTRY } from '../lib/inngest/registry'
// e.g. import { InngestFunctionStatus } from '../lib/types'
// e.g. import { GET as statusHandler } from '../app/api/agents/inngest-status/route'
// e.g. import { POST as triggerHandler } from '../app/api/agents/inngest-trigger/route'

// ---- Mock @vercel/blob (or whatever storage is used) ----
// vi.mock('@vercel/blob', () => ({ ... }))
// or jest.mock('@vercel/blob', () => ({ ... }))

// =============================================
// 1. EXECUTION LOG ROUND-TRIP
// =============================================
describe('Execution log round-trip', () => {
  it('writes and reads back a success log with all fields intact', async () => {
    const functionId = 'dispatcher-cycle'
    const log = {
      functionId,
      status: 'success' as const,
      startedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
      completedAt: new Date('2024-01-01T00:01:00Z').toISOString(),
      durationMs: 60000,
      triggeredBy: 'cron',
      summary: 'Dispatched 3 work items',
    }

    await writeExecutionLog(log)
    const result = await readExecutionLog(functionId)

    expect(result).not.toBeNull()
    expect(result!.functionId).toBe(functionId)
    expect(result!.status).toBe('success')
    expect(result!.startedAt).toBe(log.startedAt)
    expect(result!.completedAt).toBe(log.completedAt)
    expect(result!.durationMs).toBe(60000)
    expect(result!.triggeredBy).toBe('cron')
    expect(result!.summary).toBe('Dispatched 3 work items')
  })

  it('writes and reads back an error log with error details', async () => {
    const functionId = 'health-monitor-cycle'
    const log = {
      functionId,
      status: 'error' as const,
      startedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
      completedAt: new Date('2024-01-01T00:00:05Z').toISOString(),
      durationMs: 5000,
      triggeredBy: 'cron',
      error: 'Connection timeout after 5000ms',
    }

    await writeExecutionLog(log)
    const result = await readExecutionLog(functionId)

    expect(result).not.toBeNull()
    expect(result!.status).toBe('error')
    expect(result!.error).toBe('Connection timeout after 5000ms')
  })
})

// =============================================
// 2. readAllExecutionLogs MULTI-FUNCTION
// =============================================
describe('readAllExecutionLogs', () => {
  it('returns logs for written functions and null for others', async () => {
    const writtenIds = ['dispatcher-cycle', 'pm-cycle', 'housekeeping']
    const allIds = [
      'plan-pipeline',
      'pipeline-oversight',
      'pm-sweep',
      'housekeeping',
      'dispatcher-cycle',
      'pm-cycle',
      'health-monitor-cycle',
    ]

    // Write logs for 3 functions
    for (const id of writtenIds) {
      await writeExecutionLog({
        functionId: id,
        status: 'success',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1000,
        triggeredBy: 'cron',
      })
    }

    const results = await readAllExecutionLogs()

    // Should have a key for each of the 7 functions
    for (const id of allIds) {
      expect(results).toHaveProperty(id)
    }

    // Written 3 should be non-null
    for (const id of writtenIds) {
      expect(results[id]).not.toBeNull()
      expect(results[id]!.functionId).toBe(id)
    }

    // Other 4 should be null
    const unwrittenIds = allIds.filter(id => !writtenIds.includes(id))
    for (const id of unwrittenIds) {
      expect(results[id]).toBeNull()
    }
  })
})

// =============================================
// 3. INNGEST_FUNCTION_REGISTRY COMPLETENESS
// =============================================
describe('INNGEST_FUNCTION_REGISTRY', () => {
  it('has exactly 7 entries', () => {
    expect(INNGEST_FUNCTION_REGISTRY).toHaveLength(7)
  })

  it('each entry has non-empty id, displayName, and eventName', () => {
    for (const entry of INNGEST_FUNCTION_REGISTRY) {
      expect(typeof entry.id).toBe('string')
      expect(entry.id.length).toBeGreaterThan(0)
      expect(typeof entry.displayName).toBe('string')
      expect(entry.displayName.length).toBeGreaterThan(0)
      expect(typeof entry.eventName).toBe('string')
      expect(entry.eventName.length).toBeGreaterThan(0)
    }
  })

  it('all IDs are unique', () => {
    const ids = INNGEST_FUNCTION_REGISTRY.map((e: any) => e.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(7)
  })

  it('contains all 7 expected function IDs', () => {
    const ids = INNGEST_FUNCTION_REGISTRY.map((e: any) => e.id)
    const expectedIds = [
      'plan-pipeline',
      'pipeline-oversight',
      'pm-sweep',
      'housekeeping',
      'dispatcher-cycle',
      'pm-cycle',
      'health-monitor-cycle',
    ]
    for (const expectedId of expectedIds) {
      expect(ids).toContain(expectedId)
    }
  })
})

// =============================================
// 4. STATUS API RESPONSE SHAPE
// =============================================
describe('Inngest status API', () => {
  it('returns exactly 7 InngestFunctionStatus objects with correct field types', async () => {
    // Mock blob reads to return null (no execution logs)
    // Actual mock setup depends on what the status handler imports

    const request = new Request('http://localhost/api/agents/inngest-status')
    const response = await statusHandler(request)

    expect(response.status).toBe(200)

    const body = await response.json()
    // Body may be { functions: [...] } or directly an array — adapt to actual shape
    const functions: InngestFunctionStatus[] = Array.isArray(body) ? body : body.functions

    expect(functions).toHaveLength(7)

    for (const fn of functions) {
      expect(typeof fn.id).toBe('string')
      expect(fn.id.length).toBeGreaterThan(0)
      expect(typeof fn.displayName).toBe('string')
      // lastExecution is null or an object
      expect(fn.lastExecution === null || typeof fn.lastExecution === 'object').toBe(true)
      // status field is a valid string
      expect(['idle', 'success', 'error', 'running', 'unknown']).toContain(fn.status)
    }
  })
})

// =============================================
// 5. TRIGGER API VALIDATION
// =============================================
describe('Inngest trigger API', () => {
  it('returns 400 for an unknown functionId', async () => {
    const request = new Request('http://localhost/api/agents/inngest-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionId: 'does-not-exist-xyz' }),
    })

    const response = await triggerHandler(request)
    expect(response.status).toBe(400)

    const body = await response.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 200 for a valid functionId (mocking Inngest send)', async () => {
    // Mock the Inngest client send method
    // vi.mocked(inngest.send).mockResolvedValueOnce({ ids: ['test-id'] })
    // or jest equivalent

    const request = new Request('http://localhost/api/agents/inngest-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionId: 'dispatcher-cycle' }),
    })

    const response = await triggerHandler(request)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toHaveProperty('success', true)
  })
})

// =============================================
// 6. TYPE CONSISTENCY
// =============================================
describe('InngestFunctionStatus type consistency', () => {
  it('is structurally compatible with status API return and card component props', () => {
    // Compile-time check: construct an object and verify it satisfies the type
    const sample: InngestFunctionStatus = {
      id: 'dispatcher-cycle',
      displayName: 'Dispatcher Cycle',
      eventName: 'agent-forge/dispatcher.run',
      status: 'success',
      lastExecution: {
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 1000,
        triggeredBy: 'cron',
        summary: 'ok',
      },
    }

    // Runtime check: all required keys are present
    expect(sample).toHaveProperty('id')
    expect(sample).toHaveProperty('displayName')
    expect(sample).toHaveProperty('status')
    expect(sample).toHaveProperty('lastExecution')
  })
})
```

**Critical adaptation instructions for the executing agent:**

- Replace all import paths with the actual discovered paths from Step 1–2.
- Replace all mock setups with the actual mock targets discovered from Step 2.
- If `readAllExecutionLogs` doesn't return a keyed object but an array, adapt test #2 accordingly.
- If `InngestFunctionStatus` has different field names than assumed (e.g., `name` instead of `displayName`), adapt all tests.
- If the status API returns `{ functions: [...] }` vs a bare array, adapt test #4.
- If the trigger API expects auth headers (check the actual route handler), add them to the Request.
- If `lastExecution` is nested differently, adapt the type consistency test.
- If there is no `readAllExecutionLogs` function (logs are fetched differently), replace test #2 with whatever the actual multi-function read mechanism is.

### Step 4: Set up mocks correctly

Based on what you find, set up top-level vi.mock / jest.mock blocks for:

1. **`@vercel/blob`** — mock `put`, `get`, `head`, `del` to use an in-memory store:

```typescript
// Vitest example
const blobStore = new Map<string, string>()

vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (key: string, data: string) => {
    blobStore.set(key, data)
    return { url: `https://blob/${key}` }
  }),
  get: vi.fn(async (url: string) => {
    const key = url.replace('https://blob/', '')
    const data = blobStore.get(key)
    if (!data) return null
    return { text: async () => data }
  }),
  head: vi.fn(async (url: string) => {
    const key = url.replace('https://blob/', '')
    return blobStore.has(key) ? { url } : null
  }),
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: Array.from(blobStore.keys())
      .filter(k => k.startsWith(prefix))
      .map(k => ({ url: `https://blob/${k}`, pathname: k })),
  })),
}))
```

2. **Inngest client** — mock the `send` method:

```typescript
vi.mock('../lib/inngest/client', () => ({
  inngest: {
    send: vi.fn().mockResolvedValue({ ids: ['mock-event-id'] }),
  },
}))
```

3. **Auth / session** (if the status/trigger routes check auth) — mock `getServerSession` or `auth()` to return a valid session:

```typescript
vi.mock('next-auth', () => ({
  getServerSession: vi.fn().mockResolvedValue({ user: { email: 'james.stine.heath@gmail.com' } }),
}))
// or for Auth.js v5:
vi.mock('../auth', () => ({
  auth: vi.fn().mockResolvedValue({ user: { email: 'james.stine.heath@gmail.com' } }),
}))
```

Add `beforeEach(() => { blobStore.clear() })` to ensure test isolation.

### Step 5: Configure the test runner (if needed)

```bash
# Check if __tests__ directory is already in the test include paths
cat vitest.config.ts 2>/dev/null
cat jest.config.ts 2>/dev/null || cat jest.config.js 2>/dev/null

# If __tests__ is not already included, check where existing tests live
find . -name "*.test.ts" | grep -v node_modules | head -10
```

If the project uses vitest but doesn't include `__tests__/` in its `include` globs, either:
- Add `__tests__/**/*.test.ts` to the `include` array in `vitest.config.ts`, OR
- Place the test file alongside an existing test file's directory instead

Do not modify `lib/wave-scheduler.ts` or anything on branch `feat/implement-core-wave-scheduler-algorithm`.

### Step 6: Run the tests

```bash
# Try the project's test command
npm test -- --run 2>&1 | head -80
# or
npx vitest run __tests__/inngest-dashboard-integration.test.ts 2>&1 | head -80
# or
npx jest __tests__/inngest-dashboard-integration.test.ts 2>&1 | head -80
```

**If tests fail due to import/module issues:**
- Check exact export names: `grep -r "export.*writeExecutionLog\|export.*INNGEST_FUNCTION_REGISTRY" lib/ --include="*.ts"`
- Check if the route handlers need Next.js test helpers (e.g., `createMocks` from `node-mocks-http`) vs native `Request` objects
- If using Next.js App Router handlers, they accept native `Request` and return native `Response` — the test approach above is correct

**If tests fail because a function/type doesn't exist yet:**
- Check if the feature is partially implemented: `grep -r "inngestStatus\|inngest.status\|InngestFunctionStatus" --include="*.ts" . | grep -v test`
- Stub out missing pieces minimally so the existing tests still pass; do NOT implement missing production features

### Step 7: Type check

```bash
npx tsc --noEmit
```

Fix any TypeScript errors in the test file. Use `as unknown as T` casts sparingly if needed for mock objects that don't perfectly match types.

### Step 8: Full verification

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -20
npm test -- --run 2>&1 | tail -40
```

All 6 test suites should pass. The build must not be broken.

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "test: add E2E integration tests for Inngest dashboard observability"
git push origin feat/inngest-dashboard-integration-test
gh pr create \
  --title "test: Integration test — full dashboard Inngest observability E2E" \
  --body "## Summary

Adds \`__tests__/inngest-dashboard-integration.test.ts\` covering the complete Inngest observability stack:

### Test Coverage
1. **Execution log round-trip** — \`writeExecutionLog\` → \`readExecutionLog\` for success and error states
2. **\`readAllExecutionLogs\`** — 3 of 7 written, 4 null, keyed by functionId
3. **\`INNGEST_FUNCTION_REGISTRY\` completeness** — exactly 7 entries, unique IDs, non-empty required fields
4. **Status API shape** — returns 7 \`InngestFunctionStatus\` objects with correct field types
5. **Trigger API validation** — 400 for unknown functionId, 200 for valid (mocked Inngest send)
6. **Type consistency** — \`InngestFunctionStatus\` structural compatibility

### Notes
- No production code modified
- Mocks \`@vercel/blob\` with in-memory store for test isolation
- Mocks Inngest client \`send\` method for trigger API tests
- No overlap with concurrent branch \`feat/implement-core-wave-scheduler-algorithm\`

Closes: [work item for Inngest observability E2E test]"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/inngest-dashboard-integration-test
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed or was ambiguous]
NEXT STEPS: [what remains — e.g., "readAllExecutionLogs does not exist, needs implementation or test adaptation"]
```

## Escalation Protocol

If you hit an unresolvable blocker (e.g., `InngestFunctionStatus` type doesn't exist in `lib/types.ts`, `INNGEST_FUNCTION_REGISTRY` doesn't exist, execution log functions don't exist, or the test framework is not determinable):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "inngest-dashboard-integration-test",
    "reason": "<describe exactly which symbols are missing or ambiguous>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error or missing symbol description>",
      "filesChanged": ["__tests__/inngest-dashboard-integration.test.ts"]
    }
  }'
```