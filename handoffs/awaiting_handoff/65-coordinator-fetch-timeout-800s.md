# Handoff #65 — Coordinator Fetch Timeout Must Be 800s

**Branch:** `fix/coordinator-fetch-timeout-800s`
**Max Budget:** $2
**Model:** Sonnet
**Execution mode:** Autonomous

## Problem

Handoff #64 (PR #402) bumped the coordinator's fetch timeout for decomposition, but not far enough. Before PR #402 it was 300s. Now it's ~340s (decomposition failed at 339993ms this cycle). It needs to be 800s to match the phase route's maxDuration.

Evidence from Supervisor phase log (2026-03-21T01:30 UTC cycle):
```
Phase decomposition: failure (339993ms)
Error: "fetch failed"
```

This is the coordinator's AbortController or setTimeout aborting the fetch to the decomposition phase route. The phase route itself has maxDuration=800 (confirmed in PR #399). The coordinator fetch timeout must match.

## Execution Steps

### Step 0 — Branch and verify

```bash
git checkout main && git pull
git checkout -b fix/coordinator-fetch-timeout-800s
```

### Step 1 — Find and fix the timeout

Look in the Supervisor coordinator code (likely `app/api/agents/supervisor/cron/route.ts` or a nearby coordinator file). Find every AbortController timeout, setTimeout, or phase timeout config that controls how long the coordinator waits for a phase route response.

For the decomposition phase specifically, the timeout MUST be 800000ms (800 seconds). Search for the value that PR #402 set (likely around 340000 or 345000) and change it to 800000.

If there's a phase timeout map/manifest, set decomposition and architecture-planning to 800000ms. Other critical-tier phases can use 120000ms. Standard and housekeeping phases can use 60000ms.

Also check pm-sweep: it timed out at 115003ms this cycle. If pm-sweep has a 115s timeout in the manifest, bump it to 120s.

### Step 2 — Verify

```bash
npx tsc --noEmit
```

### Step 3 — Commit and push

```bash
git add -A
git commit -m "fix: set coordinator fetch timeout to 800s for decomposition phase"
git push origin fix/coordinator-fetch-timeout-800s
gh pr create --title "fix: coordinator decomposition fetch timeout to 800s" --body "PR #402 bumped the timeout but not enough (340s). Decomposition needs 800s to match phase route maxDuration. Also bumps pm-sweep timeout."
```

## Post-Merge Updates

Bring STATUS.md back to planning surface.
