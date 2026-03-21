# Agent Forge -- Add SWR hooks for inngest status and trigger

## Metadata
- **Branch:** `feat/add-swr-hooks-inngest-status-trigger`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** low
- **Estimated files:** lib/hooks.ts

## Context

Agent Forge uses SWR-based data fetching hooks centralized in `lib/hooks.ts`. A recent PR added the `GET /api/agents/inngest-status` route (see merged PR "feat: create inngest-status API route"), and concurrent work item "Create inngest-trigger API route" is adding `POST /api/agents/inngest-trigger` on branch `feat/create-inngest-trigger-api-route`.

This task adds two new hooks to `lib/hooks.ts`:
1. `useInngestStatus()` — polls the status endpoint every 30s
2. `useTriggerInngestFunction()` — fires the trigger endpoint and revalidates status

`InngestFunctionStatus` type lives in `lib/types.ts` (added as part of the inngest-status API work). The existing hooks in `lib/hooks.ts` follow a consistent pattern using `useSWR` with typed return shapes — match that style exactly.

**No files overlap with concurrent work** (`app/api/agents/inngest-trigger/route.ts` is untouched here).

## Requirements

1. `useInngestStatus()` fetches `GET /api/agents/inngest-status` via SWR
2. Returns `{ statuses: InngestFunctionStatus[], isLoading: boolean, error: any, mutate: KeyedMutator }`
3. Configured with `refreshInterval: 30000` and `revalidateOnFocus: true`
4. `useTriggerInngestFunction()` returns `{ trigger: (functionId: string) => Promise<void>, triggeringId: string | null }`
5. `trigger()` POSTs to `/api/agents/inngest-trigger` with `{ functionId }` in the body
6. `triggeringId` is set to `functionId` at the start of the request and cleared (set to `null`) after
7. After the POST completes, immediately calls `mutate()` on the status hook to revalidate
8. After a 3-second delay, calls `mutate()` again to pick up the `running` status
9. `InngestFunctionStatus` is imported from `lib/types.ts`
10. Hooks follow the existing patterns in `lib/hooks.ts`

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/add-swr-hooks-inngest-status-trigger
```

### Step 1: Inspect existing hook patterns and types

Before writing any code, read the existing files to understand the exact patterns in use:

```bash
cat lib/hooks.ts
grep -n "InngestFunctionStatus" lib/types.ts
```

Look for:
- How `useSWR` is imported and called
- How return shapes are typed (inline vs interface)
- Whether `KeyedMutator` is imported from `swr` directly
- How `isLoading` is derived (SWR v2 provides it natively; older versions derive it from `!data && !error`)
- Whether `useState` is already imported from React in the file

### Step 2: Add `InngestFunctionStatus` to `lib/types.ts` if missing

If `InngestFunctionStatus` does not already exist in `lib/types.ts`, add it. Check the inngest-status API route for the shape it returns:

```bash
cat app/api/agents/inngest-status/route.ts 2>/dev/null || echo "FILE NOT FOUND"
```

If the type is missing from `lib/types.ts`, add it near the other agent/inngest types:

```typescript
export interface InngestFunctionStatus {
  functionId: string;
  name: string;
  status: 'idle' | 'running' | 'failed' | 'completed';
  lastRun?: string;       // ISO timestamp
  nextRun?: string;       // ISO timestamp (cron functions)
  runCount?: number;
}
```

Adjust the shape to match whatever the API route actually returns. If the type already exists, skip this step.

### Step 3: Add the two hooks to `lib/hooks.ts`

Open `lib/hooks.ts` and append the following two hooks after the last existing hook. Adapt imports as needed — do not duplicate existing imports.

**Additions to the imports section** (merge with whatever is already there):
```typescript
import { useState } from 'react';
import { KeyedMutator } from 'swr';
import { InngestFunctionStatus } from './types';
```

**Hook implementations** to append at the end of the file:

```typescript
// ── Inngest Status ────────────────────────────────────────────────────────────

export function useInngestStatus(): {
  statuses: InngestFunctionStatus[];
  isLoading: boolean;
  error: any;
  mutate: KeyedMutator<{ statuses: InngestFunctionStatus[] }>;
} {
  const { data, error, isLoading, mutate } = useSWR<{ statuses: InngestFunctionStatus[] }>(
    '/api/agents/inngest-status',
    {
      refreshInterval: 30000,
      revalidateOnFocus: true,
    }
  );

  return {
    statuses: data?.statuses ?? [],
    isLoading,
    error,
    mutate,
  };
}

// ── Inngest Trigger ───────────────────────────────────────────────────────────

export function useTriggerInngestFunction(): {
  trigger: (functionId: string) => Promise<void>;
  triggeringId: string | null;
} {
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const { mutate } = useInngestStatus();

  const trigger = async (functionId: string): Promise<void> => {
    setTriggeringId(functionId);
    try {
      await fetch('/api/agents/inngest-trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ functionId }),
      });
      // Immediate revalidation
      await mutate();
      // Delayed revalidation to pick up 'running' status
      setTimeout(async () => {
        await mutate();
      }, 3000);
    } finally {
      setTriggeringId(null);
    }
  };

  return { trigger, triggeringId };
}
```

**Important notes for the executor:**
- If SWR version is v1 (no native `isLoading`), derive it: `isLoading: !data && !error`
- If `useSWR` in the file is called with a fetcher function rather than relying on a global fetcher, match that pattern (e.g., `useSWR('/api/...', fetcher, { ... })`)
- If `useState` is already imported, do not add a duplicate import
- If `KeyedMutator` is already imported, do not add a duplicate import
- Check that `useSWR` global fetcher is configured (look for `SWRConfig` in the app or a `fetcher` export in `lib/hooks.ts`); if a fetcher arg is required, pass it explicitly

### Step 4: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Resolve any type errors. Common issues:
- `isLoading` not available in SWR v1 → use `!data && !error`
- `InngestFunctionStatus` shape mismatch → update the interface to match the API response
- `KeyedMutator` generic arg mismatch → adjust to match the `useSWR` response type

### Step 5: Verify build

```bash
npm run build
```

Fix any build errors before proceeding.

### Step 6: Run tests

```bash
npm test 2>/dev/null || echo "No test suite configured"
```

### Step 7: Commit, push, open PR

```bash
git add lib/hooks.ts lib/types.ts
git commit -m "feat: add SWR hooks for inngest status and trigger"
git push origin feat/add-swr-hooks-inngest-status-trigger
gh pr create \
  --title "feat: add SWR hooks for inngest status and trigger" \
  --body "## Summary

Adds two SWR-based data fetching hooks to \`lib/hooks.ts\`:

### \`useInngestStatus()\`
- Fetches \`GET /api/agents/inngest-status\`
- Returns \`{ statuses, isLoading, error, mutate }\`
- Auto-refreshes every 30s (\`refreshInterval: 30000\`)
- Revalidates on window focus

### \`useTriggerInngestFunction()\`
- Returns \`{ trigger, triggeringId }\`
- \`trigger(functionId)\` POSTs to \`/api/agents/inngest-trigger\`
- Sets \`triggeringId\` during the request (cleared in finally block)
- Revalidates status immediately after POST, then again after 3s delay

## Files Changed
- \`lib/hooks.ts\` — two new exported hooks
- \`lib/types.ts\` — \`InngestFunctionStatus\` interface (if not already present)

## Notes
- No overlap with concurrent work item \`feat/create-inngest-trigger-api-route\`
- Follows existing SWR hook patterns in the file"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/add-swr-hooks-inngest-status-trigger
FILES CHANGED: [list]
SUMMARY: [what was done]
ISSUES: [what failed]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If blocked by an unresolvable issue (e.g., `InngestFunctionStatus` type doesn't exist and the inngest-status API route isn't merged yet, SWR version incompatibility requiring architectural decisions, or type errors that can't be resolved without changes to concurrent work):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "add-swr-hooks-inngest-status-trigger",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/hooks.ts", "lib/types.ts"]
    }
  }'
```