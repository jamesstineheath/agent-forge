# Agent Forge -- Integrate Execution Logging into Supervisor-Family Inngest Functions

## Metadata
- **Branch:** `feat/supervisor-inngest-execution-logging`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/inngest/plan-pipeline.ts, lib/inngest/pipeline-oversight.ts, lib/inngest/pm-sweep.ts, lib/inngest/housekeeping.ts

## Context

Agent Forge has 7 Inngest durable step functions. Four of them are the "supervisor family": `plan-pipeline`, `pipeline-oversight`, `pm-sweep`, and `housekeeping`. These were migrated from Vercel cron to Inngest step functions (ADR-010, PR #415) to eliminate timeout compounding.

An execution logging module already exists at `lib/inngest/execution-log.ts` and exports a `writeExecutionLog` function. The other three Inngest functions (`dispatcher`, `pm-cycle`, `health-monitor`) already use this pattern. The supervisor-family functions need to be updated to match.

The `INNGEST_FUNCTION_REGISTRY` maps function IDs to metadata. The function IDs used in `writeExecutionLog` calls **must** match exactly: `'plan-pipeline'`, `'pipeline-oversight'`, `'pm-sweep'`, `'housekeeping'`.

The pattern is:
1. Record `startedAt` at function entry
2. Wrap the body in try/catch
3. On success: call `writeExecutionLog` with `status: 'success'`, `completedAt`, and `durationMs`
4. On error: call `writeExecutionLog` with `status: 'error'` and the error message
5. Each `writeExecutionLog` call is itself wrapped in try/catch so a Blob failure never propagates

Before implementing, read the existing `lib/inngest/execution-log.ts` to understand the exact signature of `writeExecutionLog`, and read one of the already-instrumented functions (e.g., `lib/inngest/dispatcher.ts`) to see the exact pattern in use.

## Requirements

1. `lib/inngest/plan-pipeline.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes a log entry with `status: 'running'` and `startedAt` at function start, and `status: 'success'` with `completedAt` and `durationMs` on completion, or `status: 'error'` with error message on failure
2. `lib/inngest/pipeline-oversight.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes a log entry with `status: 'running'` and `startedAt` at function start, and `status: 'success'` with `completedAt` and `durationMs` on completion, or `status: 'error'` with error message on failure
3. `lib/inngest/pm-sweep.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes a log entry with `status: 'running'` and `startedAt` at function start, and `status: 'success'` with `completedAt` and `durationMs` on completion, or `status: 'error'` with error message on failure
4. `lib/inngest/housekeeping.ts` imports `writeExecutionLog` from `lib/inngest/execution-log.ts` and writes a log entry with `status: 'running'` and `startedAt` at function start, and `status: 'success'` with `completedAt` and `durationMs` on completion, or `status: 'error'` with error message on failure
5. Every `writeExecutionLog` call in all four files is wrapped in its own `try/catch` block so that a Blob write failure never causes the Inngest function to throw or retry due to logging
6. The function ID strings passed to `writeExecutionLog` match exactly: `'plan-pipeline'`, `'pipeline-oversight'`, `'pm-sweep'`, `'housekeeping'`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/supervisor-inngest-execution-logging
```

### Step 1: Read existing patterns

Before making any changes, read the reference files to understand the exact API and pattern:

```bash
cat lib/inngest/execution-log.ts
cat lib/inngest/dispatcher.ts
```

Note the exact signature of `writeExecutionLog` (parameter names, types, required fields). Note exactly how the already-instrumented functions structure their try/catch and where they call `writeExecutionLog`. This is the pattern you must replicate.

### Step 2: Read all four target files

```bash
cat lib/inngest/plan-pipeline.ts
cat lib/inngest/pipeline-oversight.ts
cat lib/inngest/pm-sweep.ts
cat lib/inngest/housekeeping.ts
```

Understand the current structure of each function — where the top-level `handler` function body starts, what the outermost step is, and where the function returns.

### Step 3: Instrument `lib/inngest/plan-pipeline.ts`

Following the pattern from Step 1:

1. Add `import { writeExecutionLog } from './execution-log';` to the imports (if not already present)
2. At the start of the handler body (before any steps), capture the start time:
   ```ts
   const startedAt = new Date().toISOString();
   const startMs = Date.now();
   ```
3. Write the running log entry immediately after (in its own try/catch):
   ```ts
   try {
     await writeExecutionLog({ functionId: 'plan-pipeline', status: 'running', startedAt });
   } catch (e) {
     console.error('[plan-pipeline] Failed to write running log:', e);
   }
   ```
4. Wrap the existing function body in a try/catch:
   - On success, before returning, write:
     ```ts
     try {
       await writeExecutionLog({
         functionId: 'plan-pipeline',
         status: 'success',
         startedAt,
         completedAt: new Date().toISOString(),
         durationMs: Date.now() - startMs,
       });
     } catch (e) {
       console.error('[plan-pipeline] Failed to write success log:', e);
     }
     ```
   - In the catch block, write:
     ```ts
     try {
       await writeExecutionLog({
         functionId: 'plan-pipeline',
         status: 'error',
         startedAt,
         completedAt: new Date().toISOString(),
         durationMs: Date.now() - startMs,
         error: e instanceof Error ? e.message : String(e),
       });
     } catch (logErr) {
       console.error('[plan-pipeline] Failed to write error log:', logErr);
     }
     throw e; // re-throw so Inngest sees the failure
     ```

**Important:** If the function uses Inngest steps (`step.run(...)`) internally, the try/catch must wrap the step calls at the handler level, not inside individual steps. Match whatever structure the already-instrumented `dispatcher.ts` uses.

### Step 4: Instrument `lib/inngest/pipeline-oversight.ts`

Apply the same pattern as Step 3, but with `functionId: 'pipeline-oversight'` and console error prefix `[pipeline-oversight]`.

### Step 5: Instrument `lib/inngest/pm-sweep.ts`

Apply the same pattern as Step 3, but with `functionId: 'pm-sweep'` and console error prefix `[pm-sweep]`.

### Step 6: Instrument `lib/inngest/housekeeping.ts`

Apply the same pattern as Step 3, but with `functionId: 'housekeeping'` and console error prefix `[housekeeping]`.

### Step 7: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues:
- The `error` field may need to be typed differently — check `execution-log.ts` for the accepted fields
- If `writeExecutionLog` signature differs from what's shown above, adapt to match the actual signature

### Step 8: Build check

```bash
npm run build
```

Resolve any build errors. Do not proceed with a broken build.

### Step 9: Quick sanity check — grep for pattern consistency

```bash
grep -n "writeExecutionLog" lib/inngest/plan-pipeline.ts lib/inngest/pipeline-oversight.ts lib/inngest/pm-sweep.ts lib/inngest/housekeeping.ts
```

Verify each file has at least 3 calls (running, success, error). Also verify the function ID strings are exact:

```bash
grep -n "'plan-pipeline'\|'pipeline-oversight'\|'pm-sweep'\|'housekeeping'" lib/inngest/plan-pipeline.ts lib/inngest/pipeline-oversight.ts lib/inngest/pm-sweep.ts lib/inngest/housekeeping.ts
```

### Step 10: Commit, push, open PR

```bash
git add lib/inngest/plan-pipeline.ts lib/inngest/pipeline-oversight.ts lib/inngest/pm-sweep.ts lib/inngest/housekeeping.ts
git commit -m "feat: integrate execution logging into supervisor-family Inngest functions

Add writeExecutionLog calls to plan-pipeline, pipeline-oversight, pm-sweep,
and housekeeping Inngest functions. Each function writes running status at
start, success with durationMs on completion, and error with message on
failure. All log calls are try/catch wrapped so Blob failures never break
agent execution."
git push origin feat/supervisor-inngest-execution-logging
gh pr create \
  --title "feat: integrate execution logging into supervisor-family Inngest functions" \
  --body "## Summary

Adds execution log persistence to the 4 supervisor-family Inngest functions, matching the pattern already used by dispatcher, pm-cycle, and health-monitor.

## Changes

- \`lib/inngest/plan-pipeline.ts\`: writes running/success/error execution logs
- \`lib/inngest/pipeline-oversight.ts\`: writes running/success/error execution logs
- \`lib/inngest/pm-sweep.ts\`: writes running/success/error execution logs
- \`lib/inngest/housekeeping.ts\`: writes running/success/error execution logs

## Pattern

Each function:
1. Captures \`startedAt\` and \`startMs\` at handler entry
2. Writes \`status: 'running'\` log (try/catch)
3. Wraps body in try/catch
4. On success: writes \`status: 'success'\` with \`completedAt\` and \`durationMs\` (try/catch)
5. On error: writes \`status: 'error'\` with error message (try/catch), then re-throws

All \`writeExecutionLog\` calls are wrapped in try/catch so Blob failures never cause function retries.

## Acceptance Criteria
- [x] plan-pipeline.ts writes running at start, success/error at completion
- [x] pipeline-oversight.ts writes running at start, success/error at completion
- [x] pm-sweep.ts writes running at start, success/error at completion
- [x] housekeeping.ts writes running at start, success/error at completion
- [x] All writeExecutionLog calls wrapped in try/catch"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles:
   ```bash
   git add -A
   git commit -m "feat: partial execution logging integration (see PR for status)"
   git push origin feat/supervisor-inngest-execution-logging
   ```
2. Open the PR with partial status:
   ```bash
   gh pr create --title "feat: integrate execution logging into supervisor-family Inngest functions [PARTIAL]" --body "Partial implementation — see ISSUES below."
   ```
3. If blocked by ambiguous `writeExecutionLog` signature or unexpected file structure, escalate:
   ```bash
   curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
     -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
     -H "Content-Type: application/json" \
     -d '{
       "workItemId": "supervisor-inngest-execution-logging",
       "reason": "<concise description of the blocker>",
       "confidenceScore": 0.3,
       "contextSnapshot": {
         "step": "<current step number>",
         "error": "<error message or blocker description>",
         "filesChanged": ["lib/inngest/plan-pipeline.ts", "lib/inngest/pipeline-oversight.ts", "lib/inngest/pm-sweep.ts", "lib/inngest/housekeeping.ts"]
       }
     }'
   ```
4. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/supervisor-inngest-execution-logging
FILES CHANGED: [list of files actually modified]
SUMMARY: [what was done]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "pm-sweep.ts and housekeeping.ts not yet instrumented"]
```