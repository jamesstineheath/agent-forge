# Agent Forge -- Integrate Spend Monitor into Supervisor Agent

## Metadata
- **Branch:** `feat/supervisor-spend-monitor`
- **Priority:** high
- **Model:** sonnet
- **Type:** feature
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** lib/atc/supervisor.ts, app/api/agents/supervisor/cron/route.ts, lib/escalation.ts, lib/vercel-spend-monitor.ts

## Context

Agent Forge has a Supervisor agent (`lib/atc/supervisor.ts`) that runs on a 10-minute cron cycle and monitors agent health, manages escalations, and performs maintenance tasks. A Vercel spend monitoring library was recently added (`lib/vercel-spend-monitor.ts`) that provides `getSpendStatus()`, `checkSpendThresholds()`, and `persistSpendStatus()` functions.

This task integrates spend monitoring into the Supervisor's cron cycle as a new §5 section. When spend thresholds are crossed, the Supervisor should create escalations via `lib/escalation.ts` and send emails via `lib/gmail.ts`, then persist the alert state to prevent duplicate notifications.

The escalation system in `lib/escalation.ts` uses a union type or enum for escalation types. We need to add `'spend-alert'` to that type if it doesn't already exist.

Key existing patterns from the codebase:
- The Supervisor agent follows a numbered section structure (§1, §2, §3, §4...)
- Escalations are created using functions from `lib/escalation.ts`
- Emails are sent via `lib/gmail.ts`
- The cron route at `app/api/agents/supervisor/cron/route.ts` calls the supervisor's main cycle function

## Requirements

1. `lib/escalation.ts` must include `'spend-alert'` in whatever union type or enum governs escalation types
2. `lib/atc/supervisor.ts` must import `getSpendStatus`, `checkSpendThresholds`, and `persistSpendStatus` from `lib/vercel-spend-monitor.ts`
3. A new §5 — Spend Monitoring section must be added to the Supervisor's cycle that calls these functions in order
4. For each newly crossed threshold returned by `checkSpendThresholds()`, an escalation must be created via `lib/escalation.ts` with type `'spend-alert'`
5. An email must be sent via `lib/gmail.ts` for each newly crossed threshold escalation
6. `persistSpendStatus()` must be called after processing all thresholds to prevent duplicate alerts
7. The spend monitoring step must be included in the cron execution flow in `app/api/agents/supervisor/cron/route.ts`
8. The project must compile with no TypeScript errors (`npx tsc --noEmit`)

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b feat/supervisor-spend-monitor
```

### Step 1: Read existing files to understand current structure

Read the full contents of each relevant file before making changes:

```bash
cat lib/vercel-spend-monitor.ts
cat lib/escalation.ts
cat lib/atc/supervisor.ts
cat app/api/agents/supervisor/cron/route.ts
cat lib/gmail.ts
```

Take note of:
- The exact function signatures exported from `lib/vercel-spend-monitor.ts` (especially what `checkSpendThresholds()` returns — the shape of threshold crossing objects)
- The exact union type or enum name for escalation types in `lib/escalation.ts`
- The structure of escalation creation functions (e.g., `createEscalation()` signature)
- How the Supervisor's cycle is structured and what sections already exist
- The email-sending function signature in `lib/gmail.ts`

### Step 2: Add `'spend-alert'` to escalation types in `lib/escalation.ts`

Find the union type or enum that governs escalation types. It likely looks something like:

```typescript
export type EscalationType = 'agent-stall' | 'merge-conflict' | 'ci-failure' | ...
```

Add `'spend-alert'` to it:

```typescript
export type EscalationType = 'agent-stall' | 'merge-conflict' | 'ci-failure' | ... | 'spend-alert'
```

If it's an enum, add a `SpendAlert = 'spend-alert'` member.

### Step 3: Add §5 — Spend Monitoring to `lib/atc/supervisor.ts`

At the top of the file, add the import for spend monitoring functions:

```typescript
import { getSpendStatus, checkSpendThresholds, persistSpendStatus } from '../vercel-spend-monitor';
```

Add a new `runSpendMonitoring` function (or equivalent, matching the file's naming conventions) and call it from the main supervisor cycle. The section should follow this logic:

```typescript
// §5 — Spend Monitoring
async function runSpendMonitoringSection(ctx: CycleContext): Promise<void> {
  ctx.log('§5 — Spend Monitoring: start');
  try {
    // Get current spend status (includes which alerts have already been sent)
    const spendStatus = await getSpendStatus();

    // Check which thresholds are newly crossed
    const newlyCrossed = await checkSpendThresholds(spendStatus);

    if (newlyCrossed.length === 0) {
      ctx.log('§5 — Spend Monitoring: no new thresholds crossed');
    } else {
      ctx.log(`§5 — Spend Monitoring: ${newlyCrossed.length} new threshold(s) crossed`);

      for (const threshold of newlyCrossed) {
        // Create an escalation for each crossed threshold
        await createEscalation({
          type: 'spend-alert',
          reason: `Vercel spend threshold crossed: ${threshold.label ?? threshold.level} — $${threshold.currentSpend} / $${threshold.thresholdAmount}`,
          // include any other required fields based on createEscalation's actual signature
        });

        // Send an email notification
        await sendEscalationEmail({
          subject: `[Agent Forge] Vercel Spend Alert: ${threshold.label ?? threshold.level}`,
          body: `A Vercel spend threshold has been crossed.\n\nThreshold: ${threshold.label ?? threshold.level}\nCurrent spend: $${threshold.currentSpend}\nThreshold: $${threshold.thresholdAmount}\n\nPlease review your Vercel usage.`,
        });
      }

      // Persist updated status to prevent duplicate alerts on subsequent runs
      await persistSpendStatus(spendStatus, newlyCrossed);
    }

    ctx.log('§5 — Spend Monitoring: complete');
  } catch (err) {
    ctx.log(`§5 — Spend Monitoring: error — ${err instanceof Error ? err.message : String(err)}`);
    // Non-fatal: log and continue
  }
}
```

**Important:** Adapt the field names and function call signatures based on what you actually see in the source files (Step 1). The above is a template — use the real types and signatures.

Call this function from the main supervisor cycle function, after existing sections:

```typescript
await runSpendMonitoringSection(ctx);
```

### Step 4: Update `app/api/agents/supervisor/cron/route.ts`

Read the file. If the cron route simply calls a single top-level `runSupervisorCycle()` or equivalent function, and that function already contains all sections, no change may be needed here — the §5 addition in Step 3 will be picked up automatically.

If the cron route explicitly lists steps or calls sub-functions individually, add the spend monitoring step in the appropriate location (after existing sections):

```typescript
// Already existing pattern — adapt to match
await runSpendMonitoring(ctx); // or however it's structured
```

If the file already handles everything via the supervisor's main exported function, verify it's being called and leave it as-is (noting this in the commit message).

### Step 5: Verify TypeScript compilation

```bash
npx tsc --noEmit
```

Fix any type errors. Common issues to watch for:
- `'spend-alert'` not assignable to escalation type (fixed in Step 2)
- Wrong field names on threshold crossing objects (use actual types from `lib/vercel-spend-monitor.ts`)
- Missing required fields in `createEscalation()` call
- Wrong argument count for `persistSpendStatus()`

### Step 6: Run build

```bash
npm run build
```

Resolve any build errors before proceeding.

### Step 7: Commit, push, open PR

```bash
git add -A
git commit -m "feat: integrate spend monitor into Supervisor agent (§5)"
git push origin feat/supervisor-spend-monitor
gh pr create \
  --title "feat: integrate spend monitor into Supervisor agent" \
  --body "## Summary

Adds §5 — Spend Monitoring to the Supervisor agent's cron cycle.

## Changes
- \`lib/escalation.ts\`: Added \`'spend-alert'\` to escalation type union
- \`lib/atc/supervisor.ts\`: Added §5 spend monitoring section that calls \`getSpendStatus()\`, \`checkSpendThresholds()\`, creates escalations, sends emails, and calls \`persistSpendStatus()\`
- \`app/api/agents/supervisor/cron/route.ts\`: Verified spend monitoring step is included in cron execution flow

## Behavior
- On each Supervisor cron run, spend thresholds are checked
- Newly crossed thresholds trigger escalation creation and email notification via existing \`lib/escalation.ts\` and \`lib/gmail.ts\` systems
- \`persistSpendStatus()\` is called after processing to prevent duplicate alerts
- Spend monitoring errors are caught and logged non-fatally so they don't disrupt other Supervisor sections

## Testing
- TypeScript compiles with no errors (\`npx tsc --noEmit\`)
- Build succeeds (\`npm run build\`)

Closes: Integrate Spend Monitor into Supervisor agent work item"
```

## Session Abort Protocol

If running low on context or hitting unresolvable errors:

1. Commit and push whatever compiles
2. Open the PR with partial status
3. Output structured report:

```
STATUS: [PR Open | Failed | Blocked]
PR: [URL or "none"]
BRANCH: feat/supervisor-spend-monitor
FILES CHANGED: [list files actually modified]
SUMMARY: [what was completed]
ISSUES: [what failed or is unresolved]
NEXT STEPS: [what remains — e.g., "persistSpendStatus() signature mismatch needs resolution", "email function signature unclear"]
```

## Escalation Protocol

If you encounter a blocker you cannot resolve (e.g., `checkSpendThresholds()` or `persistSpendStatus()` have signatures incompatible with the described behavior, the escalation system requires fields not inferrable from the codebase, or `lib/gmail.ts` has no suitable send function):

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "supervisor-spend-monitor",
    "reason": "<describe the specific incompatibility or missing information>",
    "confidenceScore": 0.3,
    "contextSnapshot": {
      "step": "<current step>",
      "error": "<error or ambiguity description>",
      "filesChanged": ["lib/escalation.ts", "lib/atc/supervisor.ts"]
    }
  }'
```