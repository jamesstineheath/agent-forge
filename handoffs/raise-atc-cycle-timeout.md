# Handoff: Raise ATC cycle timeout and set explicit maxDuration

**Priority:** P2
**Max Budget:** $2
**Branch:** fix/atc-cycle-timeout-duration

## Problem

The ATC cron route runs on Vercel with Fluid Compute enabled (Hobby plan, 300s default). But `CYCLE_TIMEOUT_MS` is set to 55s based on a wrong assumption of a 60s Vercel kill. The cycle is artificially cut short, potentially aborting useful work (dispatch, reconciliation, branch cleanup) that could complete within the available 300s window.

## Pre-flight Self-check

- [ ] Read `lib/atc.ts` — confirm `CYCLE_TIMEOUT_MS` exists and its current value
- [ ] Read `app/api/atc/cron/route.ts` — confirm no `maxDuration` export exists
- [ ] Run `npx tsc --noEmit` to verify clean baseline

## Step 0: Branch + Commit Setup

```
git checkout main && git pull origin main
git checkout -b fix/atc-cycle-timeout-duration
```

## Step 1: Update CYCLE_TIMEOUT_MS in lib/atc.ts

Find:
```typescript
const CYCLE_TIMEOUT_MS = 55 * 1000; // 55s — abort before Vercel's 60s kill
```

Replace with:
```typescript
const CYCLE_TIMEOUT_MS = 240 * 1000; // 240s — abort before Vercel's 300s Fluid Compute limit
```

## Step 2: Add maxDuration export to cron route

In `app/api/atc/cron/route.ts`, add this export at the top level (after imports, before the handler function):

```typescript
export const maxDuration = 300; // Vercel Fluid Compute: 300s max for Hobby plan
```

## Step 3: Verification

- `npx tsc --noEmit` must pass
- `npm run build` must succeed
- Grep for `CYCLE_TIMEOUT_MS` — should show `240 * 1000`
- Grep for `maxDuration` — should show `300` in the cron route

## Abort Protocol

If `CYCLE_TIMEOUT_MS` or `CycleTimeoutError` don't exist in `lib/atc.ts`, stop and report — the lock hardening PR may not have merged yet.

## Acceptance Criteria

1. `CYCLE_TIMEOUT_MS = 240 * 1000` in lib/atc.ts
2. `export const maxDuration = 300` in app/api/atc/cron/route.ts
3. TypeScript and build pass
