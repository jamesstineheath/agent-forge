# Agent Forge -- Define shared types and execution log utility

## Metadata
- **Branch:** `feat/inngest-shared-types-and-execution-log`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/types.ts, lib/inngest/execution-log.ts

## Context

Agent Forge is a dev orchestration platform built on Next.js. It coordinates autonomous agent teams via 7 Inngest durable step functions (see `lib/inngest/`). These functions currently lack a unified status tracking mechanism — there's no way to observe at a glance which functions ran recently, whether they succeeded, or how long they took.

This work item lays the foundational layer for Inngest observability: a shared `InngestFunctionStatus` type in `lib/types.ts` and a Blob-backed execution log utility in `lib/inngest/execution-log.ts`. Other work items (dashboard panels, agent health checks, etc.) depend on these types and utilities being in place first.

**Existing patterns to follow:**
- `lib/storage.ts` uses `@vercel/blob` — look at how `put`, `get`, and `del` are called there. The Blob token is `BLOB_READ_WRITE_TOKEN`.
- `lib/types.ts` is the central type registry — all new shared types go here as named exports.
- `lib/inngest/` already contains `client.ts` and the 7 function files. The new `execution-log.ts` should sit alongside them.

**The 7 Inngest functions (from the system map):**

| Function ID | Display Name | Inngest Event Name |
|---|---|---|
| `plan-pipeline` | Plan Pipeline | `agent-forge/plan-pipeline.run` |
| `pipeline-oversight` | Pipeline Oversight | `agent-forge/pipeline-oversight.run` |
| `pm-sweep` | PM Sweep | `agent-forge/pm-sweep.run` |
| `housekeeping` | Housekeeping | `agent-forge/housekeeping.run` |
| `dispatcher-cycle` | Dispatcher Cycle | `agent-forge/dispatcher-cycle.run` |
| `pm-cycle` | PM Cycle | `agent-forge/pm-cycle.run` |
| `health-monitor-cycle` | Health Monitor Cycle | `agent-forge/health-monitor-cycle.run` |

**No conflict risk:** The only concurrent work item touches `lib/pm-agent.ts` and `lib/pm-prompts.ts` — neither of those files is touched here.

## Requirements

1. `InngestFunctionStatus` type is exported from `lib/types.ts` with exactly 4 fields: `functionId: string`, `functionName: string`, `status: 'idle' | 'running' | 'success' | 'error'`, `lastRunAt: string | null`.
2. `InngestExecutionLog` type is exported from `lib/inngest/execution-log.ts` with exactly 6 fields: `functionId: string`, `status: 'running' | 'success' | 'error'`, `startedAt: string`, `completedAt: string | null`, `durationMs: number | null`, `error?: string`.
3. `INNGEST_FUNCTION_REGISTRY` is exported from `lib/inngest/execution-log.ts` as a readonly array of exactly 7 entries, each with `id: string`, `displayName: string`, `eventName: string`.
4. `writeExecutionLog(log: InngestExecutionLog): Promise<void>` writes a JSON blob to `af-data/inngest-status/{functionId}.json` using `@vercel/blob` `put()`, wrapped in try/catch so any Blob failure is silently swallowed (no throw).
5. `readExecutionLog(functionId: string): Promise<InngestExecutionLog | null>` reads from `af-data/inngest-status/{functionId}.json`, returns `null` if not found (catches errors and returns null).
6. `readAllExecutionLogs(): Promise<Record<string, InngestExecutionLog | null>>` reads all 7 registry entries in parallel via `Promise.all` and returns a record keyed by `functionId`.
7. TypeScript compiles without errors (`npx tsc --noEmit`).
8. The build passes (`npm run build`).

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/inngest-shared-types-and-execution-log
```

### Step 1: Inspect existing patterns

Before writing any code, read the following files to understand the exact import paths and Blob usage patterns:

```bash
cat lib/types.ts
cat lib/storage.ts
cat lib/inngest/client.ts
# Spot-check one inngest function to understand naming
cat lib/inngest/dispatcher.ts
```

Note:
- How `@vercel/blob` is imported in `lib/storage.ts` (likely `import { put, get } from '@vercel/blob'` or similar)
- The exact `put()` call signature used (access mode, content type, etc.)
- Whether there's a helper wrapper or if Blob is called directly

### Step 2: Add `InngestFunctionStatus` to `lib/types.ts`

Append the following export to `lib/types.ts`. Place it near other status/state types if any exist, or at the end of the file:

```typescript
export type InngestFunctionStatus = {
  functionId: string;
  functionName: string;
  status: 'idle' | 'running' | 'success' | 'error';
  lastRunAt: string | null;
};
```

Do **not** modify any existing exports — only append.

### Step 3: Create `lib/inngest/execution-log.ts`

Create the file at `lib/inngest/execution-log.ts` with the following content. Adjust the `@vercel/blob` import style to match exactly what `lib/storage.ts` uses:

```typescript
import { put, head } from '@vercel/blob';

// ── Types ────────────────────────────────────────────────────────────────────

export type InngestExecutionLog = {
  functionId: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error?: string;
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const INNGEST_FUNCTION_REGISTRY = [
  {
    id: 'plan-pipeline',
    displayName: 'Plan Pipeline',
    eventName: 'agent-forge/plan-pipeline.run',
  },
  {
    id: 'pipeline-oversight',
    displayName: 'Pipeline Oversight',
    eventName: 'agent-forge/pipeline-oversight.run',
  },
  {
    id: 'pm-sweep',
    displayName: 'PM Sweep',
    eventName: 'agent-forge/pm-sweep.run',
  },
  {
    id: 'housekeeping',
    displayName: 'Housekeeping',
    eventName: 'agent-forge/housekeeping.run',
  },
  {
    id: 'dispatcher-cycle',
    displayName: 'Dispatcher Cycle',
    eventName: 'agent-forge/dispatcher-cycle.run',
  },
  {
    id: 'pm-cycle',
    displayName: 'PM Cycle',
    eventName: 'agent-forge/pm-cycle.run',
  },
  {
    id: 'health-monitor-cycle',
    displayName: 'Health Monitor Cycle',
    eventName: 'agent-forge/health-monitor-cycle.run',
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

const blobKey = (functionId: string) =>
  `af-data/inngest-status/${functionId}.json`;

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Persists an execution log entry to Vercel Blob.
 * Silently swallows errors so Blob failures never break agent runs.
 */
export async function writeExecutionLog(log: InngestExecutionLog): Promise<void> {
  try {
    await put(blobKey(log.functionId), JSON.stringify(log), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
    });
  } catch {
    // intentionally swallowed — Blob failures must not affect agent execution
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Reads a single execution log from Vercel Blob.
 * Returns null if not found or on any read error.
 */
export async function readExecutionLog(
  functionId: string
): Promise<InngestExecutionLog | null> {
  try {
    const response = await fetch(
      `https://blob.vercel-storage.com/${blobKey(functionId)}`
    );
    if (!response.ok) return null;
    const data = await response.json();
    return data as InngestExecutionLog;
  } catch {
    return null;
  }
}

/**
 * Reads all 7 execution logs in parallel.
 * Returns a Record keyed by functionId; missing/errored entries are null.
 */
export async function readAllExecutionLogs(): Promise<
  Record<string, InngestExecutionLog | null>
> {
  const entries = await Promise.all(
    INNGEST_FUNCTION_REGISTRY.map(async (fn) => {
      const log = await readExecutionLog(fn.id);
      return [fn.id, log] as const;
    })
  );
  return Object.fromEntries(entries);
}
```

> **Note on `readExecutionLog`:** Check `lib/storage.ts` for the exact pattern used to read Blob contents. If it uses `fetch` with a direct URL (the typical Vercel Blob public pattern), use that. If it uses a different method (e.g., `getDownloadUrl` or a signed fetch), match that pattern exactly. The `head()` import above is available as a fallback if needed to get the URL. Adjust accordingly.

### Step 4: Verify Blob import compatibility

Cross-check the `@vercel/blob` API used in `lib/storage.ts`:

```bash
grep -n "from '@vercel/blob'" lib/storage.ts
grep -n "put\|get\|head\|list" lib/storage.ts | head -30
```

If `lib/storage.ts` uses a different read pattern (e.g., `list()` + streaming), update `readExecutionLog` in `execution-log.ts` to match. The key invariant is: **always return null on any error**.

Also check if `allowOverwrite` is a valid option in the installed version:

```bash
grep -r "allowOverwrite\|addRandomSuffix" lib/storage.ts node_modules/@vercel/blob/dist/*.d.ts 2>/dev/null | head -10
```

If `allowOverwrite` is not supported, use `addRandomSuffix: false` instead (which has the same effect of writing to a deterministic path).

### Step 5: TypeScript check

```bash
npx tsc --noEmit
```

Fix any type errors before proceeding. Common issues to watch for:
- The `as const` on `INNGEST_FUNCTION_REGISTRY` may require the inferred element type to be widened in the `map()` callback — if TS complains, type the `.map()` parameter explicitly as `{ id: string; displayName: string; eventName: string }`.
- If `@vercel/blob`'s `put()` signature differs from what's written, adjust to match the installed version's types.

### Step 6: Build check

```bash
npm run build
```

Resolve any build errors. The two new/modified files should not introduce any breaking changes since they only add new exports.

### Step 7: Commit, push, open PR

```bash
git add lib/types.ts lib/inngest/execution-log.ts
git commit -m "feat: add InngestFunctionStatus type and execution log utility"
git push origin feat/inngest-shared-types-and-execution-log
gh pr create \
  --title "feat: add InngestFunctionStatus type and execution log utility" \
  --body "## Summary

Adds the foundational types and Blob-backed execution log utility for Inngest observability.

## Changes

### \`lib/types.ts\`
- Added \`InngestFunctionStatus\` type with fields: \`functionId\`, \`functionName\`, \`status\`, \`lastRunAt\`

### \`lib/inngest/execution-log.ts\` (new file)
- \`InngestExecutionLog\` type (6 fields)
- \`INNGEST_FUNCTION_REGISTRY\` — static array of all 7 Inngest functions with id, displayName, eventName
- \`writeExecutionLog()\` — writes to \`af-data/inngest-status/{functionId}.json\`, errors swallowed silently
- \`readExecutionLog()\` — reads single log, returns null on miss/error
- \`readAllExecutionLogs()\` — reads all 7 in parallel via Promise.all, returns Record keyed by functionId

## Acceptance Criteria
- [x] \`InngestFunctionStatus\` exported from \`lib/types.ts\` with 4 required fields
- [x] \`InngestExecutionLog\` exported from \`lib/inngest/execution-log.ts\` with 6 fields
- [x] \`INNGEST_FUNCTION_REGISTRY\` has exactly 7 entries with id, displayName, eventName
- [x] \`writeExecutionLog\` writes to correct Blob path and swallows errors
- [x] \`readAllExecutionLogs\` returns Record keyed by functionId, reads all 7 in parallel

## Notes
- No runtime behavior changed in existing files — only additive changes
- Does not touch \`lib/pm-agent.ts\` or \`lib/pm-prompts.ts\` (concurrent work item safety)
- Blob failures in write path are silently swallowed to protect agent execution continuity"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/inngest-shared-types-and-execution-log
FILES CHANGED: [list of modified files]
SUMMARY: [what was completed]
ISSUES: [what failed or was skipped]
NEXT STEPS: [what remains — e.g., "readExecutionLog needs to be updated to match lib/storage.ts Blob read pattern"]
```

## Escalation

If blocked on an unresolvable issue (e.g., `@vercel/blob` API has changed incompatibly, `lib/types.ts` has a conflicting type definition, or the Blob token scoping prevents public reads):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "define-shared-types-and-execution-log",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message>",
      "filesChanged": ["lib/types.ts", "lib/inngest/execution-log.ts"]
    }
  }'
```