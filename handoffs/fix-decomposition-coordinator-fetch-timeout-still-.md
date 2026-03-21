<!-- source: direct -->
<!-- triggeredBy: unknown -->
<!-- budget: 1 -->

# Agent Forge -- Fix Decomposition Coordinator Fetch Timeout

## Metadata
- **Branch:** `fix/decomposition-coordinator-timeout`
- **Priority:** high
- **Model:** sonnet
- **Type:** fix
- **Max Budget:** $5
- **Risk Level:** medium
- **Estimated files:** `app/api/agents/supervisor/cron/route.ts`, `lib/atc/supervisor.ts`, `app/api/agents/project-manager/cron/route.ts`, `lib/pm-agent.ts`, `lib/orchestrator.ts`, `lib/decomposer.ts`

## Context

The Supervisor decomposition phase consistently fails at exactly 340,002ms with "fetch failed". Two prior PRs (#402 and #404) attempted fixes:
- PR #402: bumped undici headersTimeout
- PR #404: set coordinator fetch timeout to 800s

Neither fix changed behavior. The 340s ceiling (~300s + 40s overhead) strongly suggests the **Supervisor cron route's own `maxDuration`** is capping the total cycle time, starving decomposition before its 800s timeout can fire. Additionally, `pm-sweep` times out at 120,002ms every cycle, suggesting a similar pattern.

This is the critical path blocker for all pipeline automation since Session 62.

The fix requires:
1. Identifying all timeout sources in the supervisor → coordinator → decomposition call chain
2. Ensuring the Supervisor cron's `maxDuration` is high enough to accommodate decomposition (800s) plus other phases
3. Ensuring `pm-sweep` has sufficient timeout headroom
4. Verifying PR #404's timeout change actually applies to the executed code path

## Requirements

1. Read all relevant source files before making any changes to understand the actual code structure
2. Identify the Supervisor cron route's `maxDuration` config and raise it to accommodate 800s decomposition + overhead (target: 800s or Vercel Pro Fluid max)
3. Confirm PR #404's coordinator fetch timeout change applies to the correct call site — if there are multiple fetch call sites in the coordinator, fix all of them
4. Fix pm-sweep timeout: identify the constraint enforcing 120s and raise it appropriately
5. Do not introduce any TypeScript errors
6. The fix should be minimal and surgical — change only timeout/maxDuration values and ensure they are consistently applied

## Execution Steps

### Step 0: Branch setup
```bash
git checkout main && git pull
git checkout -b fix/decomposition-coordinator-timeout
```

### Step 1: Read and understand the Supervisor cron route

```bash
# Find the Supervisor cron route file
find . -path "*/supervisor/cron/route.ts" -not -path "*/node_modules/*"
cat app/api/agents/supervisor/cron/route.ts
```

Look for:
- `export const maxDuration` — this is the Vercel function time limit. If it's 300, 360, or similar, this is the culprit
- Any `AbortController` / `signal` passed to `fetch()`
- Any `setTimeout` wrapping the decomposition phase call
- The function that triggers decomposition (likely a call to an internal route or coordinator function)

### Step 2: Read the coordinator and decomposition call sites

```bash
# Find where decomposition is triggered from the supervisor
grep -rn "decompos" app/api/agents/supervisor/ lib/ --include="*.ts" | grep -v node_modules | grep -v ".next"

# Find the coordinator fetch
grep -rn "coordinator" app/api/agents/supervisor/ lib/ --include="*.ts" | grep -v node_modules | grep -v ".next"

# Find all fetch() calls in supervisor-related code
grep -rn "fetch(" app/api/agents/supervisor/ lib/atc/ --include="*.ts" | grep -v node_modules
```

Read all files identified. Pay attention to:
- Any `AbortController` with a timeout
- Any `signal` passed to `fetch()`
- The `maxDuration` export at the top of each route file

### Step 3: Read pm-sweep related code

```bash
# Find pm-sweep references
grep -rn "pm.sweep\|pmSweep\|pm_sweep" app/ lib/ --include="*.ts" | grep -v node_modules | grep -v ".next"

# Check PM agent cron route
cat app/api/agents/project-manager/cron/route.ts
```

Look for the same pattern: `maxDuration`, `AbortController`, explicit timeout values around 120s.

### Step 4: Read the Vercel config to understand maxDuration constraints

```bash
cat vercel.json 2>/dev/null || echo "no vercel.json"
cat next.config.ts 2>/dev/null || cat next.config.js 2>/dev/null || echo "no next.config"

# Check if maxDuration is set per-route
grep -rn "maxDuration" app/api/agents/ --include="*.ts" | grep -v node_modules
```

On Vercel Pro with Fluid Compute, `maxDuration` can be up to 800s. Document what each cron route currently has.

### Step 5: Apply the fixes

Based on findings from Steps 1–4, apply the following fixes:

**Fix A: Supervisor cron maxDuration**

In `app/api/agents/supervisor/cron/route.ts`, ensure:
```typescript
export const maxDuration = 800; // Vercel Pro Fluid Compute ceiling
```

If it's currently set to 300 or 360, this is the primary culprit — the Supervisor cycle was being killed at ~300s (with ~40s of overhead explaining 340s).

**Fix B: Decomposition fetch timeout consistency**

Find the coordinator fetch call site(s). If PR #404 set the timeout on one call site but there are multiple, fix all of them. Look for patterns like:

```typescript
// If the fetch uses AbortController, ensure the timeout matches:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 800_000); // 800s
const response = await fetch(url, { signal: controller.signal });
clearTimeout(timeout);
```

Or if using a utility, trace through to ensure the 800s value flows through correctly.

**Fix C: pm-sweep timeout**

Find the constraint causing pm-sweep to die at 120s. Common patterns:
- A hardcoded `120000` or `120_000` timeout value
- A `maxDuration = 120` on the PM cron route
- A shared timeout utility with a default of 120s

Fix by raising to an appropriate value (e.g., 300s for pm-sweep if it doesn't need 800s).

**Fix D: Shared timeout utilities**

```bash
# Check lib/atc/utils.ts for timeout wrappers
cat lib/atc/utils.ts
grep -rn "timeoutWrapper\|withTimeout\|120\|300\|340" lib/atc/ --include="*.ts"
```

If there's a `withTimeout` or similar utility being called for these phases, ensure the timeout values passed to it are consistent with the route's `maxDuration`.

### Step 6: Verify TypeScript compiles

```bash
npx tsc --noEmit
```

Fix any TypeScript errors before proceeding.

### Step 7: Sanity check the changes

```bash
git diff
```

Review the diff. Confirm:
- `maxDuration` on supervisor cron is raised (800 or appropriate value)
- No new timeouts were introduced at lower values
- pm-sweep timeout is raised
- All fetch call sites in the decomposition coordinator path have consistent timeouts
- Changes are minimal and surgical

### Step 8: Build check

```bash
npm run build 2>&1 | tail -30
```

If build fails, fix errors before committing.

### Step 9: Commit, push, open PR

```bash
git add -A
git commit -m "fix: raise supervisor maxDuration and decomposition timeout sources

- Raise supervisor cron maxDuration to 800s (was 300/360, causing 340s cutoff)
- Ensure decomposition coordinator fetch timeout consistently set to 800s
- Fix pm-sweep timeout constraint (was 120s ceiling)
- All fetch call sites in decomposition path now have matching timeout values

Decomposition has been broken since Session 62. Root cause: supervisor's own
maxDuration was killing the cycle before the coordinator fetch timeout could fire.
PR #402 and #404 fixed the wrong layer.

Fixes: decomposition failure at 340,002ms, pm-sweep timeout at 120,002ms"

git push origin fix/decomposition-coordinator-timeout

gh pr create \
  --title "fix: decomposition coordinator fetch timeout (340s ceiling) and pm-sweep 120s timeout" \
  --body "## Problem

Supervisor decomposition phase fails at exactly 340,002ms. pm-sweep times out at 120,002ms. PRs #402 and #404 attempted fixes at the wrong layer.

## Root Cause

The Supervisor cron route's own \`maxDuration\` was the binding constraint — shorter than the 800s coordinator fetch timeout set by PR #404. The cycle was killed at ~300-340s before the inner timeout could matter.

## Fix

- Raised Supervisor cron \`maxDuration\` to 800s
- Ensured all decomposition coordinator fetch call sites use 800s timeout
- Raised pm-sweep timeout constraint to allow completion

## Verification

Trigger the Supervisor manually via \`get_pipeline_health\` MCP tool. Decomposition phase should either succeed or fail with a non-timeout error. pm-sweep should complete without timeout.

## Files Changed

$(git diff --name-only HEAD~1 2>/dev/null || echo 'See diff')
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
BRANCH: fix/decomposition-coordinator-timeout
FILES CHANGED: [list files actually modified]
SUMMARY: [what was changed]
ISSUES: [what failed or was unclear]
NEXT STEPS: [what investigation or changes remain]
```

## Escalation Protocol

If the timeout source cannot be identified after reading all relevant files (e.g., it's coming from Vercel infrastructure config, a middleware layer not in the codebase, or the changes don't match expectations), escalate:

```bash
curl -X POST "${AGENT_FORGE_URL}/api/escalations" \
  -H "Authorization: Bearer ${AGENT_FORGE_API_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{
    "workItemId": "fix-decomposition-coordinator-timeout",
    "reason": "Cannot identify timeout source: maxDuration already set correctly, fetch timeouts already set to 800s, but 340s cutoff persists. May be Vercel infrastructure layer or undici transport config not exposed in source.",
    "confidenceScore": 0.2,
    "contextSnapshot": {
      "step": "Step 4-5",
      "error": "Timeout source not in application code",
      "filesChanged": []
    }
  }'
```