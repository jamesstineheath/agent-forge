# Agent Forge -- Integrate Execution Logging into Agent Inngest Functions

## Metadata
- **Branch:** `feat/inngest-execution-logging`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/inngest/dispatcher.ts, lib/inngest/pm-cycle.ts, lib/inngest/health-monitor.ts

## Context

Agent Forge runs three agent Inngest durable step functions: `dispatcher-cycle`, `pm-cycle`, and `health-monitor-cycle`. These are defined in `lib/inngest/dispatcher.ts`, `lib/inngest/pm-cycle.ts`, and `lib/inngest/health-monitor.ts` respectively.

A utility `writeExecutionLog` already exists at `lib/inngest/execution-log.ts` and must be used to persist execution status (running/success/error) to each function. Log entries must use function IDs that exactly match `INNGEST_FUNCTION_REGISTRY` keys: `dispatcher-cycle`, `pm-cycle`, `health-monitor-cycle`.

All `writeExecutionLog` calls must be wrapped in `try/catch` so that Blob write failures do not interrupt or break actual function execution.

This work adds observability to the three core agent loops without altering their logic.

## Requirements

1. `lib/inngest/dispatcher.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes `status: 'running'` at function start, `status: 'success'` on completion, and `status: 'error'` with error message on failure.
2. `lib/inngest/pm-cycle.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes `status: 'running'` at function start, `status: 'success'` on completion, and `status: 'error'` with error message on failure.
3. `lib/inngest/health-monitor.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes `status: 'running'` at function start, `status: 'success'` on completion, and `status: 'error'` with error message on failure.
4. All `writeExecutionLog` calls are wrapped in individual `try/catch` blocks so Blob failures cannot propagate and break function execution.
5. The `functionId` argument passed to `writeExecutionLog` matches exactly: `dispatcher-cycle`, `pm-cycle`, or `health-monitor-cycle` as appropriate.
6. `startedAt` is recorded as `new Date().toISOString()` at the beginning of each function body (before any step logic).
7. `durationMs` is computed as `Date.now() - startTime` where `startTime = Date.now()` is captured at the beginning of the function body.
8. TypeScript compiles without errors after changes (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/inngest-execution-logging
```

### Step 1: Inspect execution-log.ts to understand the API

Read `lib/inngest/execution-log.ts` in full to understand the exact signature of `writeExecutionLog`, its parameter types, and any exported constants (especially `INNGEST_FUNCTION_REGISTRY`).

```bash
cat lib/inngest/execution-log.ts
```

Note the exact TypeScript types for the log entry object (fields like `functionId`, `status`, `startedAt`, `completedAt`, `durationMs`, `error`, etc.). The implementation in the next steps must match these types exactly.

### Step 2: Inspect the three Inngest function files

Read each file to understand the current top-level structure — specifically where the Inngest function handler body begins and ends, and how errors are currently surfaced.

```bash
cat lib/inngest/dispatcher.ts
cat lib/inngest/pm-cycle.ts
cat lib/inngest/health-monitor.ts
```

Look for:
- The `createFunction` or `inngest.createFunction` call and its handler signature (typically `async ({ event, step }) => { ... }`)
- Any existing `try/catch` at the top level of the handler
- The outermost `return` statement or completion point

### Step 3: Patch lib/inngest/dispatcher.ts

Add execution logging to the dispatcher cycle function. The pattern to apply:

```typescript
import { writeExecutionLog } from './execution-log';

// Inside the handler function body (before any step.* calls):
const startTime = Date.now();
const startedAt = new Date().toISOString();
try {
  await writeExecutionLog({
    functionId: 'dispatcher-cycle',
    status: 'running',
    startedAt,
  });
} catch (_logErr) {
  // non-fatal
}

// ... existing step logic unchanged ...

// At the successful completion point (after all step logic):
try {
  await writeExecutionLog({
    functionId: 'dispatcher-cycle',
    status: 'success',
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
  });
} catch (_logErr) {
  // non-fatal
}
```

If the existing handler already has a top-level `try/catch`, add the error log in the `catch` block:

```typescript
} catch (err) {
  try {
    await writeExecutionLog({
      functionId: 'dispatcher-cycle',
      status: 'error',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (_logErr) {
    // non-fatal
  }
  throw err; // re-throw so Inngest marks the function as failed
}
```

If there is no top-level `try/catch`, wrap the entire existing step logic in one:

```typescript
const startTime = Date.now();
const startedAt = new Date().toISOString();
try {
  await writeExecutionLog({ functionId: 'dispatcher-cycle', status: 'running', startedAt });
} catch (_e) {}

try {
  // --- existing step logic goes here, untouched ---

  try {
    await writeExecutionLog({
      functionId: 'dispatcher-cycle',
      status: 'success',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
    });
  } catch (_e) {}
} catch (err) {
  try {
    await writeExecutionLog({
      functionId: 'dispatcher-cycle',
      status: 'error',
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch (_e) {}
  throw err;
}
```

> **Important:** Do not modify any existing `step.run(...)`, `step.sleep(...)`, or other Inngest step calls. Only add the logging wrappers around the existing logic.

### Step 4: Patch lib/inngest/pm-cycle.ts

Apply the identical pattern from Step 3 to `lib/inngest/pm-cycle.ts`, using `functionId: 'pm-cycle'`.

### Step 5: Patch lib/inngest/health-monitor.ts

Apply the identical pattern from Step 3 to `lib/inngest/health-monitor.ts`, using `functionId: 'health-monitor-cycle'`.

### Step 6: Verify TypeScript compiles cleanly

```bash
npx tsc --noEmit
```

If there are type errors on the `writeExecutionLog` call arguments:
- Re-read `lib/inngest/execution-log.ts` to confirm the exact field names and types.
- Adjust the log entry object to match — do not cast with `as any` unless the type definition itself uses `any`.

Common issues:
- `error` field may be typed as `string | undefined` — ensure you only set it when there is an error.
- `completedAt` may not be in the `'running'` status variant if the type uses a discriminated union.
- `durationMs` may similarly only apply to terminal statuses.

### Step 7: Run build

```bash
npm run build
```

Fix any build errors. Do not suppress errors with `// @ts-ignore` unless the type definition in `execution-log.ts` itself is unsound.

### Step 8: Verify no test regressions

```bash
npm test 2>/dev/null || echo "No test suite configured"
```

### Step 9: Commit, push, open PR

```bash
git add lib/inngest/dispatcher.ts lib/inngest/pm-cycle.ts lib/inngest/health-monitor.ts
git commit -m "feat: integrate execution logging into dispatcher, pm-cycle, and health-monitor Inngest functions"
git push origin feat/inngest-execution-logging
gh pr create \
  --title "feat: integrate execution logging into agent Inngest functions" \
  --body "## Summary

Adds execution log persistence (running/success/error) to the three agent Inngest functions:
- \`dispatcher-cycle\` (lib/inngest/dispatcher.ts)
- \`pm-cycle\` (lib/inngest/pm-cycle.ts)
- \`health-monitor-cycle\` (lib/inngest/health-monitor.ts)

Each function now calls \`writeExecutionLog\` at start (status: running), on success (status: success, durationMs), and on error (status: error, error message). All log calls are wrapped in try/catch so Blob failures cannot break function execution.

## Acceptance Criteria
- [x] dispatcher.ts writes running/success/error log entries with functionId: dispatcher-cycle
- [x] pm-cycle.ts writes running/success/error log entries with functionId: pm-cycle
- [x] health-monitor.ts writes running/success/error log entries with functionId: health-monitor-cycle
- [x] All writeExecutionLog calls wrapped in try/catch
- [x] Function IDs match INNGEST_FUNCTION_REGISTRY exactly
- [x] TypeScript compiles without errors
"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/inngest-execution-logging
FILES CHANGED: [list of modified files]
SUMMARY: [what was done]
ISSUES: [what failed or is unresolved]
NEXT STEPS: [what remains — e.g. "pm-cycle.ts and health-monitor.ts not yet patched"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve autonomously (e.g. `writeExecutionLog` does not exist at `lib/inngest/execution-log.ts`, its type signature is incompatible with the described pattern, or architectural questions arise), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "inngest-execution-logging",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/inngest/dispatcher.ts", "lib/inngest/pm-cycle.ts", "lib/inngest/health-monitor.ts"]
    }
  }'
```