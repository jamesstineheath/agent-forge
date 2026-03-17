# Agent Forge -- A7: PM Agent ATC Sweep (Section 14)

## Metadata
- **Branch:** `feat/a7-pm-agent-atc-sweep`
- **Priority:** medium
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc.ts

## Context

Agent Forge has a PM Agent (`lib/pm-agent.ts`) with three core functions: `reviewBacklog`, `assessProjectHealth`, and `composeDigest`. These were implemented in previous work items (A3, A4). The ATC (Air Traffic Controller) in `lib/atc.ts` runs on a Vercel cron schedule and processes work items through sections (currently up to §13b). This task adds a new §14 that runs the PM Agent daily sweep at the end of each ATC cycle.

The sweep must:
1. Check a last-run timestamp in Vercel Blob (`af-data/pm-agent/last-sweep.json`) to avoid running more than once per ~20 hours
2. Call `reviewBacklog()`, `assessProjectHealth()`, and `composeDigest()` in sequence
3. Log results at each step
4. Persist the updated timestamp after successful completion
5. Never throw — sweep failures must not break the core ATC loop

The existing `storage` object from `lib/storage.ts` is already imported in `lib/atc.ts` and has `get` and `put` methods.

## Requirements

1. Add a `runPMAgentSweep()` async function to `lib/atc.ts` implementing the daily sweep logic exactly as specified
2. Import `reviewBacklog`, `assessProjectHealth`, and `composeDigest` from `./pm-agent` at the top of `lib/atc.ts`
3. The sweep checks `af-data/pm-agent/last-sweep.json` via `storage.get()` and skips if last run was less than 20 hours ago
4. The sweep calls `reviewBacklog()`, `assessProjectHealth()`, and `composeDigest()` with the specified options
5. After successful completion, persist `{ timestamp: new Date().toISOString() }` to `af-data/pm-agent/last-sweep.json` via `storage.put()`
6. `runPMAgentSweep()` is called at the end of the main ATC cycle function, wrapped in try/catch
7. All console.log/error messages follow the `[ATC §14]` prefix pattern
8. `npm run build` succeeds with no TypeScript errors

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/a7-pm-agent-atc-sweep
```

### Step 1: Inspect lib/atc.ts and lib/pm-agent.ts

Read the current state of both files to understand:
- Existing imports at the top of `lib/atc.ts`
- The main ATC cycle function name and structure (where §13a/§13b end)
- The exact signatures of `reviewBacklog`, `assessProjectHealth`, and `composeDigest` in `lib/pm-agent.ts`
- How `storage.get()` and `storage.put()` are currently used in `lib/atc.ts`

```bash
cat lib/atc.ts
cat lib/pm-agent.ts
```

### Step 2: Add PM Agent imports to lib/atc.ts

At the top of `lib/atc.ts`, add an import for the three PM Agent functions alongside the existing imports. The import should be added near the other `lib/` imports:

```typescript
import { reviewBacklog, assessProjectHealth, composeDigest } from './pm-agent';
```

Make sure this does not duplicate any existing import from `./pm-agent`.

### Step 3: Add the runPMAgentSweep function to lib/atc.ts

Add the following function before the main ATC cycle function (or as a private helper at the end of the file, before the main export). Use the exact logic from the description:

```typescript
// § 14 — PM Agent Daily Sweep
// Only runs once per day (check last run timestamp in Vercel Blob)
async function runPMAgentSweep() {
  const SWEEP_KEY = 'af-data/pm-agent/last-sweep.json';
  const lastSweep = await storage.get(SWEEP_KEY);

  if (lastSweep) {
    const lastRun = new Date(JSON.parse(lastSweep).timestamp);
    const hoursSinceLastRun = (Date.now() - lastRun.getTime()) / (1000 * 60 * 60);
    if (hoursSinceLastRun < 20) {
      console.log(`[ATC §14] PM Agent sweep: skipped (last run ${hoursSinceLastRun.toFixed(1)}h ago)`);
      return;
    }
  }

  console.log('[ATC §14] PM Agent sweep: starting');

  try {
    // Run backlog review
    const review = await reviewBacklog();
    console.log(`[ATC §14] Backlog review complete: ${review.recommendations.length} recommendations`);

    // Run health assessment for all projects
    const healths = await assessProjectHealth();
    const atRisk = healths.filter(h => h.status === 'at-risk' || h.status === 'stalling' || h.status === 'blocked');
    console.log(`[ATC §14] Health assessment: ${healths.length} projects, ${atRisk.length} at risk`);

    // Compose and send digest
    await composeDigest({
      includeHealth: true,
      includeBacklog: true,
      includeRecommendations: true,
      recipientEmail: 'james.stine.heath@gmail.com',
    });
    console.log('[ATC §14] Digest sent');

    // Record sweep timestamp
    await storage.put(SWEEP_KEY, JSON.stringify({ timestamp: new Date().toISOString() }));
  } catch (error) {
    console.error('[ATC §14] PM Agent sweep failed:', error);
    // Don't throw — sweep failure shouldn't break the ATC cycle
  }
}
```

**Note:** The description had a template literal bug — `'last run ${hoursSinceLastRun.toFixed(1)}h ago'` used single quotes instead of backticks. Use backticks (template literal) as shown above.

### Step 4: Call runPMAgentSweep at the end of the main ATC cycle

Locate the main ATC cycle function (likely named `runATC`, `atcCycle`, or similar — confirm by reading the file in Step 1). At the very end of that function, after all existing sections (§13a, §13b, etc.), add:

```typescript
  // § 14 — PM Agent Daily Sweep
  try {
    await runPMAgentSweep();
  } catch (error) {
    console.error('[ATC §14] Unexpected error in PM Agent sweep:', error);
  }
```

The inner `runPMAgentSweep` already has its own try/catch, but this outer wrapper provides a final safety net so a bug in `runPMAgentSweep` itself cannot crash the ATC cycle.

### Step 5: Adapt to actual pm-agent.ts signatures

After reading `lib/pm-agent.ts` in Step 1, verify the actual return types and parameter shapes:

- **`reviewBacklog()`**: Confirm the return type has a `.recommendations` array. If the property name differs (e.g. `.items`), adjust the log line accordingly.
- **`assessProjectHealth()`**: Confirm it returns an array and each element has a `.status` field with values `'at-risk'`, `'stalling'`, `'blocked'` (or similar). Adjust the `.filter()` predicate if needed.
- **`composeDigest(options)`**: Confirm it accepts `{ includeHealth, includeBacklog, includeRecommendations, recipientEmail }`. If the signature differs, adapt the call.

If any function signature differs substantially, use the actual signature from `lib/pm-agent.ts` and adjust the log messages to match available data.

### Step 6: Verification

```bash
npx tsc --noEmit
npm run build
```

Fix any TypeScript errors. Common issues to watch for:
- `storage.get()` may return `string | null` — the `if (lastSweep)` null check handles this correctly
- Return type mismatches from pm-agent functions — adjust destructuring/property access as needed
- Missing return type annotation on `runPMAgentSweep` — TypeScript should infer `Promise<void>` but add it explicitly if there's an error

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: add ATC section 14 PM Agent daily sweep"
git push origin feat/a7-pm-agent-atc-sweep
gh pr create \
  --title "feat: A7 PM Agent ATC Sweep (Section 14)" \
  --body "## Summary

Adds Section 14 to the ATC cycle that runs the PM Agent daily sweep.

## Changes
- \`lib/atc.ts\`: Added \`runPMAgentSweep()\` helper function implementing §14
- \`lib/atc.ts\`: Imported \`reviewBacklog\`, \`assessProjectHealth\`, \`composeDigest\` from \`./pm-agent\`
- \`lib/atc.ts\`: Called \`runPMAgentSweep()\` at the end of the main ATC cycle wrapped in try/catch

## Behavior
- Checks \`af-data/pm-agent/last-sweep.json\` in Vercel Blob for last run timestamp
- Skips if last run was < 20 hours ago (approximately daily cadence)
- Runs backlog review, health assessment, and digest composition in sequence
- Persists updated timestamp after successful run
- All failures are caught and logged — never breaks the ATC cycle

## Acceptance Criteria
- [x] Section 14 added to lib/atc.ts
- [x] Skips if run < 20 hours ago
- [x] Wrapped in try/catch — failures don't break ATC
- [x] Timestamp persisted to af-data/pm-agent/last-sweep.json
- [x] \`npm run build\` passes"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:
1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/a7-pm-agent-atc-sweep
FILES CHANGED: [lib/atc.ts]
SUMMARY: [what was done]
ISSUES: [what failed or blocked]
NEXT STEPS: [what remains]
```

## Escalation Protocol

If blocked on unresolvable issues (e.g., `reviewBacklog`/`assessProjectHealth`/`composeDigest` don't exist in `lib/pm-agent.ts`, `storage.get`/`storage.put` API differs substantially from expected, or TypeScript errors that cannot be resolved):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "a7-pm-agent-atc-sweep",
    "reason": "<concise description of the blocker>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step number>",
      "error": "<error message or blocker description>",
      "filesChanged": ["lib/atc.ts"]
    }
  }'
```