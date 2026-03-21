# Agent Forge -- Expand get_pipeline_health MCP Tool for All 7 Functions

## Metadata
- **Branch:** `feat/expand-get-pipeline-health-mcp-tool`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/mcp/server.ts

## Context

Agent Forge has an MCP (Model Context Protocol) server at `lib/mcp/server.ts` that exposes tools for interacting with the pipeline. One of these tools, `get_pipeline_health`, returns pipeline health information. Currently it only returns status for a subset of Inngest functions.

The system now runs 7 Inngest durable step functions (see CLAUDE.md system map):

| Inngest Function | Cron |
|-----------------|------|
| plan-pipeline | */10 |
| pipeline-oversight | */30 |
| pm-sweep | daily 08:00 UTC |
| housekeeping | */6h |
| dispatcher-cycle | */15 |
| pm-cycle | */30 |
| health-monitor-cycle | */15 |

The execution log infrastructure exists in `lib/inngest/execution-log.ts` and exports `readAllExecutionLogs` and `INNGEST_FUNCTION_REGISTRY`. These need to be surfaced via the MCP tool.

There is concurrent work on `app/agents/page.tsx` (branch `feat/refactor-agents-page-to-render-7-inngest-function-`). This task only touches `lib/mcp/server.ts` — no overlap.

This is a purely additive change. All existing response fields must be preserved.

## Requirements

1. The `get_pipeline_health` tool handler in `lib/mcp/server.ts` must call `readAllExecutionLogs()` from `lib/inngest/execution-log.ts`.
2. The tool response must include a new top-level field `inngestFunctions` containing an array of exactly 7 entries.
3. Each entry must have the shape: `{ functionId: string, functionName: string, status: string, lastRunAt: string | null }`.
4. All existing fields in the `get_pipeline_health` response must be preserved (no breaking changes).
5. Functions with no execution log (no Blob data yet) must return `status: 'idle'` and `lastRunAt: null`.
6. Blob read failures for individual functions must not propagate — the overall tool call must succeed even if some function logs can't be read.
7. TypeScript must compile without errors (`npx tsc --noEmit`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/expand-get-pipeline-health-mcp-tool
```

### Step 1: Inspect existing files

Read the key files to understand current signatures and exports before modifying anything:

```bash
cat lib/mcp/server.ts
cat lib/inngest/execution-log.ts
```

Note the following:
- The exact name and location of the `get_pipeline_health` tool handler in `lib/mcp/server.ts`
- The return type of `readAllExecutionLogs()` — it likely returns a map/array of execution log entries keyed or ordered by function ID
- The fields available on each log entry (especially `functionId`, `functionName`/name, `status`, `lastRunAt`/timestamp)
- The shape of `INNGEST_FUNCTION_REGISTRY` — it likely maps function IDs to metadata including a display name

### Step 2: Understand the execution log return shape

Based on the typical pattern in this codebase, `readAllExecutionLogs()` likely returns something like:

```typescript
// Possible shape — confirm by reading the file
Record<string, ExecutionLog | null>
// or
Array<{ functionId: string; functionName: string; status: string; lastRunAt: string | null } | null>
```

And `INNGEST_FUNCTION_REGISTRY` likely looks like:
```typescript
Record<string, { functionId: string; functionName: string; cron: string; ... }>
```

Adapt the implementation in Step 3 to match the actual types you observe.

### Step 3: Modify `lib/mcp/server.ts`

**3a. Add the import** at the top of the file alongside existing Inngest imports:

```typescript
import { readAllExecutionLogs, INNGEST_FUNCTION_REGISTRY } from '@/lib/inngest/execution-log';
```

(Use the correct relative import path based on how other imports in the file are structured — it may be `'../inngest/execution-log'` if the MCP server uses relative paths.)

**3b. In the `get_pipeline_health` tool handler**, add a resilient call to `readAllExecutionLogs()` and build the `inngestFunctions` array. Insert this logic **before** constructing the return value:

```typescript
// Resilient fetch of all 7 Inngest function execution logs
let inngestFunctions: Array<{
  functionId: string;
  functionName: string;
  status: string;
  lastRunAt: string | null;
}> = [];

try {
  const allLogs = await readAllExecutionLogs();
  
  // Build the array from the registry so all 7 functions are always represented
  inngestFunctions = Object.values(INNGEST_FUNCTION_REGISTRY).map((fn) => {
    // allLogs may be Record<string, log | null> or similar — adapt to actual shape
    const log = allLogs[fn.functionId] ?? null;
    return {
      functionId: fn.functionId,
      functionName: fn.functionName,  // use whatever the actual field name is
      status: log?.status ?? 'idle',
      lastRunAt: log?.lastRunAt ?? null,
    };
  });
} catch (err) {
  // If the entire readAllExecutionLogs call fails, return idle for all functions
  console.error('[MCP] get_pipeline_health: failed to read Inngest execution logs', err);
  inngestFunctions = Object.values(INNGEST_FUNCTION_REGISTRY).map((fn) => ({
    functionId: fn.functionId,
    functionName: fn.functionName,
    status: 'idle',
    lastRunAt: null,
  }));
}
```

> **Important:** If `readAllExecutionLogs()` already handles individual Blob read failures per-function (returning null for failed reads), you only need the outer try/catch. If it throws on partial failures, wrap the `.map()` entries individually as well. Read the implementation to determine which pattern applies.

**3c. Add `inngestFunctions` to the return object.** Find the existing return value of the `get_pipeline_health` handler (it likely builds a JSON string or object). Add the new field **without removing any existing fields**:

```typescript
// Example — merge into whatever the existing return shape is:
return {
  // ... all existing fields preserved exactly as-is ...
  inngestFunctions,
};
```

If the handler returns a serialized JSON string (common in MCP servers), update it like:

```typescript
const existingResult = { /* ... existing build ... */ };
return JSON.stringify({ ...existingResult, inngestFunctions }, null, 2);
```

### Step 4: Handle edge cases explicitly

After implementing Step 3, verify the following cases are handled:

1. **`INNGEST_FUNCTION_REGISTRY` has exactly 7 entries** — if it has more or fewer, the output array will differ from 7. If the registry has fewer than 7, check whether functions are registered elsewhere and add them manually if needed (but prefer fixing the registry).

2. **Field name mismatches** — if `execution-log.ts` uses `name` instead of `functionName`, or `timestamp` instead of `lastRunAt`, adapt the mapping accordingly. Use the actual field names from the type definitions.

3. **`readAllExecutionLogs` is async** — ensure the `get_pipeline_health` handler is `async` (it likely already is if it makes other async calls).

### Step 5: TypeScript verification

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues:
- `readAllExecutionLogs` return type not matching expected indexing pattern → use optional chaining and nullish coalescing
- `INNGEST_FUNCTION_REGISTRY` values not having `functionName` field → check actual field name and update mapping

### Step 6: Build verification

```bash
npm run build
```

Fix any build errors before proceeding.

### Step 7: Smoke test (optional but recommended)

If the repo has a way to invoke MCP tools locally, verify the response shape. Otherwise, inspect the logic manually to confirm:

- The `inngestFunctions` array is present in the return value
- It has 7 entries (one per registry entry)
- Each entry has all 4 required fields

### Step 8: Commit, push, open PR

```bash
git add -A
git commit -m "feat: expand get_pipeline_health MCP tool to include all 7 Inngest functions"
git push origin feat/expand-get-pipeline-health-mcp-tool
gh pr create \
  --title "feat: expand get_pipeline_health MCP tool for all 7 Inngest functions" \
  --body "## Summary

Modifies the \`get_pipeline_health\` MCP tool to return execution status for all 7 Inngest functions.

## Changes

- \`lib/mcp/server.ts\`: Imports \`readAllExecutionLogs\` and \`INNGEST_FUNCTION_REGISTRY\` from \`lib/inngest/execution-log.ts\`. Calls \`readAllExecutionLogs()\` in the tool handler and adds \`inngestFunctions\` array to the response.

## Acceptance Criteria

- [x] \`get_pipeline_health\` response includes \`inngestFunctions\` array with 7 entries
- [x] Each entry has \`functionId\`, \`functionName\`, \`status\`, \`lastRunAt\`
- [x] All existing response fields preserved (additive only)
- [x] Functions with no log show \`status: 'idle'\`, \`lastRunAt: null\`
- [x] Blob read failures for individual functions don't fail the tool call

## Risk

Low — purely additive change to one file. No concurrent file overlap (concurrent work is on \`app/agents/page.tsx\`)."
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/expand-get-pipeline-health-mcp-tool
FILES CHANGED: lib/mcp/server.ts
SUMMARY: [what was done]
ISSUES: [what failed — e.g., "readAllExecutionLogs return type doesn't match expected shape", "INNGEST_FUNCTION_REGISTRY not exported from execution-log.ts"]
NEXT STEPS: [what remains]
```

If `readAllExecutionLogs` or `INNGEST_FUNCTION_REGISTRY` do not exist in `lib/inngest/execution-log.ts`, escalate immediately:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "expand-get-pipeline-health-mcp-tool",
    "reason": "readAllExecutionLogs or INNGEST_FUNCTION_REGISTRY not found in lib/inngest/execution-log.ts — exports do not match work item description",
    "confidenceScore": 0.1,
    "contextSnapshot": {
      "step": "1",
      "error": "Missing expected exports in lib/inngest/execution-log.ts",
      "filesChanged": []
    }
  }'
```